"""Inversion store on Azure Cosmos DB for Apache Gremlin.

Graph model (every vertex has ``pk`` = run id, so a run is one logical partition):

* ``well|<name>`` -has_run-> ``run|<run>`` -has_station-> ``station|<run>|<md:.2f>`` (tvd_ft, inc_deg)
* ``run`` -has_channel-> ``channel|<run>|<label>`` (group, kind, measurement, unit)
* ``station`` -observed {channel, value, updated_at}-> ``channel``: the measured value, stored once per station
* ``inv|<fingerprint>`` (request, plan, meta, version, ...) -on_run-> run, -used {weight}-> channel,
  -has_layer {index}-> ``layer|<fingerprint>|<i>``, -fit {i, md_ft, data}-> station, -supersedes-> older inversion

``data`` on a fit edge is compact JSON with the station's ``obs``/``pred`` per channel and ``boundary_tvd`` per
boundary, so a read rebuilds ``service.serialize``'s output exactly. Gremlin properties must be primitives, and ``label``/``id`` are reserved (a ``label`` property renames the element label on Cosmos).

Rules: Gremlin **string scripts with bindings only** (Cosmos has no bytecode; values are never formatted into
the script text, so there is no Gremlin injection). No multi-item transactions, so the inversion vertex is
created with ``complete=false`` and flipped to ``true`` after every edge is written; readers ignore incomplete
inversions. 429/449/408 responses are retried after ``x-ms-retry-after-ms``. Station writes use 4 workers.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import logging
import threading
import time

from backend.inversion.cosmos_config import CosmosSettings
from backend.inversion.store import station_key, summary_of

log = logging.getLogger("resist.store.cosmos")

WORKERS = 4
MAX_RETRIES = 8
RETRY_STATUS = {429, 449, 408}
PER_STATION = ("md_ft", "tvd_ft", "inclination_deg")
_CACHE_MAX = 64


def _dumps(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, allow_nan=False)


def _status_of(exc) -> tuple[int | None, float]:
    """(Cosmos status code, retry-after seconds) of a GremlinServerError, else (None, 0)."""
    attrs = getattr(exc, "status_attributes", None) or {}
    code = attrs.get("x-ms-status-code")
    try:
        code = int(code) if code is not None else getattr(exc, "status_code", None)
    except (TypeError, ValueError):
        code = None
    try:
        wait = float(attrs.get("x-ms-retry-after-ms") or 0) / 1000.0
    except (TypeError, ValueError):
        wait = 0.0
    return code, wait


def _first(v):
    return v[0] if isinstance(v, list) and len(v) == 1 else v


def _id_part(text: str) -> str:
    """Cosmos ids must not contain / \\ ? # (well names do, e.g. ``2/4-VC-2 Y3H``)."""
    return str(text).translate({ord(c): "_" for c in "/\\?#"})


class CosmosStore:
    kind = "cosmos"

    def __init__(self, settings: CosmosSettings, client_factory=None):
        if not settings.endpoint or not settings.key:
            raise ValueError("Cosmos endpoint and key are required")
        self._settings = settings
        self._factory = client_factory or self._default_client
        self._client = self._factory()
        self._client_lock = threading.Lock()
        self._cache: dict[str, dict] = {}
        self._cache_lock = threading.Lock()

    def _default_client(self):
        from gremlin_python.driver import client, serializer
        s = self._settings
        return client.Client(s.endpoint, "g", username=s.username, password=s.key, pool_size=WORKERS,
                             message_serializer=serializer.GraphSONSerializersV2d0())

    def close(self):
        try:
            self._client.close()
        except Exception:
            pass

    # --- transport ----------------------------------------------------------------------------------------

    def query(self, script: str, bindings: dict | None = None) -> list:
        """Run one script with bindings; retry throttling, reconnect once on a dropped socket."""
        from gremlin_python.driver.protocol import GremlinServerError
        reconnected = False
        for attempt in range(MAX_RETRIES + 1):
            try:
                return self._client.submit(script, bindings or {}).all().result()
            except GremlinServerError as exc:
                code, wait = _status_of(exc)
                if code in RETRY_STATUS and attempt < MAX_RETRIES:
                    time.sleep(max(wait, 0.05 * (2 ** attempt)))
                    continue
                raise
            except (OSError, RuntimeError, ConnectionError) as exc:
                if reconnected:
                    raise
                reconnected = True
                log.info("Gremlin connection lost (%s); reconnecting", type(exc).__name__)
                with self._client_lock:
                    self.close()
                    self._client = self._factory()
        raise RuntimeError("unreachable")

    def ping(self):
        self.query("g.V(vid).has('pk', pk).count()", {"vid": "ping", "pk": "ping"})

    # --- writes -------------------------------------------------------------------------------------------

    def _upsert_vertex(self, label: str, vid: str, pk: str, props: dict):
        script = "g.V(vid).has('pk', pk).fold().coalesce(unfold(), addV(lbl).property('id', vid).property('pk', pk))"
        b = {"vid": vid, "pk": pk, "lbl": label}
        for n, (k, v) in enumerate(props.items()):
            if v is None:
                continue
            script += f".property(k{n}, v{n})"
            b[f"k{n}"], b[f"v{n}"] = k, v
        self.query(script, b)

    def _upsert_edge(self, label: str, eid: str, src: str, dst: str, pk: str, props: dict | None = None):
        script = ("g.V(dst).has('pk', pk).coalesce(inE(lbl).hasId(eid), "
                  "addE(lbl).from(g.V(src).has('pk', pk)).property('id', eid).property('pk', pk))")
        b = {"dst": dst, "src": src, "pk": pk, "lbl": label, "eid": eid}
        for n, (k, v) in enumerate((props or {}).items()):
            script += f".property(k{n}, v{n})"
            b[f"k{n}"], b[f"v{n}"] = k, v
        self.query(script, b)

    def _existing_observed(self, pk: str, md_lo: float, md_hi: float) -> dict[str, float]:
        rows = self.query("g.V().has('pk', pk).hasLabel('station').has('md_ft', between(lo, hi))"
                          ".outE('observed').project('id', 'v').by(id).by('value')",
                          {"pk": pk, "lo": md_lo - 0.01, "hi": md_hi + 0.01})
        return {r["id"]: r["v"] for r in rows}

    def _station_script(self, i, rec, vid, pk, existing, now) -> tuple[str, dict, int]:
        result = rec["result"]
        md, tvd, inc = (result[k][i] for k in PER_STATION)
        sid = f"station|{pk}|{station_key(md)}"
        b = {"sid": sid, "pk": pk, "run": rec["run"], "md": round(float(md), 2), "vid": vid, "i": i,
             "mdx": md, "data": "", "now": now}
        script = ("g.V(sid).has('pk', pk).fold().coalesce(unfold(), addV('station').property('id', sid)"
                  ".property('pk', pk).property('run', run).property('md_ft', md))")
        if tvd is not None:
            script += ".property('tvd_ft', tvd)"
            b["tvd"] = tvd
        if inc is not None:
            script += ".property('inc_deg', inc)"
            b["inc"] = inc
        obs, pred = {}, {}
        changed = 0
        for n, c in enumerate(result["curves"]):
            o, p = c["obs"][i], c["pred"][i]
            obs[c["label"]], pred[c["label"]] = o, p
            if o is None:
                continue
            eid = f"obs|{pk}|{station_key(md)}|{c['label']}"
            old = existing.get(eid)
            if old is not None and abs(float(old) - float(o)) <= 1e-9 * max(1.0, abs(float(o))):
                continue                                   # shared observation already stored
            stamp = ""
            if old is not None:
                changed += 1
                stamp = ".property('updated_at', now)"
            script += (f".sideEffect(coalesce(outE('observed').hasId(e{n}), addE('observed').to(g.V(c{n}).has('pk', pk))"
                       f".property('id', e{n}).property('pk', pk).property('channel', l{n})).property('value', o{n}){stamp})")
            b.update({f"e{n}": eid, f"c{n}": f"channel|{pk}|{c['label']}", f"l{n}": c["label"], f"o{n}": o})
        bt = [row[i] for row in result["model"]["boundary_tvd_ft"]]
        b["data"] = _dumps({"md": md, "tvd": tvd, "inc": inc, "obs": obs, "pred": pred, "b": bt})
        script += (".sideEffect(addE('fit').from(g.V(vid).has('pk', pk)).property('pk', pk).property('i', i)"
                   ".property('md_ft', mdx).property('data', data))")
        return script, b, changed

    def save(self, record: dict) -> dict:
        rec = record
        pk, fp = rec["run"], rec["fingerprint"]
        vid = f"inv|{fp}"
        result = rec["result"]
        self.delete(fp, run=pk)                            # same fingerprint: replace (force / repair / import)

        well = str(result.get("well") or "unknown")
        wid = f"well|{_id_part(well)}"
        self._upsert_vertex("well", wid, pk, {"name": well})
        self._upsert_vertex("run", f"run|{pk}", pk, {"run": pk})
        self._upsert_edge("has_run", f"has_run|{pk}", wid, f"run|{pk}", pk)
        for c in result["curves"]:
            cid = f"channel|{pk}|{c['label']}"
            self._upsert_vertex("channel", cid, pk, {"channel": c["label"], "group": c["group"], "kind": c["kind"],
                                                      "measurement": c["measurement"], "unit": c["unit"]})
            self._upsert_edge("has_channel", f"has_channel|{pk}|{c['label']}", f"run|{pk}", cid, pk)

        meta = {k: v for k, v in result.items() if k not in PER_STATION and k not in ("curves", "model")}
        meta["curves"] = [{k: v for k, v in c.items() if k not in ("obs", "pred")} for c in result["curves"]]
        meta["model"] = {k: v for k, v in result["model"].items() if k != "boundary_tvd_ft"}
        summary = summary_of(rec)
        props = {"fingerprint": fp, "job_id": rec["job_id"], "run": pk, "version": rec["version"],
                 "request_key": rec["request_key"], "request": _dumps(rec["request"]), "plan": _dumps(rec["plan"]),
                 "meta": _dumps(meta), "created": rec.get("created"), "started": rec.get("started"),
                 "finished": rec.get("finished"), "stations": summary["stations"] or 0,
                 "boundaries": summary["boundaries"], "supersedes": _dumps(rec.get("supersedes", [])),
                 "superseded": bool(rec.get("superseded", False)), "complete": False}
        self._upsert_vertex("inversion", vid, pk, props)
        self._upsert_edge("on_run", f"on_run|{fp}", vid, f"run|{pk}", pk)
        for c in result["curves"]:
            if c["used"]:
                self._upsert_edge("used", f"used|{fp}|{c['label']}", vid, f"channel|{pk}|{c['label']}", pk,
                                  {"weight": c["weight"]})
        for k, layer in enumerate(result["model"]["layers"]):
            lid = f"layer|{fp}|{k}"
            self._upsert_vertex("layer", lid, pk, {"index": k, **layer})
            self._upsert_edge("has_layer", f"has_layer|{fp}|{k}", vid, lid, pk, {"index": k})

        n = len(result["md_ft"])
        mds = [m for m in result["md_ft"] if m is not None]
        existing = self._existing_observed(pk, min(mds), max(mds)) if mds else {}
        now = time.time()
        scripts = [self._station_script(i, rec, vid, pk, existing, now) for i in range(n)]
        # Each station's script creates its station vertex, so stations must exist before their run edge.
        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(lambda sb: self.query(sb[0], sb[1]), scripts))
            list(pool.map(lambda m: self._upsert_edge("has_station", f"has_station|{pk}|{station_key(m)}",
                                                      f"run|{pk}", f"station|{pk}|{station_key(m)}", pk), mds))
        for old in rec.get("supersedes", []):
            self._upsert_edge("supersedes", f"supersedes|{fp}|{old}", vid, f"inv|{old}", pk)
            self.query("g.V(vid).has('pk', pk).property('superseded', true)", {"vid": f"inv|{old}", "pk": pk})
            self._forget(old)
        self.query("g.V(vid).has('pk', pk).property('complete', true)", {"vid": vid, "pk": pk})
        self._forget(fp)
        return {"observed_updated": sum(c for _, _, c in scripts)}

    def delete(self, fingerprint: str, run: str | None = None) -> None:
        vid = f"inv|{fingerprint}"
        if run is None:
            runs = self.query("g.V(vid).values('run')", {"vid": vid})
            if not runs:
                return
            run = runs[0]
        self.query("g.V(vid).has('pk', pk).out('has_layer').drop()", {"vid": vid, "pk": run})
        self.query("g.V(vid).has('pk', pk).drop()", {"vid": vid, "pk": run})
        self._forget(fingerprint)

    def drop_partition(self, pk: str) -> None:
        """Remove every vertex (and edge) of one partition; used by the integration tests (``test|`` runs)."""
        self.query("g.V().has('pk', pk).drop()", {"pk": pk})

    # --- reads --------------------------------------------------------------------------------------------

    def _forget(self, fingerprint):
        with self._cache_lock:
            self._cache.pop(fingerprint, None)

    def _vertex_record(self, vm: dict) -> dict:
        v = {k: _first(x) for k, x in vm.items()}
        return {"fingerprint": v["fingerprint"], "job_id": v["job_id"], "run": v["run"], "version": v["version"],
                "request_key": v["request_key"], "request": json.loads(v["request"]),
                "plan": json.loads(v["plan"]) if "plan" in v else None,
                "created": v.get("created"), "started": v.get("started"), "finished": v.get("finished"),
                "supersedes": json.loads(v.get("supersedes") or "[]"), "superseded": bool(v.get("superseded")),
                "complete": bool(v.get("complete")),
                "summary": {"stations": v.get("stations"), "boundaries": v.get("boundaries")},
                "_meta": v.get("meta")}

    def _load(self, vid: str, pk: str | None) -> dict | None:
        if pk is None:
            rows = self.query("g.V(vid).hasLabel('inversion').valueMap()", {"vid": vid})
        else:
            rows = self.query("g.V(vid).has('pk', pk).valueMap()", {"vid": vid, "pk": pk})
        if not rows:
            return None
        rec = self._vertex_record(rows[0])
        if not rec["complete"]:
            return None
        edges = self.query("g.V(vid).has('pk', pk).outE('fit').project('i', 'data').by('i').by('data')",
                           {"vid": vid, "pk": rec["run"]})
        rows = sorted(((int(e["i"]), json.loads(e["data"])) for e in edges), key=lambda t: t[0])
        meta = json.loads(rec.pop("_meta"))
        stations = [d for _, d in rows]
        result = dict(meta)
        result["md_ft"] = [d["md"] for d in stations]
        result["tvd_ft"] = [d["tvd"] for d in stations]
        result["inclination_deg"] = [d["inc"] for d in stations]
        result["curves"] = [{**c, "obs": [d["obs"].get(c["label"]) for d in stations],
                             "pred": [d["pred"].get(c["label"]) for d in stations]} for c in meta["curves"]]
        n_b = rec["summary"]["boundaries"] or 0
        result["model"] = {**meta["model"], "boundary_tvd_ft": [[d["b"][k] for d in stations] for k in range(n_b)]}
        # restore the original key order of service.serialize
        order = ["well", "md_ft", "tvd_ft", "inclination_deg", "curves", "model", "rms_percent_used",
                 "misfit_normalised", "stations", "forward_evaluations", "elapsed_s"]
        rec["result"] = {k: result[k] for k in order if k in result} | {k: v for k, v in result.items() if k not in order}
        rec.pop("summary", None)
        rec.pop("complete", None)
        return rec

    def find(self, fingerprint: str, run: str | None = None) -> dict | None:
        with self._cache_lock:
            hit = self._cache.get(fingerprint)
        if hit is not None:
            return json.loads(json.dumps(hit))
        rec = self._load(f"inv|{fingerprint}", run)
        if rec is not None:
            with self._cache_lock:
                if len(self._cache) >= _CACHE_MAX:
                    self._cache.pop(next(iter(self._cache)))
                self._cache[fingerprint] = rec
            rec = json.loads(json.dumps(rec))
        return rec

    def get(self, job_id: str) -> dict | None:
        with self._cache_lock:
            hit = next((fp for fp, r in self._cache.items() if r["job_id"] == job_id), None)
        if hit:
            return self.find(hit)
        rows = self.query("g.V().hasLabel('inversion').has('job_id', jid).has('complete', true)"
                          ".project('f', 'r').by('fingerprint').by('run')", {"jid": job_id})
        return self.find(rows[0]["f"], rows[0]["r"]) if rows else None

    def older_versions(self, run, request_key, version):
        rows = self.query("g.V().has('pk', pk).hasLabel('inversion').has('request_key', rk).has('complete', true)"
                          ".has('superseded', false).project('f', 'v').by('fingerprint').by('version')",
                          {"pk": run, "rk": request_key})
        return [r["f"] for r in rows if r["v"] != version]

    def list_finished(self, run):
        rows = self.query("g.V().has('pk', pk).hasLabel('inversion').has('complete', true).has('superseded', false)"
                          ".valueMap('fingerprint', 'job_id', 'run', 'version', 'request_key', 'request', 'created',"
                          " 'started', 'finished', 'supersedes', 'superseded', 'complete', 'stations', 'boundaries')",
                          {"pk": run})
        out = []
        for vm in rows:
            rec = self._vertex_record(vm)
            for k in ("_meta", "complete", "plan"):
                rec.pop(k, None)
            out.append(rec)
        return sorted(out, key=lambda r: r.get("finished") or 0, reverse=True)

    def all_records(self, include_test: bool = False):
        rows = self.query("g.V().hasLabel('inversion').has('complete', true).project('f', 'r')"
                          ".by('fingerprint').by('run')")
        out = []
        for r in rows:
            if not include_test and str(r["r"]).startswith("test|"):
                continue
            rec = self.find(r["f"], r["r"])
            if rec is not None:
                out.append(rec)
        return out

    def fingerprints(self, include_test: bool = False) -> dict[str, str]:
        """{fingerprint: run} of complete inversions (cheap: no fit edges); used by the startup sync."""
        rows = self.query("g.V().hasLabel('inversion').has('complete', true).project('f', 'r')"
                          ".by('fingerprint').by('run')")
        return {r["f"]: r["r"] for r in rows if include_test or not str(r["r"]).startswith("test|")}

    def count_stations(self, run):
        return int(self.query("g.V().has('pk', pk).hasLabel('station').count()", {"pk": run})[0])
