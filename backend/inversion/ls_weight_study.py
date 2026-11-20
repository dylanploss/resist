"""Long-spacing weight study: rerun stored inversion windows that used the guessed-geometry ZR 50/66/82 in channels with
``service.GUESSED_GEOMETRY_WEIGHT`` at several values and compare the results. Nothing is saved to the inversion store.

    python -m backend.inversion.ls_weight_study --weights 1.0 0.25 --output out/ls_weight

Every request is replayed as stored (curves, interval, dip lines, ...) with the current code, so the runs differ only in
the long-spacing weight. Per job and weight it reports the normalised misfit of all used channels, of the long-spacing
channels and of the rest; against the first weight it reports how far the boundaries (TVD at each station) and the
layer resistivities moved.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import time

import numpy as np

from backend.inversion import graph_io, service

ROOT = Path(__file__).resolve().parents[2]
LS = re.compile(r"^ZR[ML](50|66|82)")


def stored_requests(snapshot: Path, only: list[str] | None = None) -> list[dict]:
    """Stored records whose request selected a long-spacing curve (optionally only the given job ids)."""
    out = []
    for rec in graph_io.read_snapshot(snapshot):
        if only and rec["job_id"] not in only:
            continue
        if any(LS.match(c) for c in rec["request"]["curves"]):
            out.append(rec)
    return out


def run_one(run, request: dict, weight: float) -> dict:
    old = service.GUESSED_GEOMETRY_WEIGHT
    service.GUESSED_GEOMETRY_WEIGHT = weight
    try:
        plan = service.build_plan(run, request["curves"], request["calibration"])
        t0 = time.time()
        result = service.run_inversion(run, request, plan)
        result["wall_s"] = round(time.time() - t0, 1)
        return result
    finally:
        service.GUESSED_GEOMETRY_WEIGHT = old


def _chi(curves, pick) -> float | None:
    vals = [c["rms_normalised"] for c in curves if c["used"] and pick(c) and c["rms_normalised"] is not None]
    return round(float(np.sqrt(np.mean(np.square(vals)))), 2) if vals else None


def misfits(result: dict) -> dict:
    """Normalised misfit of all used channels and of the long-spacing / other ones (RMS over curves), and the
    long-spacing misfit whatever their weight."""
    curves = result["curves"]
    is_ls = lambda c: bool(LS.match(c["label"]))   # noqa: E731
    shown = [c for c in curves if is_ls(c) and c["rms_normalised"] is not None]
    return {"misfit_all": result["misfit_normalised"], "misfit_long_spacing": _chi(curves, is_ls),
            "misfit_other": _chi(curves, lambda c: not is_ls(c)),
            "long_spacing_misfit_any_weight": round(float(np.sqrt(np.mean([c["rms_normalised"] ** 2 for c in shown]))), 2)
            if shown else None}


def model_change(a: dict, b: dict) -> dict:
    """Boundary TVD difference (ft) per station and boundary, and |log10 Rh ratio| per slice layer, b against a."""
    ba = np.array(a["model"]["boundary_tvd_ft"], dtype=float)
    bb = np.array(b["model"]["boundary_tvd_ft"], dtype=float)
    d = np.abs(ba - bb) if ba.shape == bb.shape else np.array([np.nan])
    sa = {s["md_centre_ft"]: s for s in a["slices"]}
    rh = [abs(np.log10(lb["rh"] / la["rh"])) for s in b["slices"] if s["md_centre_ft"] in sa
          for la, lb in zip(sa[s["md_centre_ft"]]["layers"], s["layers"])]
    dips = [abs(s["dip_deg"] - sa[s["md_centre_ft"]]["dip_deg"]) for s in b["slices"] if s["md_centre_ft"] in sa]
    fin = d[np.isfinite(d)]
    return {"boundary_shift_ft_median": round(float(np.median(fin)), 2) if fin.size else None,
            "boundary_shift_ft_p90": round(float(np.percentile(fin, 90)), 2) if fin.size else None,
            "rh_change_percent_median": round(float(100 * (10 ** np.median(rh) - 1)), 1) if rh else None,
            "rh_change_percent_p90": round(float(100 * (10 ** np.percentile(rh, 90) - 1)), 1) if rh else None,
            "dip_change_deg_median": round(float(np.median(dips)), 2) if dips else None}


def main():
    from backend.services import runs

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", type=float, nargs="+", default=[1.0, 0.25])
    p.add_argument("--snapshot", type=Path, default=ROOT / "data" / "graph" / "inversions.json")
    p.add_argument("--jobs", nargs="*", help="only these stored job ids")
    p.add_argument("--output", type=Path, default=ROOT / "out" / "ls_weight")
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    summary = []
    for rec in stored_requests(args.snapshot, args.jobs):
        run = runs.get_run(rec["run"])
        request = service.canonical_request(rec["run"], rec["request"])
        results = {}
        for w in args.weights:
            print(f"{rec['job_id']} {rec['run']} {request['md_min_ft']:g}-{request['md_max_ft']:g} ft, "
                  f"long-spacing weight {w:g} ...", flush=True)
            results[w] = run_one(run, request, w)
            (args.output / f"{rec['job_id']}_w{w:g}.json").write_text(json.dumps(results[w]))
        base = results[args.weights[0]]
        for w, res in results.items():
            row = {"job_id": rec["job_id"], "run": rec["run"], "md_min_ft": request["md_min_ft"],
                   "md_max_ft": request["md_max_ft"], "lines": bool(request.get("lines")), "weight": w,
                   "wall_s": res["wall_s"], **misfits(res)}
            if w != args.weights[0]:
                row.update(model_change(base, res))
            summary.append(row)
            print(json.dumps(row), flush=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
