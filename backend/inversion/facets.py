"""3D facet inversion: windowed dipping-layer fits with a free dip azimuth, driven by all four image quadrants.

Each window is a planar TIV layer stack (as in the 1.5D inversion) whose bed normal may tilt across the well as well as
along it. Top/bottom quadrants place boundaries above or below the well; right/left quadrants tilt them sideways.
Windows overlap by half and warm-start from their neighbour. Every window reports its boundaries as planar facets in a
corridor of +/- ``CORRIDOR_M`` around the well, which is about the ADR depth of detection. This is rung 3a of
docs/inversion/ADR_2D5_3D_plan.md; it runs alongside the 1D/1.5D inversion in ``backend.inversion.service``.

Orientation caveat: right/left assume image bin 8 looks right of the tool looking downhole (``rotation=1``), which the
vendor has not confirmed; ``rotation=-1`` mirrors every facet across the well.
"""

from __future__ import annotations

from dataclasses import replace
import threading
import time
import uuid

import numpy as np

from backend.inversion import service
from backend.inversion.adr_forward import FT, ADRForward
from backend.inversion.invert import (FitConfig, Inverter, LevelCorrection, Z20_ATTENUATION_CORRECTION,
                                      default_starts, interval_from_run, noise_estimate)

SIDES = ("T", "R", "B", "L")
GEO_SIDES = ("T", "R", "L")     # bin minus the all-bin mean: bottom tracks top, but right and left differ off-axis
KIND = {"T": "top", "R": "right", "B": "bottom", "L": "left"}
CORRIDOR_M = 6.0
# Ekofisk chalk beds can dip steeply relative to the well (e.g. Z-20); the 1.5D default of 15 degrees is too tight.
DEFAULT_MAX_DIP_DEG = 45.0
MAX_INTERVAL_FT = 1000.0
MAX_WINDOWS = 30
MIN_STATIONS = 6
ATTENUATION_CORRECTION = {**service.ATTENUATION_CORRECTION,
                          **{f"ZR{lab[2:]}{s}": v for lab, v in Z20_ATTENUATION_CORRECTION.items() for s in SIDES}}


def forward_options(rotation: int = 1) -> dict:
    return {"zr_sides": SIDES, "zg_sides": GEO_SIDES, "rotation": rotation}


def channel_labels() -> list[str]:
    return ADRForward(azimuthal=True, **forward_options()).channel_labels()


def build_plan(run, curves: list[str], calibration: bool = True) -> dict:
    """The 1.5D plan for the same selection, extended with right/left quadrants of every ZR and ZG image. A directly
    selected ``ZR..L``/``ZR..R`` curve brings in its whole image."""
    labels = channel_labels()
    expanded = []
    for name in curves:
        zr = service.ZR_CURVE.fullmatch(name)
        expanded.append(name[:-1] if zr and zr[4] in ("L", "R") and name[:-1] in run.curves else name)
    base = service.build_plan(run, list(dict.fromkeys(expanded)), calibration)
    used = {u["label"]: {**u, "side": None if u["kind"] == "avg" else u["label"][-1]} for u in base["used"]}
    sources = dict(base["_sources"])
    for entry in list(used.values()):
        src = sources[entry["label"]]
        if not isinstance(src, tuple):
            continue
        extra = ("R", "L") if entry["kind"] in ("top", "geosignal") else ()
        for side in extra:
            label = entry["label"][:-1] + side
            if label in labels and label not in used:
                kind = entry["kind"] if entry["kind"] == "geosignal" else KIND[side]
                used[label] = {**entry, "label": label, "kind": kind, "side": side, "source": f"{src[0]} {side} sector"}
                sources[label] = (src[0], side)
    entries = sorted(used.values(), key=lambda e: labels.index(e["label"]))
    ignored = [i for i in base["ignored"] if "left/right" not in i["reason"]]
    warnings = list(base["warnings"])
    if not any(e["side"] in ("R", "L") for e in entries):
        warnings.append("No right/left quadrants: the facets cannot tilt sideways. Select ZR images (16/32/48 in) in QC.")
    return {"used": entries, "ignored": ignored, "calibration": calibration, "warnings": warnings,
            "azimuthal": True, "_sources": {e["label"]: sources[e["label"]] for e in entries}}


def window_centres(md_min: float, md_max: float, width: float) -> np.ndarray:
    """Centres of half-overlapping windows covering [md_min, md_max]."""
    span = md_max - md_min
    if span <= width:
        return np.array([0.5 * (md_min + md_max)])
    n = int(np.ceil((span - width) / (width / 2))) + 1
    return np.linspace(md_min + width / 2, md_max - width / 2, n)


def suggested_interval(run) -> dict:
    if "Z-20" in str(run.well) or "Z-20" in run.path.name:
        return {"md_min_ft": 22200.0, "md_max_ft": 22600.0,
                "reason": "Z-20: strongest off-axis geosignal (22368-22400 ft) inside a transition cluster"}
    md = run.curves["DEPT"]
    mid = float(np.nanmedian(md))
    return {"md_min_ft": round(mid - 200), "md_max_ft": round(mid + 200), "reason": "400 ft around mid-run"}


# ---------------------------------------------------------------------------- jobs (shared slot with 1.5D)
def submit(run_id: str, run, request: dict) -> service.Job:
    plan = build_plan(run, request["curves"], request["calibration"])
    if not plan["used"]:
        raise ValueError("none of the selected curves can be inverted; select AR, ZR (16/32/48 in) or ZG curves in QC")
    job = service.Job(uuid.uuid4().hex[:12], run_id, request, plan)
    with service._jobs_lock:
        service._jobs[job.id] = job
    threading.Thread(target=_execute, args=(job, run), daemon=True).start()
    return job


def _execute(job: service.Job, run) -> None:
    with service._slot:
        job.status, job.started, job.message = "running", time.time(), "loading interval"
        try:
            job.result = run_facets(run, job.request, job.plan, job)
            job.status, job.progress, job.message = "done", 1.0, "finished"
        except Exception as exc:  # reported to the client, not raised in the thread
            job.status, job.error, job.message = "error", f"{type(exc).__name__}: {exc}", "failed"
        finally:
            job.finished = time.time()


# ---------------------------------------------------------------------------- inversion
def _normalised_misfit(residual, sigma, weights):
    cols = np.flatnonzero(weights > 0)
    return float(np.sqrt(np.mean((residual[:, cols] / sigma[cols]) ** 2))) if cols.size else float("nan")


def remove_lateral_offset(data, labels, used) -> dict:
    """Remove each ZR and ZG image's interval-median right/left contrast, in place.

    On Z-20 every ZR image reads right ~17 % below left at all spacings and frequencies, including 16 in at 2 MHz,
    whose depth of investigation is a few inches; top/bottom shows no such offset. A bed cannot do that, so the offset
    is treated as a tool/borehole effect (e.g. eccentricity). Lateral *changes* along the interval are kept. ZR
    contrasts are in log10 ohm-m, geosignal contrasts in deg/dB.
    """
    idx = {lab: j for j, lab in enumerate(labels)}
    valid = data.valid if data.valid is not None else np.ones_like(data.obs, bool)
    offsets = {}
    for lab in used:
        if lab.startswith(("ZR", "ZG")) and lab.endswith("R") and lab[:-1] + "L" in used:
            r, left = idx[lab], idx[lab[:-1] + "L"]
            ok = valid[:, r] & valid[:, left]
            if ok.sum() >= 3:
                d = float(np.median(data.obs[ok, r] - data.obs[ok, left]))
                data.obs[:, r] -= d / 2
                data.obs[:, left] += d / 2
                offsets[lab[:-1]] = ({"log10_right_over_left": round(d, 4), "right_over_left": round(10 ** d, 4)}
                                     if lab.startswith("ZR") else {"right_minus_left": round(d, 4), "unit": data.units[r]})
    return offsets


def run_facets(run, request: dict, plan: dict, job: service.Job | None = None) -> dict:
    opts = forward_options(request["rotation"])
    fwd = ADRForward(azimuthal=True, **opts)
    labels = fwd.channel_labels()
    used = {e["label"]: e for e in plan["used"]}
    sources = {lab: plan["_sources"].get(lab, lab) for lab in labels}
    data = interval_from_run(run, request["md_min_ft"], request["md_max_ft"], fwd, request["step_ft"], sources,
                             required=list(used))
    offsets = remove_lateral_offset(data, labels, used) if request.get("remove_lateral_offset", True) else {}
    weights = np.array([used[lab]["weight"] if lab in used else 0.0 for lab in labels])
    lc = LevelCorrection.from_table(labels, {lab: ATTENUATION_CORRECTION[lab] for lab in used
                                             if lab in ATTENUATION_CORRECTION}) if plan["calibration"] else None
    centres = window_centres(float(data.md_ft[0]), float(data.md_ft[-1]), request["window_ft"])
    if len(centres) > MAX_WINDOWS:
        raise ValueError(f"{len(centres)} windows exceed {MAX_WINDOWS}; shorten the interval or widen the windows")
    k, nfev = request["layers"], 8 if request["quick"] else 15
    budget = len(centres) * nfev * (2 if request["compare"] else 1) + 2 * nfev
    count = [0]

    def tick():
        count[0] += 1
        if job is not None:
            job.progress = min(0.99, count[0] / budget)
            job.message = f"window {current[0] + 1}/{len(centres)} · forward evaluation {count[0]}"

    current = [0]
    t0 = time.time()
    n, m = data.obs.shape
    pred = np.full((n, m), np.nan)
    owner = np.argmin(np.abs(data.md_ft[:, None] - centres[None, :]), axis=1)
    windows, x_prev = [], None
    for w, c in enumerate(centres):
        current[0] = w
        mask = np.abs(data.md_ft - c) <= request["window_ft"] / 2 + 1e-6
        if mask.sum() < MIN_STATIONS:
            continue
        sub = data.subset(mask)
        sigma = np.array([service.SIGMA_FLOOR[u] if lab.startswith("AR")
                          else noise_estimate(sub.obs[:, j], service.SIGMA_FLOOR[u])
                          for j, (lab, u) in enumerate(zip(labels, sub.units))])
        cfg = FitConfig(n_layers=k, azimuthal=True, fit_dip=True, fit_cross_dip=True, forward_options=opts,
                        dip_limit_deg=request.get("max_dip_deg", DEFAULT_MAX_DIP_DEG),
                        curve_weights=dict(zip(labels, weights)), curve_sigma=dict(zip(labels, sigma)),
                        level_correction=lc, max_nfev=nfev)
        with Inverter(sub, cfg, workers=service.WORKERS, on_eval=tick) as inv:
            res = inv.fit(x_prev) if x_prev is not None else None
            if res is None or _normalised_misfit(res.residual, sigma, weights) > 3:
                fresh = inv.multistart(default_starts(inv, sub, k, weights=weights))
                res = fresh if res is None or fresh.cost < res.cost else res
        x_prev = res.x
        facet = _facet(data, sub, res, c, request["window_ft"], k)
        facet["misfit_normalised"] = round(_normalised_misfit(res.residual, sigma, weights), 2)
        if request["compare"]:
            cfg15 = replace(cfg, fit_cross_dip=False)
            with Inverter(sub, cfg15, workers=service.WORKERS, on_eval=tick) as inv:
                r15 = inv.fit(res.x[:inv.lay.n_earth])
            facet["misfit_normalised_1d5"] = round(_normalised_misfit(r15.residual, sigma, weights), 2)
        windows.append(facet)
        rows = np.flatnonzero(mask)
        keep = owner[rows] == w
        pred[rows[keep]] = res.pred[keep]
    return _serialize(data, labels, used, weights, pred, windows, request, time.time() - t0, offsets)


def _facet(data, sub, res, centre_md, width_ft, k) -> dict:
    model, ref = res.model, data.ref_ned
    nrm = model.normal()
    i = int(np.argmin(np.abs(sub.md_ft - centre_md)))
    p = sub.traj.ned[i]
    heading = np.array([sub.traj.axis[:, 0].mean(), sub.traj.axis[:, 1].mean()])
    heading /= np.linalg.norm(heading)
    right = np.array([-heading[1], heading[0]])

    def z_at(north, east, b):
        return b - (nrm[0] * north + nrm[1] * east) / nrm[2]

    half = 0.5 * width_ft * FT
    corners_uv = [(-half, -CORRIDOR_M), (half, -CORRIDOR_M), (half, CORRIDOR_M), (-half, CORRIDOR_M)]
    boundaries = []
    for j, b in enumerate(model.boundaries_m):
        corners = []
        for u, v in corners_uv:
            ne = p[:2] + u * heading + v * right
            corners.append([round(float(ne[1] + ref[1]), 2), round(float(ne[0] + ref[0]), 2),
                            round(float((z_at(ne[0], ne[1], b) + ref[2]) / FT), 2)])
        z_well = z_at(p[0], p[1], b)
        z_left, z_right = (z_at(*(p[:2] + s * CORRIDOR_M * right), b) for s in (-1, 1))
        boundaries.append({
            "index": j, "above_layer": j, "below_layer": j + 1,
            "tvd_at_well_ft": round(float((z_well + ref[2]) / FT), 2),
            "distance_from_well_ft": round(float((z_well - p[2]) / FT), 2),   # > 0: boundary below the well
            "rise_to_right_ft": round(float((z_left - z_right) / FT / 2), 2),  # per CORRIDOR_M to the right
            "corners_e_n_tvd": corners,
        })
    x = res.x
    nearth = len(x)
    along, cross = float(x[nearth - 2]), float(x[nearth - 1])
    return {
        "md_centre_ft": round(float(centre_md), 1),
        "md_min_ft": round(float(sub.md_ft[0]), 1), "md_max_ft": round(float(sub.md_ft[-1]), 1),
        "well_e_n_tvd": [round(float(p[1] + ref[1]), 2), round(float(p[0] + ref[0]), 2),
                         round(float((p[2] + ref[2]) / FT), 2)],
        "dip_deg": round(float(model.dip_deg), 2), "dip_azimuth_deg": round(float(model.dip_azimuth_deg % 360), 1),
        "along_dip_deg": round(along, 2), "cross_dip_deg": round(cross, 2),
        "layers": [{"rh": round(float(rh), 3), "rv": round(float(rv), 3)} for rh, rv in zip(model.rh, model.rv)],
        "boundaries": boundaries,
    }


def _none(values) -> list:
    return [None if v is None or not np.isfinite(v) else round(float(v), 4) for v in values]


def _serialize(data, labels, used, weights, pred, windows, request, elapsed, offsets=None) -> dict:
    units = data.units
    valid = data.valid if data.valid is not None else np.ones_like(data.obs, bool)
    curves = []
    for j, lab in enumerate(labels):
        if lab not in used:
            continue
        log = units[j] == "log"
        conv = (lambda v: 10 ** v) if log else (lambda v: v)
        ok = valid[:, j] & np.isfinite(pred[:, j])
        r = data.obs[ok, j] - pred[ok, j]
        e = used[lab]
        curves.append({"label": lab, "curve": e["curve"], "kind": e["kind"], "side": e["side"],
                       "measurement": e["measurement"], "frequency_hz": e["frequency_hz"], "spacing_in": e["spacing_in"],
                       "unit": "ohm.m" if log else units[j], "weight": float(weights[j]), "source": e["source"],
                       "obs": _none(np.where(valid[:, j], conv(data.obs[:, j]), np.nan)), "pred": _none(conv(pred[:, j])),
                       "rms": round(float(np.sqrt(np.mean(r ** 2))), 4) if r.size else None})
    traj = data.traj
    ref = data.ref_ned
    return {
        "well": data.well,
        "md_ft": _none(data.md_ft), "tvd_ft": _none(data.tvd_ft),
        "path_e_n_tvd": [[round(float(p[1] + ref[1]), 2), round(float(p[0] + ref[0]), 2),
                          round(float((p[2] + ref[2]) / FT), 2)] for p in traj.ned],
        "curves": curves,
        "windows": windows,
        "corridor_m": CORRIDOR_M,
        "rotation": request["rotation"],
        "lateral_offsets_removed": offsets or {},
        "orientation_note": ("right/left assume image bin 8 looks right of the tool looking downhole (not vendor "
                             "confirmed)" + ("; mirrored (rotation -1)" if request["rotation"] == -1 else "")),
        "stations": int(len(data.md_ft)), "elapsed_s": round(elapsed, 1),
    }
