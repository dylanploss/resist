"""All runs together at their absolute UTM positions, for the 3D field view."""

import numpy as np

from backend.data.loader import WellRun
from backend.services import well3d

FT_TO_M = well3d.FT_TO_M


class NoPositionError(ValueError):
    """The run has a path shape but no absolute UTM position to place it in the field."""


def _first(values: np.ndarray | None, i: int) -> float | None:
    return None if values is None or not np.isfinite(values[i]) else float(values[i])


def field_path(data: WellRun, max_points: int = 300) -> dict:
    """Thinned absolute path of one run: east/north (UTM m) and TVD (m, positive down).

    UTM paths are used as they are. A minimum-curvature path is placed at the run's first UTMX/UTMY
    and TVD sample when those exist (constant UTM channels still give a position), else
    NoPositionError. `values` are the run's deepest-reading AR resistivity (see
    well3d._reference_resistivity) at the same samples, or null when the run has none.
    """
    path = well3d.well_path(data)
    idx, stride = well3d.window_indices(path["md_ft"], None, None, max_points, path["valid"])
    first = int(np.flatnonzero(path["valid"])[0])
    if path["source"] == "utm":
        east, north, tvd_m = path["x"][idx], path["y"][idx], -path["z"][idx]
    else:
        utmx, utmy = _first(path["UTMX"], first), _first(path["UTMY"], first)
        tvd0_ft = _first(path["TVD"], first)
        if utmx is None or utmy is None or tvd0_ft is None:
            raise NoPositionError(f"{data.path.stem}: no UTMX/UTMY/TVD at the first path sample")
        east = utmx + path["x"][idx] - path["x"][first]
        north = utmy + path["y"][idx] - path["y"][first]
        tvd_m = tvd0_ft * FT_TO_M - (path["z"][idx] - path["z"][first])
    curve = well3d._reference_resistivity(data, {})
    md_ft = path["md_ft"][idx]
    return {
        "run": data.path.stem,
        "well": data.well,
        "path_source": path["source"],
        "stride": stride,
        "md_range_ft": [float(md_ft[0]), float(md_ft[-1])],
        "curve": curve,
        "md_ft": md_ft.tolist(),
        "east_m": np.round(east, 2).tolist(),
        "north_m": np.round(north, 2).tolist(),
        "tvd_m": np.round(tvd_m, 2).tolist(),
        "values": None if curve is None else well3d._nullable(np.asarray(data.curves[curve], dtype=float)[idx]),
    }


def field(runs: dict[str, WellRun | Exception], max_points: int = 300) -> dict:
    """Paths for every run plus one resistivity colour spec over all their curves, so colours compare
    across wells. `runs` maps run id to its loaded data, or the exception raised while loading it."""
    placed, skipped, full = [], [], []
    for run, data in runs.items():
        if isinstance(data, Exception):
            skipped.append({"run": run, "reason": f"load failed: {data}"})
            continue
        try:
            entry = field_path(data, max_points)
        except (well3d.NoTrajectoryError, NoPositionError) as exc:
            skipped.append({"run": run, "reason": str(exc)})
            continue
        placed.append(entry)
        if entry["curve"] is not None:
            full.append(np.asarray(data.curves[entry["curve"]], dtype=float).ravel())
    if placed:
        east = np.concatenate([p["east_m"] for p in placed])
        north = np.concatenate([p["north_m"] for p in placed])
        centre = {"east_m": float((east.min() + east.max()) / 2), "north_m": float((north.min() + north.max()) / 2)}
    else:
        centre = None
    return {
        "centre": centre,
        "color": well3d.color_spec(np.concatenate(full), "ohmm") if full else None,
        "runs": placed,
        "skipped": skipped,
    }
