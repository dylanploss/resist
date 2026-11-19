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

from backend.data.loader import load_run
from backend.qc.selection import DEFAULT_SELECT, SELECT_RANGE, select_curves

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("RESIST_DATA_DIR", REPO_ROOT / "data"))
SELECTION_DIR = Path(os.environ.get("RESIST_SELECTION_DIR", REPO_ROOT / "backend" / "output" / "selections"))
FT_PER_M = 1 / 0.3048

router = APIRouter()


class SelectionRequest(BaseModel):
    curves: list[str] = Field(min_length=1, max_length=SELECT_RANGE[1])
    n_select: int = Field(DEFAULT_SELECT, ge=SELECT_RANGE[0], le=SELECT_RANGE[1])


def _run_paths() -> dict[str, Path]:
    return {p.stem: p for p in sorted(DATA_DIR.glob("*.dlis"))}


def _path(run: str) -> Path:
    path = _run_paths().get(run)
    if path is None:
        raise HTTPException(404, f"unknown run: {run}")
    return path


# Image channels make one run about 100 MB in memory, so keep only a few.
@lru_cache(maxsize=2)
def _load(run: str):
    return load_run(_path(run))


@lru_cache(maxsize=32)
def _qc(run: str, n_select: int) -> dict:
    return select_curves(_load(run), n_select)


def _to_list(values: np.ndarray) -> list:
    return [_to_list(v) for v in values] if values.ndim > 1 else \
        [float(v) if math.isfinite(v) else None for v in values]


@router.get("/runs")
def runs() -> dict:
    return {"runs": [{"run": stem, "label": stem.removesuffix("_RES_GEOSIGNAL")}
                     for stem in _run_paths()]}


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
    keep = np.ones(len(md_ft), dtype=bool)
    if start_ft is not None:
        keep &= md_ft >= start_ft
    if end_ft is not None:
        keep &= md_ft <= end_ft
    idx = np.flatnonzero(keep)
    stride = max(1, math.ceil(len(idx) / max_points))
    idx = idx[::stride]
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
