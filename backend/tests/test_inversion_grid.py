"""RESIST_INVERSION_WORKERS and the headless grid runner (backend.inversion.run_grid)."""

import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from backend.inversion import run_grid

ROOT = Path(__file__).resolve().parents[2]


def _workers(env_value):
    env = {k: v for k, v in os.environ.items() if k != "RESIST_INVERSION_WORKERS"}
    if env_value is not None:
        env["RESIST_INVERSION_WORKERS"] = env_value
    out = subprocess.run([sys.executable, "-c", "from backend.inversion import service; print(service.WORKERS)"],
                         cwd=ROOT, env=env, capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def test_workers_default_is_six():
    assert _workers(None) == 6


def test_workers_from_environment():
    assert _workers("70") == 70


def test_resolve_run_id_by_unique_substring():
    ids = ["2_4-Z-20_18840", "2_4-Z-25_20156", "2_4-Z-25_21250"]
    assert run_grid.resolve_run_id("Z-20", ids) == "2_4-Z-20_18840"
    assert run_grid.resolve_run_id("2_4-Z-25_21250", ids) == "2_4-Z-25_21250"
    with pytest.raises(ValueError):
        run_grid.resolve_run_id("Z-25", ids)


def test_auto_intervals_tile_finite_range():
    md = np.array([np.nan, 100.2, 150.0, 399.9, np.nan])
    assert run_grid.auto_intervals(md, 100.0) == [[101.0, 201.0], [201.0, 301.0]]
    assert run_grid.auto_intervals(md, 100.0, max_count=1) == [[101.0, 201.0]]


def test_expand_product_and_qc_curves():
    spec = {"curves": "qc", "layers": [2, 3], "quick": True, "window_ft": 24.0,
            "runs": [{"run": "VC-2", "intervals": [[10, 130]]}]}
    pts = run_grid.expand(spec, ["2_4-VC-2_x", "2_4-VC-3_x"], get_run=None, qc_curves=lambda rid: ["ARM16PC"])
    assert [p["layers"] for p in pts] == [2, 3]
    assert all(p["run"] == "2_4-VC-2_x" and p["curves"] == ["ARM16PC"] and p["quick"] and p["window_ft"] == 24.0
               and p["step_ft"] == 4.0 and (p["md_min_ft"], p["md_max_ft"]) == (10.0, 130.0) for p in pts)


def test_demo_grid_first_point_is_the_stored_vc2_request():
    """The demo grid's first point is the committed VC-2 17202-17322 ft request (a cache hit at the same
    INVERSION_VERSION, otherwise the new result supersedes it)."""
    import json
    from backend.inversion import graph_io, service
    from backend.inversion.api import InversionRequest
    from backend.services import runs
    spec = json.loads((ROOT / "infra/vm/grids/demo.json").read_text())
    records = graph_io.read_snapshot(ROOT / "data/graph/inversions.json")
    req = dict(spec["runs"][0], intervals=spec["runs"][0]["intervals"][:1])
    pts = run_grid.expand({**spec, "runs": [req]}, runs.run_paths().keys(), runs.get_run,
                          lambda rid: __import__("backend.qc.selection", fromlist=["x"]).select_curves(
                              runs.get_run(rid))["selected"])
    request = InversionRequest(**pts[0]).model_dump(exclude={"force"})
    mine = service.canonical_request(request["run"], request)
    assert any(r["run"] == request["run"] and service.canonical_request(r["run"], r["request"]) == mine
               for r in records)


def test_request_key_ignores_weights_but_fingerprint_does_not():
    """A code change that re-weights channels must still supersede the old result (same request_key)."""
    from backend.inversion import service
    request = {"curves": ["ARH16P"], "md_min_ft": 100.0, "md_max_ft": 200.0}
    plan = {"used": [{"label": "ARH16P", "weight": 1.0}]}
    reweighted = {"used": [{"label": "ARH16P", "weight": 0.5}]}
    fp, key = service.fingerprint("run", request, plan)
    fp2, key2 = service.fingerprint("run", request, reweighted)
    assert key == key2 and fp != fp2
