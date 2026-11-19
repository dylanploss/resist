"""Export / import the inversion store as a JSON snapshot (``data/graph/inversions.json``).

    python -m backend.inversion.graph_io export [--out PATH]          # configured store -> JSON
    python -m backend.inversion.graph_io import [--in PATH] [--memory] # JSON -> configured store (Cosmos when enabled)

With the default snapshot store, the snapshot is already written on every finished inversion; export is then
only needed to copy Cosmos (when enabled) into the file.

The snapshot is sorted and stable (records by run then fingerprint, keys sorted), so a re-export of the same
graph gives the same file. Import goes through ``store.save``, skips records already present (idempotent) and
saves older versions first so ``supersedes`` links resolve.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

from backend.inversion.store import SNAPSHOT_PATH

FORMAT = "resist-inversion-graph/1"
RECORD_KEYS = ("fingerprint", "job_id", "run", "version", "request_key", "request", "plan", "result",
               "created", "started", "finished", "supersedes", "superseded")


def snapshot_of(records: list[dict]) -> dict:
    recs = [{k: r.get(k) for k in RECORD_KEYS} for r in records if not str(r["run"]).startswith("test|")]
    recs.sort(key=lambda r: (r["run"], r["fingerprint"]))
    return {"format": FORMAT, "records": recs}


def write_snapshot(records: list[dict], path: Path = SNAPSHOT_PATH) -> dict:
    """Sorted, stable, atomic (temp file + os.replace) write of the snapshot."""
    snap = snapshot_of(records)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(snap, sort_keys=True, indent=1, allow_nan=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=".inversions-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return {"records": len(snap["records"]), "bytes": len(text.encode()), "path": str(path)}


def read_snapshot(path: Path = SNAPSHOT_PATH) -> list[dict]:
    snap = json.loads(Path(path).read_text(encoding="utf-8"))
    if snap.get("format") != FORMAT:
        raise ValueError(f"unknown snapshot format {snap.get('format')!r}")
    return sorted(snap["records"], key=lambda r: (r.get("finished") or 0))


def export_snapshot(store, path: Path = SNAPSHOT_PATH) -> dict:
    return write_snapshot(store.all_records(), path)


def import_snapshot(store, path: Path = SNAPSHOT_PATH) -> dict:
    imported = skipped = 0
    for rec in read_snapshot(path):
        existing = store.find(rec["fingerprint"], run=rec["run"])
        if existing is not None and existing.get("superseded") == rec.get("superseded"):
            skipped += 1
            continue
        store.save({**rec, "supersedes": [fp for fp in rec.get("supersedes") or []]})
        imported += 1
    return {"imported": imported, "skipped": skipped}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.inversion.graph_io")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("export")
    ex.add_argument("--out", type=Path, default=SNAPSHOT_PATH)
    im = sub.add_parser("import")
    im.add_argument("--in", dest="inp", type=Path, default=SNAPSHOT_PATH)
    im.add_argument("--memory", action="store_true", help="dry run into an empty in-memory store")
    args = ap.parse_args(argv)

    from backend.inversion import store as st
    if args.cmd == "import" and args.memory:
        target = st.MemoryStore()
    else:
        target = st.get_store()
        print(f"store: {st.status()}", file=sys.stderr)
    if args.cmd == "export":
        print(json.dumps(export_snapshot(target, args.out)))
    else:
        print(json.dumps(import_snapshot(target, args.inp)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
