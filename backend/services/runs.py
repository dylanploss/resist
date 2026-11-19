"""Locate delivered DLIS runs and load them once per process."""

import os
from pathlib import Path
import threading

from dlisio import dlis

from backend.data.loader import WellRun, load_run

REPO_ROOT = Path(__file__).resolve().parents[2]
FT_TO_M = 0.3048


class DataDirError(RuntimeError):
    """The data directory is missing or holds no DLIS files."""


class UnknownRunError(LookupError):
    """No DLIS file matches the requested run id."""


_lock = threading.Lock()
_run_locks: dict[Path, threading.Lock] = {}
_runs: dict[tuple[Path, float], WellRun] = {}
_summaries: dict[tuple[Path, float], dict] = {}


def data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR") or REPO_ROOT / "data").resolve()


def run_paths() -> dict[str, Path]:
    folder = data_dir()
    if not folder.is_dir():
        raise DataDirError(f"data directory not found: {folder} (set DATA_DIR)")
    paths = {p.stem: p for p in sorted(folder.glob("*.dlis"))}
    if not paths:
        raise DataDirError(f"no .dlis files in data directory: {folder} (set DATA_DIR)")
    return paths


def resolve(run_id: str) -> Path:
    path = run_paths().get(run_id)
    if path is None:
        raise UnknownRunError(f"unknown run: {run_id}")
    return path


def _key(path: Path) -> tuple[Path, float]:
    return path, path.stat().st_mtime


def get_run(run_id: str) -> WellRun:
    path = resolve(run_id)
    key = _key(path)
    with _lock:
        run_lock = _run_locks.setdefault(path, threading.Lock())
    with run_lock:
        if key not in _runs:
            _runs[key] = load_run(path)
        return _runs[key]


def summary(path: Path) -> dict:
    """Header-only facts, so listing runs does not parse curve data."""
    key = _key(path)
    if key in _summaries:
        return _summaries[key]
    entry = {"run": path.stem, "label": path.stem.removesuffix("_RES_GEOSIGNAL"),
             "file": path.name, "well": None,
             "depth_min_m": None, "depth_max_m": None}
    try:
        with dlis.load(str(path)) as files:
            logical = files[0]
            if logical.origins:
                entry["well"] = logical.origins[0].well_name
            frame = logical.frames[0] if logical.frames else None
            index = frame.channels[0] if frame is not None and frame.channels else None
            if index is not None and index.units == "ft" and frame.index_min is not None:
                entry["depth_min_m"] = float(frame.index_min) * FT_TO_M
                entry["depth_max_m"] = float(frame.index_max) * FT_TO_M
    except Exception as exc:
        entry["error"] = f"header unreadable: {exc}"
    _summaries[key] = entry
    return entry


def list_runs() -> list[dict]:
    return [summary(path) for path in run_paths().values()]


def clear_cache() -> None:
    with _lock:
        _runs.clear()
        _summaries.clear()
        _run_locks.clear()
