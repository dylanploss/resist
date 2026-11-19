"""HTTP endpoints for browsing runs, QC results and curve data."""

from datetime import datetime, timezone
from functools import lru_cache
import json
import math
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
import numpy as np
from pydantic import BaseModel, Field

from backend.qc.selection import DEFAULT_SELECT, SELECT_RANGE, select_curves
from backend.services import field, runs, well3d

REPO_ROOT = runs.REPO_ROOT
DATA_DIR = runs.data_dir()
SELECTION_DIR = Path(os.environ.get("RESIST_SELECTION_DIR", REPO_ROOT / "backend" / "output" / "selections"))
FT_PER_M = 1 / 0.3048

router = APIRouter()


class SelectionRequest(BaseModel):
    curves: list[str] = Field(min_length=1, max_length=SELECT_RANGE[1])
    n_select: int = Field(DEFAULT_SELECT, ge=SELECT_RANGE[0], le=SELECT_RANGE[1])


def _path(run: str) -> Path:
    path = runs.run_paths().get(run)
    if path is None:
        raise HTTPException(404, f"unknown run: {run}")
    return path


def _load(run: str):
    """Shared with the /curves endpoints, so a run is parsed once per process."""
    _path(run)
    return runs.get_run(run)


@lru_cache(maxsize=32)
def _qc(run: str, n_select: int) -> dict:
    return select_curves(_load(run), n_select)


def _to_list(values: np.ndarray) -> list:
    return [_to_list(v) for v in values] if values.ndim > 1 else \
        [float(v) if math.isfinite(v) else None for v in values]


@router.get("/runs/{run}/qc")
def run_qc(run: str, n_select: int = Query(DEFAULT_SELECT, ge=SELECT_RANGE[0], le=SELECT_RANGE[1])) -> dict:
    _path(run)
    return _qc(run, n_select)


@router.get("/runs/{run}/curves/{name}")
def curve(run: str, name: str, start_ft: float | None = None, end_ft: float | None = None,
          max_points: int = Query(1500, ge=50, le=20000)) -> dict:
    """Depth samples for one channel, thinned by stride (not averaged) so noise stays visible."""
    data = _load(run)
    if name not in data.curves:
        raise HTTPException(404, f"unknown curve {name} in {run}")
    md_ft = data.depth_m * FT_PER_M
    idx, stride = well3d.window_indices(md_ft, start_ft, end_ft, max_points)
    values = data.curves[name][idx]
    meta = data.metadata.set_index("curve").loc[name]
    return {
        "run": run,
        "curve": name,
        "unit": meta["unit"],
        "family": meta.get("family", "conventional"),
        "image": values.ndim == 2,
        "stride": stride,
        "md_ft": _to_list(md_ft[idx]),
        # Images are returned bins x depth, the layout a heatmap expects.
        "values": _to_list(values.T if values.ndim == 2 else values),
    }


@router.get("/runs/{run}/well3d")
def well_3d(run: str, curve: str, start_ft: float | None = None, end_ft: float | None = None,
            max_points: int = Query(4000, ge=100, le=20000)) -> dict:
    """One curve along the well path, with the QC tab colour spec; see well3d.well3d."""
    try:
        return well3d.well3d(_load(run), curve, start_ft, end_ft, max_points)
    except well3d.UnknownCurveError as exc:
        raise HTTPException(404, str(exc)) from exc
    except well3d.NoTrajectoryError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/field")
def field_view(max_points: int = Query(300, ge=50, le=2000)) -> dict:
    """Every run's thinned path at absolute UTM positions; see field.field."""
    loaded = {}
    for run in runs.run_paths():
        try:
            loaded[run] = runs.get_run(run)
        except Exception as exc:  # one unreadable file must not hide the rest of the field
            loaded[run] = exc
    return field.field(loaded, max_points)


@router.get("/runs/{run}/selection")
def saved_selection(run: str) -> dict:
    _path(run)
    path = SELECTION_DIR / f"{run}.json"
    if not path.exists():
        raise HTTPException(404, f"no saved selection for run {run}")
    return json.loads(path.read_text(encoding="utf-8"))


@router.post("/runs/{run}/selection")
def save_selection(run: str, request: SelectionRequest) -> dict:
    _path(run)
    qc = _qc(run, request.n_select)
    unknown = [c for c in request.curves if c not in qc["scores"]]
    if unknown:
        raise HTTPException(422, f"curves not in run {run}: {', '.join(unknown)}")
    if len(set(request.curves)) != len(request.curves):
        raise HTTPException(422, "duplicate curves in selection")
    rejected = {r["curve"]: r["reason"] for r in qc["rejected"]}
    record = {
        "run": run,
        "well": qc["well"],
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "curves": request.curves,
        "auto_selected": qc["selected"],
        "added": [c for c in request.curves if c not in qc["selected"]],
        "removed": [c for c in qc["selected"] if c not in request.curves],
        "overridden_rejections": {c: rejected[c] for c in request.curves if c in rejected},
    }
    SELECTION_DIR.mkdir(parents=True, exist_ok=True)
    (SELECTION_DIR / f"{run}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record
