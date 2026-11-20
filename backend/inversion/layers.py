"""Layer-boundary geometry of a finished inversion, for the 3D well view.

``boundary_geometry`` turns a serialized result (``service.serialize``) into what the 3D tab draws:

* the unit normal of the dipping boundaries in NED (same convention as ``LayerModel.normal``), so the view can
  tilt each boundary sideways off the well;
* per boundary and station, the boundary TVD, whether it is above the well, and the perpendicular distance from
  the well to the plane: ``|TVD_well - TVD_boundary| * cos(dip)``;
* per station, the nearest boundary and its distance.

The layer below a boundary gives its colour (``rh_below``), so a boundary reads as the top of that layer.
"""

from __future__ import annotations

import math

from backend.inversion.adr_forward import FT, LayerModel
import numpy as np


def _finite(v) -> bool:
    return v is not None and math.isfinite(v)


def plane_normal(dip_deg: float, dip_azimuth_deg: float) -> list[float]:
    """Unit normal (N, E, D) of the boundaries, pointing down (D component = cos(dip) >= 0)."""
    n = LayerModel(np.zeros(0), np.zeros(1), np.zeros(1), dip_deg, dip_azimuth_deg).normal()
    return [float(v) for v in n]


def boundary_geometry(result: dict) -> dict:
    model = result["model"]
    md, tvd = result["md_ft"], result["tvd_ft"]
    layers = model["layers"]
    normal = plane_normal(model["dip_deg"], model["dip_azimuth_deg"])
    cos_dip = abs(normal[2])
    boundaries = []
    for k, b_tvd in enumerate(model["boundary_tvd_ft"]):
        dist, above = [], []
        for t_well, t_b in zip(tvd, b_tvd):
            if not (_finite(t_well) and _finite(t_b)):
                dist.append(None)
                above.append(None)
                continue
            dist.append(round(abs(t_well - t_b) * FT * cos_dip, 3))
            above.append(bool(t_b < t_well))
        boundaries.append({"index": k, "tvd_ft": b_tvd, "distance_m": dist, "above": above,
                           "rh_above": layers[k]["rh"], "rh_below": layers[k + 1]["rh"],
                           "rv_below": layers[k + 1]["rv"]})
    nearest = {"boundary": [], "distance_m": [], "above": []}
    for i in range(len(md)):
        options = [(b["distance_m"][i], b["index"]) for b in boundaries if b["distance_m"][i] is not None]
        d, k = min(options) if options else (None, None)
        nearest["boundary"].append(k)
        nearest["distance_m"].append(d)
        nearest["above"].append(None if k is None else boundaries[k]["above"][i])
    return {"md_ft": md, "tvd_ft": tvd, "dip_deg": model["dip_deg"], "dip_azimuth_deg": model["dip_azimuth_deg"],
            "normal_ned": normal, "layers": layers, "boundaries": boundaries, "nearest": nearest,
            "slice_ft": result.get("slice_ft"), "window_ft": result.get("window_ft"),
            "slices": [{key: s.get(key) for key in SLICE_KEYS} for s in result.get("slices") or []]}


# What the 3D curtain needs of each slice (see frontend sectionModel.js).
SLICE_KEYS = ("md_centre_ft", "slice_min_ft", "slice_max_ft", "window_min_ft", "window_max_ft", "md_ft",
              "boundary_tvd_ft", "layers", "rh_std_log", "boundary_std_ft", "misfit_normalised")


def job_summary(job) -> dict:
    """Compact listing entry for a finished job (no result payload)."""
    req = job.request
    summary = getattr(job, "summary", None) or {}
    if job.result is not None:
        stations = job.result.get("stations")
        boundaries = len(job.result.get("model", {}).get("boundary_tvd_ft", []))
        misfit = job.result.get("misfit_normalised")
    else:
        stations, boundaries = summary.get("stations"), summary.get("boundaries") or 0
        misfit = summary.get("misfit_normalised")
    return {"id": job.id, "run": job.run, "status": job.status, "finished": job.finished,
            "md_min_ft": req["md_min_ft"], "md_max_ft": req["md_max_ft"], "layers": req["layers"],
            "step_ft": req.get("step_ft"), "slice_ft": req.get("slice_ft"), "window_ft": req.get("window_ft"),
            "quick": req.get("quick"), "curves": len(req.get("curves") or []), "lines": len(req.get("lines") or []),
            "base_job_id": req.get("base_job_id"), "misfit_normalised": misfit,
            "stations": stations, "boundaries": boundaries, "source": getattr(job, "source", "computed")}
