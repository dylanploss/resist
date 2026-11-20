"""Where finished inversions live.

* ``DualStore`` (default when Cosmos is reachable): the shared Cosmos DB graph (``backend.inversion.cosmos_store``)
  for reads, with every write also going to the snapshot below; falls back to the snapshot if Cosmos fails.
* ``SnapshotStore`` (Cosmos disabled or unreachable): memory, loaded from and written to the committed
  ``data/graph/inversions.json``. Cosmos is used when ``COSMOS_ENABLED=true`` or ``"enabled": true`` in
  ``backend/cosmos.config.json`` and a key resolves (env or ``az`` login).
* ``MemoryStore``: no persistence (``RESIST_STORE=memory``, tests).

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
            "boundaries": len(result.get("model", {}).get("boundary_tvd_ft", [])),
            "misfit_normalised": result.get("misfit_normalised")}


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


class SnapshotStore(MemoryStore):
    """MemoryStore backed by the committed JSON snapshot: loaded on start, rewritten (atomically) on each change.

    This is the default store. Results are shared by committing ``data/graph/inversions.json``.
    """

    kind = "snapshot"

    def __init__(self, path: Path = SNAPSHOT_PATH):
        super().__init__()
        self.path = Path(path)
        self._write_lock = threading.Lock()
        self.loaded = 0
        if self.path.is_file():
            from backend.inversion import graph_io
            for rec in graph_io.read_snapshot(self.path):
                MemoryStore.save(self, rec)
                self.loaded += 1

    def _write(self):
        from backend.inversion import graph_io
        with self._write_lock:
            graph_io.write_snapshot(self.all_records(), self.path)

    def save(self, record):
        info = super().save(record)
        self._write()
        return info

    def delete(self, fingerprint, run=None):
        super().delete(fingerprint, run)
        self._write()

    def save_many(self, records):
        """Add records with a single file write (startup sync)."""
        for rec in records:
            MemoryStore.save(self, rec)
        if records:
            self._write()

    def count(self) -> int:
        with self._lock:
            return len(self._records)


class DualStore:
    """Cosmos graph first, snapshot always: the default when Cosmos is reachable.

    * Reads ask Cosmos (``READ_TIMEOUT_S``); on error/timeout, or when Cosmos lacks the record, the snapshot answers
      and the store is marked degraded (one warning per transition).
    * Writes go to Cosmos, then to the snapshot file; one failing side never loses the other. The failure is
      returned as ``warning`` (shown in the job message) and kept as ``last_write_warning`` (shown in /health).
    * ``sync()`` (background, at startup) pushes snapshot records missing from Cosmos and pulls Cosmos records
      missing from the snapshot, comparing fingerprints first.
    """

    kind = "cosmos+snapshot"

    def __init__(self, cosmos, snapshot: SnapshotStore, read_timeout_s: float | None = None):
        from concurrent.futures import ThreadPoolExecutor
        self.cosmos, self.snapshot = cosmos, snapshot
        self.read_timeout_s = float(read_timeout_s if read_timeout_s is not None
                                    else os.environ.get("COSMOS_READ_TIMEOUT_S", 5))
        self._pool = ThreadPoolExecutor(4, thread_name_prefix="cosmos-read")
        self.cosmos_ok, self.reason, self.last_write_warning = True, None, None
        self.sync_status = "pending"

    # --- health --------------------------------------------------------------------------------------------

    def _mark(self, ok: bool, reason: str | None = None):
        if ok and not self.cosmos_ok:
            log.info("Cosmos graph reachable again")
        elif not ok and self.cosmos_ok:
            log.warning("Cosmos graph unavailable (%s); serving from the snapshot", reason)
        self.cosmos_ok, self.reason = ok, (None if ok else reason)

    def _cosmos(self, name, *args, timeout=True):
        try:
            if timeout:
                out = self._pool.submit(getattr(self.cosmos, name), *args).result(timeout=self.read_timeout_s)
            else:
                out = getattr(self.cosmos, name)(*args)
        except Exception as exc:
            from concurrent.futures import TimeoutError as FutureTimeout
            what = f"timeout after {self.read_timeout_s:g} s" if isinstance(exc, FutureTimeout) else type(exc).__name__
            self._mark(False, f"{name} failed: {what}: {str(exc)[:120]}".rstrip(": "))
            raise
        self._mark(True)
        return out

    def ping(self):
        self._cosmos("ping")

    # --- reads ---------------------------------------------------------------------------------------------

    def _read(self, name, *args):
        try:
            return self._cosmos(name, *args)
        except Exception:
            return None

    def find(self, fingerprint, run=None):
        return self._read("find", fingerprint, run) or self.snapshot.find(fingerprint, run)

    def get(self, job_id):
        return self._read("get", job_id) or self.snapshot.get(job_id)

    def list_finished(self, run):
        remote = self._read("list_finished", run)
        if remote is None:
            return self.snapshot.list_finished(run)
        seen = {r["fingerprint"] for r in remote}
        extra = [r for r in self.snapshot.list_finished(run) if r["fingerprint"] not in seen]   # not yet synced
        return sorted(remote + extra, key=lambda r: r.get("finished") or 0, reverse=True)

    def older_versions(self, run, request_key, version):
        remote = self._read("older_versions", run, request_key, version) or []
        return sorted(set(remote) | set(self.snapshot.older_versions(run, request_key, version)))

    def all_records(self):
        remote = self._read("all_records")
        return remote if remote is not None else self.snapshot.all_records()

    def count_stations(self, run):
        n = self._read("count_stations", run)
        return n if n is not None else self.snapshot.count_stations(run)

    # --- writes --------------------------------------------------------------------------------------------

    def _both(self, name, *args) -> dict:
        info, errors = {}, []
        try:
            info = self._cosmos(name, *args, timeout=False) or {}
        except Exception as exc:
            errors.append(f"Cosmos {name} failed ({type(exc).__name__})")
        try:
            getattr(self.snapshot, name)(*args)
        except Exception as exc:
            errors.append(f"snapshot {name} failed ({type(exc).__name__})")
        if len(errors) == 2:
            raise RuntimeError("; ".join(errors))
        if errors:
            self.last_write_warning = errors[0]
            log.warning("inversion store: %s; the other side was written", errors[0])
            info = {**info, "warning": errors[0]}
        return info

    def save(self, record):
        return self._both("save", record)

    def delete(self, fingerprint, run=None):
        self._both("delete", fingerprint, run)

    # --- startup sync --------------------------------------------------------------------------------------

    def sync(self) -> dict:
        """Idempotent two-way fill by fingerprint. Never raises; result also kept in ``sync_status``."""
        self.sync_status = "running"
        try:
            remote = self.cosmos.fingerprints()                      # {fingerprint: run}, complete only
            local = {r["fingerprint"]: r for r in self.snapshot.all_records()}
            push = sorted((r for fp, r in local.items() if fp not in remote), key=lambda r: r.get("finished") or 0)
            for rec in push:
                self.cosmos.save(rec)
            pulled = [r for r in (self.cosmos.find(fp, run) for fp, run in remote.items() if fp not in local) if r]
            self.snapshot.save_many(pulled)
            self.sync_status = f"done: pushed {len(push)}, pulled {len(pulled)}"
            self._mark(True)
        except Exception as exc:
            self.sync_status = f"failed: {type(exc).__name__}: {str(exc)[:120]}"
            log.warning("inversion store sync failed: %s", self.sync_status)
        log.info("inversion store sync %s", self.sync_status)
        return {"status": self.sync_status}

    def status(self) -> dict:
        return {"store": self.kind, "cosmos": "ok" if self.cosmos_ok else "unavailable", "reason": self.reason,
                "snapshot_records": self.snapshot.count(), "sync": self.sync_status,
                "last_write_warning": self.last_write_warning}


# --- factory -----------------------------------------------------------------------------------------------

COSMOS_DISABLED = "disabled (COSMOS_ENABLED=false or \"enabled\": false in backend/cosmos.config.json)"
_store: InversionStore | None = None
_status: dict = {"store": "snapshot", "cosmos": COSMOS_DISABLED}
_init_lock = threading.Lock()
_last_ping = [0.0]
PING_INTERVAL_S = 30.0


def cosmos_enabled(environ=None) -> bool:
    """COSMOS_ENABLED (env or backend/.env) wins; else ``enabled`` in backend/cosmos.config.json; default false."""
    from backend.inversion import cosmos_config
    env = {**cosmos_config.read_env_file(), **(os.environ if environ is None else environ)}
    if "COSMOS_ENABLED" in env:
        return env["COSMOS_ENABLED"].strip().lower() in ("1", "true", "yes", "on")
    return bool(cosmos_config.read_config().get("enabled", False))


def _snapshot_store() -> SnapshotStore:
    try:
        return SnapshotStore(SNAPSHOT_PATH)
    except Exception as exc:  # a broken snapshot must not stop the backend
        log.warning("could not load inversion snapshot %s: %s; starting empty", SNAPSHOT_PATH, exc)
        store = SnapshotStore.__new__(SnapshotStore)
        MemoryStore.__init__(store)
        store.path, store._write_lock, store.loaded = SNAPSHOT_PATH.with_suffix(".recovered.json"), threading.Lock(), 0
        return store


def _build() -> InversionStore:
    if os.environ.get("RESIST_STORE", "").lower() == "memory":
        _status.update(store="memory", cosmos="disabled (RESIST_STORE=memory)", reason=None)
        return MemoryStore()
    if not cosmos_enabled():
        store = _snapshot_store()
        _status.update(store="snapshot", cosmos=COSMOS_DISABLED, reason=None, snapshot_records=store.loaded)
        log.info("inversion store: snapshot %s (%d records); Cosmos %s", store.path, store.loaded, COSMOS_DISABLED)
        return store
    from backend.inversion import cosmos_config
    settings = cosmos_config.resolve()
    if settings.key:
        try:
            from backend.inversion.cosmos_store import CosmosStore
            store = CosmosStore(settings)
            store.ping()
            dual = DualStore(store, _snapshot_store())
            _status.update(store=dual.kind, cosmos="ok", reason=None, account=settings.account,
                           key_source=settings.key_source)
            log.info("inversion store: Cosmos DB graph %s (%s/%s, key from %s) + snapshot %s", settings.account,
                     settings.database, settings.graph, settings.key_source, dual.snapshot.path)
            threading.Thread(target=dual.sync, name="store-sync", daemon=True).start()
            return dual
        except Exception as exc:
            reason = f"Cosmos DB graph unreachable: {type(exc).__name__}: {str(exc)[:200]}"
    else:
        reason = settings.reason or "no Cosmos key"
    log.warning("Cosmos graph store unavailable (%s); using the snapshot store. To connect, %s, then restart the "
                "backend.", reason, cosmos_config.LOGIN_HINT)
    store = _snapshot_store()
    _status.update(store="snapshot", cosmos="unavailable", reason=reason, snapshot_records=store.loaded)
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
        _status.update(store=store.kind,
                       cosmos="ok" if store.kind in ("cosmos", DualStore.kind) else "disabled (store set explicitly)",
                       reason=None)


def _quiet_ping(store) -> None:
    try:
        store.ping()
    except Exception:
        pass                                           # DualStore records the failure as degraded


def status() -> dict:
    """Health fields. Never raises; never blocks on a Cosmos connection (pinged at most every 30 s)."""
    if _store is None:
        if cosmos_enabled():
            if not _init_lock.locked():
                threading.Thread(target=get_store, name="store-init", daemon=True).start()
            return {"store": "snapshot", "cosmos": "unavailable", "reason": "connecting to Cosmos DB"}
        get_store()
    store = _store
    if isinstance(store, DualStore):
        if time.time() - _last_ping[0] > PING_INTERVAL_S:
            _last_ping[0] = time.time()
            threading.Thread(target=_quiet_ping, args=(store,), name="store-ping", daemon=True).start()
        out = {k: v for k, v in _status.items() if v is not None}
        out.update({k: v for k, v in store.status().items() if v is not None})
        return out
    if store.kind == "cosmos" and time.time() - _last_ping[0] > PING_INTERVAL_S:
        _last_ping[0] = time.time()
        try:
            store.ping()
            _status.update(cosmos="ok", reason=None)
        except Exception as exc:
            _status.update(cosmos="unavailable", reason=f"ping failed: {type(exc).__name__}")
    return {k: v for k, v in _status.items() if v is not None}
