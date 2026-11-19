"""Time one sliced 1.5D inversion end to end (same path as the Inversion tab).

    python -m backend.inversion.benchmark                      # Z-20 20300-20400 ft, Quick, 3 layers
    RESIST_COMPUTE=jax python -m backend.inversion.benchmark --full
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import time

DEFAULT_CURVES = ["ZRM82P", "ZGM112P", "ZGM112A", "ZRM50P", "ZRL48P", "ZRM66P", "ZRM32A", "ARM16P", "ARH32AC"]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", default="2_4-Z-20_18840-23791ft_RES_GEOSIGNAL")
    p.add_argument("--md-min", type=float, default=20300)
    p.add_argument("--md-max", type=float, default=20400)
    p.add_argument("--step-ft", type=float, default=4.0)
    p.add_argument("--layers", type=int, default=3)
    p.add_argument("--slice-ft", type=float, default=None)
    p.add_argument("--window-ft", type=float, default=None)
    p.add_argument("--curves", default=",".join(DEFAULT_CURVES))
    p.add_argument("--full", action="store_true", help="full iterations instead of Quick")
    a = p.parse_args(argv)

    from backend.inversion import service
    from backend.services import runs

    run = runs.get_run(a.run)
    curves = a.curves.split(",")
    request = dict(run=a.run, curves=curves, md_min_ft=a.md_min, md_max_ft=a.md_max, step_ft=a.step_ft,
                   layers=a.layers, calibration=True, quick=not a.full,
                   slice_ft=a.slice_ft or service.DEFAULT_SLICE_FT, window_ft=a.window_ft or service.DEFAULT_WINDOW_FT)
    plan = service.build_plan(run, curves, True)
    t0 = time.time()
    result = service.run_inversion(run, request, plan)
    elapsed = time.time() - t0
    print(json.dumps({
        "compute": service.compute_backend(), "device": service.compute_device(), "host": platform.node(),
        "run": a.run, "md_ft": [a.md_min, a.md_max], "stations": result["stations"], "layers": a.layers,
        "channels_used": sum(c["used"] for c in result["curves"]), "quick": not a.full,
        "seconds": round(elapsed, 1), "misfit_normalised": result["misfit_normalised"],
        "slices": len(result["slices"]),
        "slice_misfit": [s["misfit_normalised"] for s in result["slices"]],
        "dip_deg": result["model"]["dip_deg"],
        "layers_rh": [l["rh"] for l in result["model"]["layers"]],
        "boundaries_tvd_ft_median": [l["bottom_tvd_ft"] for l in result["model"]["layers"][:-1]],
    }))


if __name__ == "__main__":
    os.environ.setdefault("PYTHONWARNINGS", "ignore")
    main()
