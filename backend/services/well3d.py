"""Well path and QC colour spec for drawing one curve along the well in 3D."""

import math

import numpy as np

from backend.data.loader import WellRun
from backend.qc import metrics
from backend.qc.selection import doi_tier

FT_TO_M = 0.3048
IN_TO_M = 0.0254
# Assumed: a propagation tool resolves at most about three transmitter-receiver spacings radially.
DOI_CAP_SPACINGS = 3.0
TRAJECTORY = ("TVD", "INC", "AZI", "UTMX", "UTMY")


class UnknownCurveError(LookupError):
    """The run has no channel with the requested name."""


class NoTrajectoryError(ValueError):
    """Neither UTMX/UTMY/TVD nor INC/AZI give a usable well path."""


def window_indices(md_ft: np.ndarray, start_ft: float | None, end_ft: float | None,
                   max_points: int, valid: np.ndarray | None = None) -> tuple[np.ndarray, int]:
    """Samples inside [start_ft, end_ft], thinned by stride (not averaged) to at most max_points."""
    keep = np.ones(len(md_ft), dtype=bool) if valid is None else valid.copy()
    if start_ft is not None:
        keep &= md_ft >= start_ft
    if end_ft is not None:
        keep &= md_ft <= end_ft
    idx = np.flatnonzero(keep)
    stride = max(1, math.ceil(len(idx) / max_points))
    return idx[::stride], stride


def minimum_curvature(md_m, inc_deg, azi_deg) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """East, north and up offsets (m) from the first station; azimuth is clockwise from north."""
    md = np.asarray(md_m, dtype=float)
    inc = np.radians(np.asarray(inc_deg, dtype=float))
    azi = np.radians(np.asarray(azi_deg, dtype=float))
    i1, i2, a1, a2 = inc[:-1], inc[1:], azi[:-1], azi[1:]
    # Haversine form of the dogleg angle stays accurate for the tiny angles between 0.5 ft stations.
    half = np.sin((i2 - i1) / 2) ** 2 + np.sin(i1) * np.sin(i2) * np.sin((a2 - a1) / 2) ** 2
    dogleg = 2 * np.arcsin(np.sqrt(np.clip(half, 0.0, 1.0)))
    small = dogleg < 1e-9
    ratio = np.where(small, 1.0, 2 / np.where(small, 1.0, dogleg) * np.tan(dogleg / 2))
    step = np.diff(md) / 2 * ratio
    east = step * (np.sin(i1) * np.sin(a1) + np.sin(i2) * np.sin(a2))
    north = step * (np.sin(i1) * np.cos(a1) + np.sin(i2) * np.cos(a2))
    down = step * (np.cos(i1) + np.cos(i2))
    start = np.zeros(1)
    return (np.concatenate([start, np.cumsum(east)]), np.concatenate([start, np.cumsum(north)]),
            -np.concatenate([start, np.cumsum(down)]))


def _fill(md: np.ndarray, values: np.ndarray | None, angle: bool = False) -> np.ndarray | None:
    """Linear fill of interior nulls; samples outside the first..last valid sample stay NaN."""
    if values is None or values.ndim != 1:
        return None
    ok = np.isfinite(values)
    if ok.sum() < 2:
        return None
    known = np.unwrap(values[ok], period=360.0) if angle else values[ok]
    out = np.interp(md, md[ok], known)
    first, last = np.flatnonzero(ok)[[0, -1]]
    out[:first] = np.nan
    out[last + 1:] = np.nan
    return np.mod(out, 360.0) if angle else out


def well_path(data: WellRun) -> dict:
    """Full-resolution x/y/z (m, east/north/up) from UTM + TVD, else minimum curvature on INC/AZI."""
    md_ft = data.depth_m / FT_TO_M
    ch = {name: _fill(md_ft, data.curves.get(name), angle=name == "AZI") for name in TRAJECTORY}
    utm_moves = ch["UTMX"] is not None and ch["UTMY"] is not None and (
        np.nanmax(ch["UTMX"]) > np.nanmin(ch["UTMX"]) or np.nanmax(ch["UTMY"]) > np.nanmin(ch["UTMY"]))
    if utm_moves and ch["TVD"] is not None:
        valid = np.isfinite(ch["UTMX"]) & np.isfinite(ch["UTMY"]) & np.isfinite(ch["TVD"])
        x, y, z = ch["UTMX"], ch["UTMY"], -ch["TVD"] * FT_TO_M
        source = "utm"
    elif ch["INC"] is not None and ch["AZI"] is not None:
        valid = np.isfinite(ch["INC"]) & np.isfinite(ch["AZI"])
        x, y, z = (np.full(len(md_ft), np.nan) for _ in range(3))
        x[valid], y[valid], z[valid] = minimum_curvature(data.depth_m[valid], ch["INC"][valid], ch["AZI"][valid])
        source = "min_curvature"
    else:
        raise NoTrajectoryError(f"{data.path.stem}: no usable UTMX/UTMY/TVD or INC/AZI")
    if not valid.any():
        raise NoTrajectoryError(f"{data.path.stem}: no sample with a computable position")
    return {"md_ft": md_ft, "x": x, "y": y, "z": z, "valid": valid, "source": source, **ch}


def _percentile(values: np.ndarray, p: float) -> float | None:
    """Same index rule as CurveTrackPlot: sorted finite values at floor(p * (n - 1))."""
    ordered = np.sort(values[np.isfinite(values)])
    return float(ordered[math.floor(p * (len(ordered) - 1))]) if len(ordered) else None


def color_spec(values: np.ndarray, unit: str) -> dict:
    """QC tab heatmap colours: ohmm -> Jet on log10 clipped 2-98 %, else RdBu reversed, +/- p98 |v|."""
    flat = np.asarray(values, dtype=float).ravel()
    if unit == "ohmm":
        with np.errstate(divide="ignore", invalid="ignore"):
            logs = np.where(flat > 0, np.log10(flat), np.nan)
        return {"scale": "Jet", "reverse": False, "log10": True,
                "zmin": _percentile(logs, 0.02), "zmax": _percentile(logs, 0.98)}
    limit = _percentile(np.abs(flat), 0.98) or 1.0
    return {"scale": "RdBu", "reverse": True, "log10": False, "zmin": -limit, "zmax": limit}


def curve_doi(row: dict) -> tuple[float | None, str | None]:
    """QC tab DOI index and tier for an inventory row; (None, None) for non-ADR channels."""
    if row.get("family") not in ("AR", "ZR", "ZG"):
        return None, None
    doi = metrics.doi_index(row["spacing_in"], row["frequency_hz"], row["measurement"])
    return doi, doi_tier(doi)


def skin_depth_m(rho_ohmm, frequency_hz: float) -> np.ndarray:
    """Plane-wave skin depth sqrt(2 rho / (omega mu0)) = 503.3 sqrt(rho / f) metres."""
    return 503.3 * np.sqrt(np.asarray(rho_ohmm, dtype=float) / frequency_hz)


def doi_metres(rho_ohmm, frequency_hz: float, spacing_in: float, measurement: str) -> np.ndarray:
    """Estimated radial reach per sample: skin depth in the local resistivity, softly capped by spacing.

    Approximation, not an inversion: the skin depth sets how far the signal penetrates in the
    formation the tool sits in, and a propagation tool cannot resolve much beyond a few
    transmitter-receiver spacings. 1/doi^2 = 1/skin^2 + 1/cap^2 keeps the reach growing with
    resistivity instead of flattening at a hard cap. Attenuation reads deeper by the same factor
    the QC DOI index uses.
    """
    factor = metrics.ATTENUATION_DEPTH_FACTOR if measurement == "attenuation" else 1.0
    cap = DOI_CAP_SPACINGS * spacing_in * IN_TO_M
    skin = skin_depth_m(rho_ohmm, frequency_hz)
    return factor / np.sqrt(1 / skin ** 2 + 1 / cap ** 2)


def _reference_resistivity(data: WellRun, row: dict) -> str | None:
    """The curve whose resistivity sets the DOI: the curve itself if it is a resistivity, else the
    run's deepest-reading AR resistivity with at least half its samples valid."""
    if row.get("family") in ("AR", "ZR") and row.get("unit") == "ohmm":
        return row["curve"]
    meta = data.metadata
    ar = meta[(meta["family"] == "AR") & (meta["unit"] == "ohmm") & (meta["valid_fraction"] >= 0.5)]
    if ar.empty:
        return None
    depth = ar.apply(lambda r: metrics.doi_index(r["spacing_in"], r["frequency_hz"], r["measurement"]), axis=1)
    return str(ar.loc[depth.idxmax(), "curve"])


def doi_profile(data: WellRun, row: dict, idx: np.ndarray, md_ft: np.ndarray) -> dict | None:
    """DOI in metres for the returned samples, or None for non-ADR curves.

    Azimuthal resistivity images give one DOI per bin (shape n x bins), from the same bin values
    that colour the tube, so the reach grows only on the side where the image turns resistive (red).
    Other curves give one DOI per sample.
    """
    if row.get("family") not in ("AR", "ZR", "ZG"):
        return None
    source = _reference_resistivity(data, row)
    if source is None:
        return None
    raw = np.asarray(data.curves[source], dtype=float)
    rho = np.where(raw > 0, raw, np.nan)
    # Same 2nd-98th percentile clip as the colour scale, so a redder bin always reads deeper.
    low, high = _percentile(rho.ravel(), 0.02), _percentile(rho.ravel(), 0.98)
    if low is None:
        return None
    picked = np.clip(rho[idx], low, high)
    ring = picked if picked.ndim == 1 else _row_mean(picked)
    ok = np.isfinite(ring)
    if not ok.any():
        return None
    ring = np.interp(md_ft[idx], md_ft[idx][ok], ring[ok])
    if picked.ndim == 2:
        picked = np.where(np.isfinite(picked), picked, ring[:, None])
    else:
        picked = ring
    doi = doi_metres(picked, row["frequency_hz"], row["spacing_in"], row["measurement"])
    return {"doi_m": doi, "source": source}


def _row_mean(values: np.ndarray) -> np.ndarray:
    counts = np.isfinite(values).sum(axis=1)
    return np.where(counts > 0, np.nansum(values, axis=1) / np.maximum(counts, 1), np.nan)


def _nullable(values: np.ndarray) -> list:
    out = values.astype(object)
    out[~np.isfinite(values)] = None
    return out.tolist()


def well3d(data: WellRun, curve: str, start_ft: float | None = None, end_ft: float | None = None,
           max_points: int = 4000) -> dict:
    """Aligned per-sample arrays for one curve along the well path.

    x_m, y_m, z_m are east, north and up in metres relative to the first returned sample, whose
    absolute UTM position and TVD are in `origin` (null when the path comes from minimum curvature
    without UTM or TVD channels). Trajectory nulls are filled linearly between valid samples;
    samples outside the valid trajectory span are dropped.
    """
    if curve not in data.curves:
        raise UnknownCurveError(f"unknown curve {curve} in {data.path.stem}")
    path = well_path(data)
    idx, stride = window_indices(path["md_ft"], start_ft, end_ft, max_points, path["valid"])
    raw = data.curves[curve]
    row = data.metadata.set_index("curve").loc[curve].to_dict()
    unit = row["unit"]
    doi, tier = curve_doi(row)
    image = raw.ndim == 2
    x0, y0, z0 = (float(path[k][idx[0]]) if len(idx) else 0.0 for k in ("x", "y", "z"))
    first = idx[0] if len(idx) else None

    def absolute(name: str) -> float | None:
        values = path[name]
        return None if first is None or values is None or not np.isfinite(values[first]) \
            else float(values[first])

    tvd = path["TVD"]
    tvd_ft = tvd[idx] if tvd is not None else -path["z"][idx] / FT_TO_M
    tvd0 = absolute("TVD")
    profile = doi_profile(data, {**row, "curve": curve}, idx, path["md_ft"])
    return {
        "run": data.path.stem,
        "well": data.well,
        "curve": curve,
        "unit": unit,
        "image": image,
        "bins": int(raw.shape[1]) if image else 1,
        "stride": stride,
        "path_source": path["source"],
        "origin": {"utmx": absolute("UTMX"), "utmy": absolute("UTMY"),
                   "tvd_m": None if tvd0 is None else tvd0 * FT_TO_M},
        "color": color_spec(raw, unit),
        "doi_index": doi,
        "doi_tier": tier,
        "doi_m": None if profile is None else np.round(profile["doi_m"], 3).tolist(),
        "doi_source": None if profile is None else profile["source"],
        "md_ft": path["md_ft"][idx].tolist(),
        "tvd_ft": _nullable(tvd_ft),
        "inc_deg": _nullable(path["INC"][idx]) if path["INC"] is not None else [None] * len(idx),
        "azi_deg": _nullable(path["AZI"][idx]) if path["AZI"] is not None else [None] * len(idx),
        "x_m": (path["x"][idx] - x0).tolist(),
        "y_m": (path["y"][idx] - y0).tolist(),
        "z_m": (path["z"][idx] - z0).tolist(),
        "values": _nullable(raw[idx]),
    }
