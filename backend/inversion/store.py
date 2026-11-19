"""Where finished inversions live: the shared Cosmos DB graph, or memory (+ the committed snapshot).

A *record* is the unit both stores save and return::

    {"fingerprint", "job_id", "run", "version", "request_key", "request", "plan", "result",
     "created", "started", "finished", "supersedes": [fingerprint, ...], "superseded": bool}

``request`` is the job request (without ``force``), ``plan`` is the public plan and ``result`` is exactly
``service.serialize``'s output. Listings return records without ``result`` but with ``summary``
(``stations``, ``boundaries``).

Store rules (docs/plans/inversion-cosmos-graph.md):

* ``find`` only returns complete records; a half-written Cosmos inversion is invisible.
* ``save`` replaces an existing record with the same fingerprint, links ``supersedes`` and marks those
  older records superseded (hidden from ``list_finished``).
* Stations are shared per run: ``count_stations`` is the union over all records, not the sum.
"""

from __future__ import annotations

import copy
import logging
import os
from pathlib import Path
import threading
import time
from typing import Protocol

log = logging.getLogger("resist.store")

SNAPSHOT_PATH = Path(__file__).resolve().parents[2] / "data" / "graph" / "inversions.json"


def station_key(md_ft) -> str:
    return f"{float(md_ft):.2f}"


def summary_of(record: dict) -> dict:
    result = record.get("result") or {}
    return {"stations": result.get("stations"),
            "boundaries": len(result.get("model", {}).get("boundary_tvd_ft", []))}


def without_result(record: dict) -> dict:
    out = {k: v for k, v in record.items() if k != "result"}
    out.setdefault("summary", summary_of(record))
    return out


class InversionStore(Protocol):
    kind: str

    def find(self, fingerprint: str, run: str | None = None) -> dict | None: ...
    def get(self, job_id: str) -> dict | None: ...
    def save(self, record: dict) -> dict: ...
    def delete(self, fingerprint: str, run: str | None = None) -> None: ...
    def older_versions(self, run: str, request_key: str, version: str) -> list[str]: ...
    def list_finished(self, run: str) -> list[dict]: ...
    def all_records(self) -> list[dict]: ...
    def count_stations(self, run: str) -> int: ...
    def ping(self) -> None: ...


class MemoryStore:
    """Today's in-process behaviour, plus the store rules. Thread-safe."""

    kind = "memory"

    def __init__(self):
        self._records: dict[str, dict] = {}
        self._stations: dict[str, dict[str, float]] = {}   # run -> station key -> observed revision count
        self._lock = threading.Lock()

    def find(self, fingerprint, run=None):
        with self._lock:
            rec = self._records.get(fingerprint)
            return copy.deepcopy(rec) if rec else None

    def get(self, job_id):
        with self._lock:
            rec = next((r for r in self._records.values() if r["job_id"] == job_id), None)
            return copy.deepcopy(rec) if rec else None

    def save(self, record):
        rec = copy.deepcopy(record)
        rec.setdefault("supersedes", [])
        rec["superseded"] = bool(rec.get("superseded", False))
        with self._lock:
            for old in rec["supersedes"]:
                if old in self._records:
                    self._records[old]["superseded"] = True
            self._records[rec["fingerprint"]] = rec
            stations = self._stations.setdefault(rec["run"], {})
            for md in (rec.get("result") or {}).get("md_ft", []):
                if md is not None:
                    stations[station_key(md)] = stations.get(station_key(md), 0) + 1
        return {"observed_updated": 0}

    def delete(self, fingerprint, run=None):
        with self._lock:
            self._records.pop(fingerprint, None)

    def older_versions(self, run, request_key, version):
        with self._lock:
            return [r["fingerprint"] for r in self._records.values()
                    if r["run"] == run and r.get("request_key") == request_key and r.get("version") != version
                    and not r.get("superseded")]

    def list_finished(self, run):
        with self._lock:
            out = [without_result(r) for r in self._records.values() if r["run"] == run and not r.get("superseded")]
        return sorted(out, key=lambda r: r.get("finished") or 0, reverse=True)

    def all_records(self):
        with self._lock:
            return [copy.deepcopy(r) for r in self._records.values()]

    def count_stations(self, run):
        with self._lock:
            return len(self._stations.get(run, {}))

    def ping(self):
        return None


# --- factory -----------------------------------------------------------------------------------------------

_store: InversionStore | None = None
_status: dict = {"store": "memory", "cosmos": "unavailable", "reason": "not initialised"}
_init_lock = threading.Lock()
_last_ping = [0.0]
PING_INTERVAL_S = 30.0


def _load_snapshot(store, path: Path = SNAPSHOT_PATH) -> int:
    if os.environ.get("RESIST_SNAPSHOT", "on").lower() in ("0", "off", "false", "no") or not path.is_file():
        return 0
    from backend.inversion import graph_io
    try:
        return graph_io.import_snapshot(store, path)["imported"]
    except Exception as exc:  # a broken snapshot must not stop the backend
        log.warning("could not load inversion snapshot %s: %s", path, exc)
        return 0


def _build() -> InversionStore:
    mode = os.environ.get("RESIST_STORE", "auto").lower()
    if mode != "memory":
        from backend.inversion import cosmos_config
        settings = cosmos_config.resolve()
        if settings.key:
            try:
                from backend.inversion.cosmos_store import CosmosStore
                store = CosmosStore(settings)
                store.ping()
                _status.update(store="cosmos", cosmos="ok", reason=None, account=settings.account,
                               key_source=settings.key_source)
                log.info("inversion store: Cosmos DB graph %s (%s/%s, key from %s)", settings.account,
                         settings.database, settings.graph, settings.key_source)
                return store
            except Exception as exc:
                reason = f"Cosmos DB graph unreachable: {type(exc).__name__}: {str(exc)[:200]}"
        else:
            reason = settings.reason or "no Cosmos key"
        log.warning("Cosmos graph store unavailable (%s); using the in-memory store and the snapshot. "
                    "To connect, %s, then restart the backend.", reason, cosmos_config.LOGIN_HINT)
    else:
        reason = "RESIST_STORE=memory"
    store = MemoryStore()
    loaded = _load_snapshot(store)
    _status.update(store="memory", cosmos="unavailable", reason=reason, snapshot_records=loaded)
    return store


def get_store() -> InversionStore:
    global _store
    if _store is None:
        with _init_lock:
            if _store is None:
                _store = _build()
    return _store


def set_store(store: InversionStore | None) -> None:
    """Swap the store (tests)."""
    global _store
    _store = store
    if store is not None:
        _status.update(store=store.kind, cosmos="ok" if store.kind == "cosmos" else "unavailable",
                       reason=None if store.kind == "cosmos" else "store set explicitly")


def status() -> dict:
    """Health fields; pings Cosmos at most every PING_INTERVAL_S and never raises or blocks on init."""
    if _store is None:
        if not _init_lock.locked():
            threading.Thread(target=get_store, name="store-init", daemon=True).start()
        return {"store": "memory", "cosmos": "unavailable", "reason": "connecting to the inversion store"}
    store = _store
    if store.kind == "cosmos" and time.time() - _last_ping[0] > PING_INTERVAL_S:
        _last_ping[0] = time.time()
        try:
            store.ping()
            _status.update(cosmos="ok", reason=None)
        except Exception as exc:
            _status.update(cosmos="unavailable", reason=f"ping failed: {type(exc).__name__}")
    return {k: v for k, v in _status.items() if v is not None}
