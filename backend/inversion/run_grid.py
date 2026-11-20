"""Run a grid of inversions headless (e.g. on the CPU grid VM) and store them like the API does.

    python -m backend.inversion.run_grid infra/vm/grids/demo.json [--parallel auto|N] [--dry-run]

Grid spec (JSON)::

    {"curves": "qc" | ["ARM16PC", ...],      # "qc": the QC auto-picks of each run
     "layers": 3 | [2, 3], "step_ft": 4.0 | [...], "quick": false | [...],   # lists expand to a product
     "calibration": true, "slice_ft": 4.0, "window_ft": 20.0,            # optional request fields
     "runs": [{"run": "VC-2", "intervals": [[17202, 17322], ...]},       # run: id or unique substring
              {"run": "Z-6", "intervals": "auto", "auto_length_ft": 120, "auto_max": 5}]}

Each grid point is fingerprinted exactly like ``POST /inversion/jobs``; points already in the store are skipped
(cache hit). Points are computed in child processes (``--one``) so each gets its own forward-model process pool;
results are saved by this process through the normal store (Cosmos + snapshot) and the snapshot is synced at the end.

A single job only parallelises the n_earth + 1 forward models of one Jacobian (``Inverter.jac``), so a pool much
larger than ~10 workers is idle; ``--parallel auto`` therefore runs several jobs at once and splits the cores
(``RESIST_INVERSION_WORKERS = (nproc - 2) // parallel``). ``--parallel 1`` runs them one by one with nproc - 2 workers.
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

log = logging.getLogger("resist.grid")
REQUEST_FIELDS = ("calibration", "slice_ft", "window_ft", "rh_min_ohmm", "rh_max_ohmm")
WORKERS_PER_JOB_USEFUL = 10   # >= n_earth + 1 for 4 layers; more workers per job are idle


def _as_list(value) -> list:
    return list(value) if isinstance(value, (list, tuple)) else [value]


def resolve_run_id(token: str, run_ids) -> str:
    run_ids = list(run_ids)
    if token in run_ids:
        return token
    hits = [r for r in run_ids if token in r]
    if len(hits) != 1:
        raise ValueError(f"run {token!r} matches {len(hits)} runs: {hits[:5]}")
    return hits[0]


def auto_intervals(md_ft: np.ndarray, length_ft: float, max_count: int | None = None) -> list[list[float]]:
    """Back-to-back windows of ``length_ft`` across the finite depth range (whole windows only)."""
    md = np.asarray(md_ft, float)
    md = md[np.isfinite(md)]
    if md.size == 0 or length_ft <= 0:
        return []
    lo, hi = float(np.ceil(md.min())), float(np.floor(md.max()))
    n = int((hi - lo) // length_ft)
    out = [[lo + i * length_ft, lo + (i + 1) * length_ft] for i in range(n)]
    return out[:max_count] if max_count else out


def covered_depths(run, curves: list[str]) -> np.ndarray:
    """MD (ft) where every requested curve has a finite value."""
    md = np.asarray(run.curves["DEPT"], float)
    ok = np.isfinite(md)
    for name in curves:
        v = np.asarray(run.curves[name], float)
        ok &= np.isfinite(v).all(axis=1) if v.ndim > 1 else np.isfinite(v)
    return md[ok]


def expand(spec: dict, run_ids, get_run, qc_curves) -> list[dict]:
    """Grid spec -> list of request dicts (same fields as ``POST /inversion/jobs`` minus ``force``)."""
    combos = list(itertools.product(_as_list(spec.get("layers", 3)), _as_list(spec.get("step_ft", 4.0)),
                                    _as_list(spec.get("quick", False))))
    extra = {k: spec[k] for k in REQUEST_FIELDS if k in spec}
    points = []
    for entry in spec["runs"]:
        run_id = resolve_run_id(entry["run"], run_ids)
        sel = entry.get("curves", spec.get("curves", "qc"))
        curves = list(qc_curves(run_id)) if sel == "qc" else list(sel)
        intervals = entry.get("intervals", "auto")
        if intervals == "auto":
            intervals = auto_intervals(covered_depths(get_run(run_id), curves),
                                       float(entry.get("auto_length_ft", spec.get("auto_length_ft", 120.0))),
                                       entry.get("auto_max", spec.get("auto_max")))
        for (md_min, md_max), (layers, step, quick) in itertools.product(intervals, combos):
            points.append({"run": run_id, "curves": curves, "md_min_ft": float(md_min), "md_max_ft": float(md_max),
                           "layers": int(layers), "step_ft": float(step), "quick": bool(quick), **extra})
    return points


# --- child: compute one point ------------------------------------------------------------------------------

def _compute_one(request_path: str, out_path: str) -> int:
    from backend.inversion import service
    from backend.services import runs
    request = json.loads(Path(request_path).read_text())
    plan = service.build_plan(runs.get_run(request["run"]), request["curves"], request["calibration"])
    job = service.Job("child", request["run"], request, plan)
    stop = threading.Event()

    def report():
        while not stop.wait(60):
            print(f"  progress {job.progress:.0%} {job.message}", flush=True)

    threading.Thread(target=report, daemon=True).start()
    try:
        result = service.run_inversion(runs.get_run(request["run"]), request, plan, job)
    finally:
        stop.set()
    Path(out_path).write_text(json.dumps(result, default=lambda o: o.item() if hasattr(o, "item") else str(o)))
    return 0


# --- parent: orchestrate -----------------------------------------------------------------------------------

def _label(req: dict) -> str:
    return (f"{req['run'][:20]} {req['md_min_ft']:.0f}-{req['md_max_ft']:.0f} ft L{req['layers']} "
            f"step {req['step_ft']:g}{' quick' if req['quick'] else ''}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("grid", nargs="?", help="grid spec JSON")
    ap.add_argument("--parallel", default="auto", help="jobs at once: 'auto' or an integer (default auto)")
    ap.add_argument("--dry-run", action="store_true", help="expand and check the cache, compute nothing")
    ap.add_argument("--log-dir", default="logs/grid", help="per-job child logs")
    ap.add_argument("--one", nargs=2, metavar=("REQUEST_JSON", "OUT_JSON"), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.one:
        return _compute_one(*args.one)
    if not args.grid:
        ap.error("grid spec required")

    from backend.inversion import service, store as store_mod
    from backend.inversion.api import InversionRequest
    from backend.qc.selection import select_curves
    from backend.services import runs

    spec = json.loads(Path(args.grid).read_text())
    points = expand(spec, runs.run_paths().keys(), runs.get_run,
                    lambda rid: select_curves(runs.get_run(rid))["selected"])
    st = store_mod.get_store()
    log.info("store: %s", json.dumps(store_mod.status()))

    todo = []
    for raw in points:
        request = InversionRequest(**raw).model_dump(exclude={"force"})
        plan = service.build_plan(runs.get_run(request["run"]), request["curves"], request["calibration"])
        fp, key = service.fingerprint(request["run"], request, plan)
        rec = st.find(fp, run=request["run"])
        if rec is not None:
            log.info("cache hit  %s -> job %s", _label(request), rec["job_id"])
            continue
        log.info("queued     %s -> job %s (%d curves used)", _label(request), fp[:12], len(plan["used"]))
        todo.append(service.Job(fp[:12], request["run"], request, plan, fingerprint=fp, request_key=key))

    ncpu = os.cpu_count() or 2
    usable = max(1, ncpu - 2)
    parallel = (max(1, min(len(todo), usable // WORKERS_PER_JOB_USEFUL)) if args.parallel == "auto"
                else max(1, int(args.parallel)))
    workers = max(1, usable // parallel)
    log.info("%d points, %d cached, %d to compute; %d at once x %d workers (%d CPUs)",
             len(points), len(points) - len(todo), len(todo), parallel, workers, ncpu)
    if args.dry_run or not todo:
        return 0

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    save_lock = threading.Lock()
    timings: list[tuple[str, str, float]] = []
    env = {**os.environ, "RESIST_INVERSION_WORKERS": str(workers)}

    def run_job(job) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            req_path, out_path = Path(tmp, "request.json"), Path(tmp, "result.json")
            req_path.write_text(json.dumps(job.request))
            job.started = time.time()
            log.info("start      %s job %s", _label(job.request), job.id)
            with open(log_dir / f"{job.id}.log", "w") as fh:
                proc = subprocess.run([sys.executable, "-m", "backend.inversion.run_grid", "--one",
                                       str(req_path), str(out_path)], stdout=fh, stderr=subprocess.STDOUT, env=env)
            job.finished = time.time()
            took = job.finished - job.started
            if proc.returncode != 0 or not out_path.is_file():
                log.error("FAILED     %s job %s after %.0f s (see %s)", _label(job.request), job.id, took,
                          log_dir / f"{job.id}.log")
                timings.append((job.id, "failed", took))
                return
            job.result = json.loads(out_path.read_text())
        with save_lock:
            note = service.save_result(job)
        n_slices = len(job.result.get("slices", []))
        log.info("done       %s job %s in %.0f s (%d slices, %.1f s/slice); %s", _label(job.request), job.id,
                 took, n_slices, took / max(1, n_slices), note)
        timings.append((job.id, "done", took))

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=parallel) as ex:
        list(ex.map(run_job, todo))
    if hasattr(st, "sync"):
        log.info("snapshot sync: %s", st.sync())
    log.info("grid finished in %.0f s: %s", time.time() - t0,
             ", ".join(f"{jid} {status} {took:.0f}s" for jid, status, took in timings))
    return 0 if all(s == "done" for _, s, _ in timings) else 1


if __name__ == "__main__":
    sys.exit(main())
