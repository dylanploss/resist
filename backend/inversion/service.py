"""Inversion jobs driven by the QC curve selection.

The QC page picks curves; this module maps them onto the 1.5D forward model (``backend.inversion.adr_forward``):

* ``AR`` averaged resistivities are used as is; a ``C`` variant (``ARH16PC``) uses the vendor-corrected curve.
* A ``ZR`` image at 16/32/48 in contributes its **top and bottom** quadrants, extracted from the image as 90-degree
  sectors (``backend.data.quadrants``) for every run, so data and forward model use the same definition. Selecting
  ``ZR..T``/``ZR..B`` directly uses the image sector when the image exists, else the delivered curve. These carry the
  up/down information that places boundaries above or below the well.
* A ``ZG`` geosignal image contributes its **top** quadrant sector (phase in deg, attenuation in dB).
* ``ZR`` 50/66/82 in long-spacing images contribute top/bottom sectors on a **guessed** antenna geometry
  (``adr_forward.LS_RECEIVER_IN``), at half weight and with a plan warning.
* Phase weight 1. With ``calibration`` on, attenuation is down-weighted and 2 MHz attenuation (averaged and
  top/bottom) gets the Z-20 resistivity-dependent correction (docs/inversion/HACKATHON_PLAN.md).
* Single bins and geosignals are weighted by their own noise, estimated from the data in the interval.
* ``ZR`` left/right bins and conventional logs are listed as ignored with a reason.

Jobs run one at a time in a background thread because each uses a process pool. The interval is cut into slices
(default 4 ft); each slice is a separate 1.5D fit on a sliding data window centred on it (default 20 ft), warm-started
from its neighbour, so neighbouring windows overlap and the curtain can show their mean.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
import threading
import time
from types import SimpleNamespace
import uuid

import numpy as np

from backend.inversion.adr_forward import FT, FREQ_LETTER, LS_RECEIVER_IN, ADRForward
from backend.inversion.invert import (FitConfig, Inverter, LevelCorrection, Z20_ATTENUATION_CORRECTION,
                                      default_starts, interval_from_run, noise_estimate, worker_pool)

AR_CURVE = re.compile(r"^AR([HML])(\d+)([PA])(C?)$")
ZR_CURVE = re.compile(r"^ZR([HML])(\d+)([PA])([TBLR]?)$")
ZG_CURVE = re.compile(r"^ZG([HML])(\d+)([PA])$")
FREQ_HZ = {letter: f for f, letter in FREQ_LETTER.items()}
CALIBRATED_ATTENUATION_WEIGHT = {2e6: 0.5, 5e5: 0.25, 1.25e5: 0.25}
GEOSIGNAL_WEIGHT = {"ZGL112AT": 0.25}  # 125 kHz attenuation geosignal barely tracks ZR top/bottom (r < 0.16)
GUESSED_GEOMETRY_WEIGHT = 0.5           # ZR 50/66/82 in: antenna layout guessed, uncompensated
LS_SPACINGS = (50, 66, 82)
SIGMA_FLOOR = {"log": 0.02, "deg": 0.5, "dB": 0.05}
WORKERS = 6
MAX_STATIONS = 250
MAX_INTERVAL_FT = 1500.0
# Each slice of the curtain is its own 1.5D fit on a sliding data window centred on it.
DEFAULT_SLICE_FT = 4.0
DEFAULT_WINDOW_FT = 20.0
MAX_SLICES = 300
MIN_WINDOW_STATIONS = 3

# The 2 MHz attenuation bias is a property of the channel, so it applies to its top/bottom bins too.
ATTENUATION_CORRECTION = {**Z20_ATTENUATION_CORRECTION,
                          **{f"ZR{lab[2:]}{b}": v for lab, v in Z20_ATTENUATION_CORRECTION.items() for b in "TB"}}


def channel_labels(azimuthal: bool = True) -> list[str]:
    return ADRForward(azimuthal=azimuthal).channel_labels()


def _ignore_reason(name: str) -> str:
    zr = ZR_CURVE.fullmatch(name)
    if zr and zr[4] in "LR" and zr[4]:
        return "left/right bin: carries no up/down information in a 1.5D (layered) model"
    if zr or ZG_CURVE.fullmatch(name) or AR_CURVE.fullmatch(name):
        return f"no forward-model geometry for this spacing/frequency ({name})"
    return "not an ADR resistivity measurement (context log)"


def _targets(run, name):
    """[(label, source, kind)] that a selected curve contributes, or [] if it cannot be modelled."""
    ar, zr, zg = AR_CURVE.fullmatch(name), ZR_CURVE.fullmatch(name), ZG_CURVE.fullmatch(name)
    if ar:
        return [(f"AR{ar[1]}{ar[2]}{ar[3]}", name, "avg")]
    if zr and zr[4] in ("T", "B"):
        image = name[:-1]
        return [(name, (image, zr[4]) if image in run.curves else name, "top" if zr[4] == "T" else "bottom")]
    if zr and not zr[4]:
        return [(f"{name}{side}", (name, side), kind) for side, kind in (("T", "top"), ("B", "bottom"))]
    if zg:
        return [(f"{name}T", (name, "T"), "geosignal")]
    return []


def build_plan(run, curves: list[str], calibration: bool = True) -> dict:
    """Map QC-selected curves onto forward-model labels (first selection of a label wins)."""
    labels = channel_labels(azimuthal=True)
    used: dict[str, dict] = {}
    ignored = []
    for name in curves:
        if name not in run.curves:
            ignored.append({"curve": name, "reason": "not in this run"})
            continue
        targets = [t for t in _targets(run, name) if t[0] in labels]
        if not targets:
            ignored.append({"curve": name, "reason": _ignore_reason(name)})
            continue
        fresh = [t for t in targets if t[0] not in used]
        if not fresh:
            ignored.append({"curve": name, "reason": f"same channel as {used[targets[0][0]]['curve']}"})
            continue
        for label, source, kind in fresh:
            letter, measurement = label[2], "phase" if label[-1 if kind == "avg" else -2] == "P" else "attenuation"
            freq = FREQ_HZ[letter]
            spacing = int(re.match(r"\D+(\d+)", label[2:])[1])
            guessed = kind in ("top", "bottom") and spacing in LS_SPACINGS
            if kind == "geosignal":
                weight = GEOSIGNAL_WEIGHT.get(label, 1.0)
            elif measurement == "attenuation" and calibration:
                weight = CALIBRATED_ATTENUATION_WEIGHT[freq]
            else:
                weight = 1.0
            if guessed:
                weight *= GUESSED_GEOMETRY_WEIGHT
            entry = {"curve": name, "label": label, "kind": kind, "measurement": measurement,
                     "frequency_hz": freq, "spacing_in": spacing, "guessed_geometry": guessed,
                     "source": source if isinstance(source, str) else f"{source[0]} {source[1]} sector",
                     "vendor_corrected": kind == "avg" and name.endswith("C"), "weight": weight, "correction": None}
            if calibration and label in ATTENUATION_CORRECTION:
                a, g = ATTENUATION_CORRECTION[label]
                entry["correction"] = {"a": a, "g": g, "factor_at_10_ohmm": round(10 ** a, 3),
                                       "factor_at_40_ohmm": round(10 ** (a + g * (np.log10(40) - 1)), 3)}
            entry["_source"] = source
            used[label] = entry
    entries = sorted(used.values(), key=lambda e: labels.index(e["label"]))
    warnings = []
    directional = [e for e in entries if e["kind"] != "avg"]
    if not any(e["measurement"] == "phase" and e["kind"] != "geosignal" for e in entries):
        warnings.append("No phase resistivity selected: phase is the best-calibrated data for this tool.")
    if not directional:
        warnings.append("No ZR top/bottom or ZG geosignal selected: the inversion cannot tell whether a boundary is "
                        "above or below the well.")
    if len(entries) < 3:
        warnings.append(f"Only {len(entries)} usable channels from {len(curves)} selected curves: the layered model "
                        "is poorly constrained.")
    guessed = sorted({e["curve"] for e in entries if e["guessed_geometry"]})
    if guessed:
        warnings.append(f"Guessed geometry for {', '.join(guessed)}: the 50/66/82 in long-spacing antenna layout is "
                        f"not confirmed. The model assumes the 16/32/48 in uphole transmitters and a tilted receiver "
                        f"{LS_RECEIVER_IN:.0f} in downhole of the tool centre, uncompensated. These channels get half "
                        "weight; check their misfit, and treat boundaries they alone resolve with caution.")
    public = [{k: v for k, v in e.items() if k != "_source"} for e in entries]
    return {"used": public, "ignored": ignored, "calibration": calibration, "warnings": warnings,
            "azimuthal": bool(directional), "_sources": {e["label"]: e["_source"] for e in entries}}


def suggested_interval(run) -> dict:
    md = run.curves["DEPT"]
    if "Z-20" in str(run.well) or "Z-20" in run.path.name:
        return {"md_min_ft": 20100.0, "md_max_ft": 20500.0, "reason": "Z-20 calibration interval"}
    mid = float(np.nanmedian(md))
    return {"md_min_ft": round(mid - 200), "md_max_ft": round(mid + 200), "reason": "400 ft around mid-run"}


@dataclass
class Job:
    id: str
    run: str
    request: dict
    plan: dict
    status: str = "queued"
    progress: float = 0.0
    message: str = "waiting for a free inversion slot"
    result: dict | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    partial: dict | None = None        # best model so far while running (live cross-section)

    def to_dict(self) -> dict:
        end = self.finished or time.time()
        return {"id": self.id, "run": self.run, "status": self.status, "progress": round(self.progress, 3),
                "message": self.message, "request": self.request, "plan": public_plan(self.plan),
                "error": self.error, "elapsed_s": round(end - (self.started or end), 1), "result": self.result,
                "partial": self.partial if self.status == "running" else None}


def public_plan(plan: dict) -> dict:
    return {k: v for k, v in plan.items() if not k.startswith("_")}


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()
_slot = threading.Semaphore(1)


def submit(run_id: str, run, request: dict) -> Job:
    plan = build_plan(run, request["curves"], request["calibration"])
    if not plan["used"]:
        raise ValueError("none of the selected curves can be inverted; select AR, ZR (16/32/48 in) or ZG curves in QC")
    job = Job(uuid.uuid4().hex[:12], run_id, request, plan)
    with _jobs_lock:
        _jobs[job.id] = job
    threading.Thread(target=_execute, args=(job, run), daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def finished_jobs(run_id: str) -> list[Job]:
    """Completed jobs of a run, newest first."""
    with _jobs_lock:
        done = [j for j in _jobs.values() if j.run == run_id and j.status == "done"]
    return sorted(done, key=lambda j: j.finished or 0, reverse=True)


def _execute(job: Job, run) -> None:
    with _slot:
        job.status, job.started, job.message = "running", time.time(), "loading interval"
        try:
            job.result = run_inversion(run, job.request, job.plan, job)
            job.status, job.progress, job.message = "done", 1.0, "finished"
        except Exception as exc:  # reported to the client, not raised in the thread
            job.status, job.error, job.message = "error", f"{type(exc).__name__}: {exc}", "failed"
        finally:
            job.finished = time.time()


def run_inversion(run, request: dict, plan: dict, job: Job | None = None) -> dict:
    azimuthal = plan["azimuthal"]
    fwd = ADRForward(azimuthal=azimuthal)
    labels = fwd.channel_labels()
    used = {e["label"]: e for e in plan["used"]}
    sources = {lab: plan["_sources"].get(lab, lab) for lab in labels}
    data = interval_from_run(run, request["md_min_ft"], request["md_max_ft"], fwd, request["step_ft"],
                             sources, required=list(used))
    if len(data.md_ft) > MAX_STATIONS:
        raise ValueError(f"{len(data.md_ft)} stations exceed {MAX_STATIONS}; shorten the interval or increase the step")
    weights = {lab: used[lab]["weight"] if lab in used else 0.0 for lab in labels}
    w = np.array([weights[lab] for lab in labels])
    # Averaged curves keep the 2% floor; single bins and geosignals are weighted by their own measured noise.
    sigma = {lab: SIGMA_FLOOR[u] if lab.startswith("AR") else noise_estimate(data.obs[:, j], SIGMA_FLOOR[u])
             for j, (lab, u) in enumerate(zip(labels, data.units))}
    lc = LevelCorrection.from_table(labels, {lab: ATTENUATION_CORRECTION[lab] for lab in used
                                             if lab in ATTENUATION_CORRECTION}) if plan["calibration"] else None
    k = request["layers"]
    slice_ft, window_ft = request.get("slice_ft", DEFAULT_SLICE_FT), request.get("window_ft", DEFAULT_WINDOW_FT)
    centres = slice_centres(float(data.md_ft[0]), float(data.md_ft[-1]), slice_ft)
    if len(centres) > MAX_SLICES:
        raise ValueError(f"{len(centres)} slices exceed {MAX_SLICES}; shorten the interval or widen the slices")
    nfev = 6 if request["quick"] else 12
    budget = len(centres) * nfev + 2 * nfev
    count, current = [0], [0]
    well_path = {"md_ft": _none(data.md_ft), "tvd_ft": _none(data.tvd_ft),
                 "inclination_deg": _none(np.rad2deg(np.arccos(np.clip(data.traj.axis[:, 2], -1, 1))))}

    def tick(inv, x, r):
        count[0] += 1
        if job is not None:
            job.progress = min(0.99, count[0] / budget)
            job.message = f"slice {current[0] + 1}/{len(centres)} · forward evaluation {count[0]}"

    t0 = time.time()
    cfg = FitConfig(n_layers=k, curve_weights=weights, curve_sigma=sigma, level_correction=lc, azimuthal=azimuthal,
                    max_nfev=nfev)
    pred = np.full(data.obs.shape, np.nan)
    owner = np.argmin(np.abs(data.md_ft[:, None] - centres[None, :]), axis=1)
    slices, models, x_prev, chi_prev, total_nfev = [], {}, None, np.inf, 0
    with worker_pool(data.traj, WORKERS, azimuthal=azimuthal) as pool:
        for s, c in enumerate(centres):
            current[0] = s
            idx = np.flatnonzero(np.abs(data.md_ft - c) <= window_ft / 2 + 1e-6)
            if idx.size < MIN_WINDOW_STATIONS:
                continue
            sub = data.subset(idx)
            with Inverter(sub, cfg, on_eval=tick, pool=pool, station_idx=idx) as inv:
                res = None
                if x_prev is not None:
                    try:
                        res = inv.fit(x_prev)
                    except ValueError:
                        res = None
                chi = _chi(res, sigma, labels, w) if res is not None else np.inf
                # Warm start from the previous slice; restart only when it clearly failed to fit this window.
                if res is None or chi > 1.5 * chi_prev:
                    fresh = inv.multistart(default_starts(inv, sub, k, weights=w))
                    if res is None or fresh.cost < res.cost:
                        res, chi = fresh, _chi(fresh, sigma, labels, w)
            x_prev, chi_prev = res.x, chi
            total_nfev += res.nfev
            models[s] = res.model
            mine = owner[idx] == s
            pred[idx[mine]] = res.pred[mine]
            slices.append(_slice_entry(data, res.model, idx, c, slice_ft, chi))
            if job is not None:
                job.partial = {**well_path, "slice_ft": slice_ft, "window_ft": window_ft, "slices": list(slices),
                               "evaluation": count[0], "slice": s + 1, "n_slices": len(centres),
                               "misfit_normalised": round(chi, 2)}
    if not slices:
        raise ValueError(f"no slice had {MIN_WINDOW_STATIONS} stations in its {window_ft:g} ft data window; "
                         "use a smaller station step or a wider window")
    obs = np.where(data.valid if data.valid is not None else True, data.obs, np.nan)
    combined = SimpleNamespace(pred=pred, residual=obs - pred, nfev=total_nfev, model=None)
    out = serialize(data, combined, w, sigma, lc, time.time() - t0, used,
                    model=summary_model(data, models, owner))
    return {**out, "slice_ft": slice_ft, "window_ft": window_ft, "slices": slices}


def slice_centres(md_min: float, md_max: float, slice_ft: float) -> np.ndarray:
    """Centres of back-to-back slices covering [md_min, md_max]."""
    n = max(1, int(np.ceil((md_max - md_min) / slice_ft - 1e-9)))
    return md_min + slice_ft * (np.arange(n) + 0.5)


def _chi(res, sigma, labels, w):
    cols = np.flatnonzero(w > 0)
    s = np.array([sigma[labels[j]] for j in cols])
    r = res.residual[:, cols] / s
    return float(np.sqrt(np.nanmean(r ** 2))) if r.size else float("nan")


def _slice_entry(data, model, idx, centre, slice_ft, chi) -> dict:
    """One slice: its layered model and the boundary TVDs at every station of its data window."""
    geom = model_geometry(data, model)
    return {"md_centre_ft": round(float(centre), 2),
            "slice_min_ft": round(float(centre - slice_ft / 2), 2), "slice_max_ft": round(float(centre + slice_ft / 2), 2),
            "window_min_ft": round(float(data.md_ft[idx[0]]), 2), "window_max_ft": round(float(data.md_ft[idx[-1]]), 2),
            "md_ft": _none(data.md_ft[idx]),
            "boundary_tvd_ft": [[b[i] for i in idx] for b in geom["boundary_tvd_ft"]],
            "layers": [{"rh": layer["rh"], "rv": layer["rv"]} for layer in geom["layers"]],
            "dip_deg": geom["dip_deg"], "dip_azimuth_deg": geom["dip_azimuth_deg"],
            "misfit_normalised": round(chi, 2) if np.isfinite(chi) else None}


def summary_model(data, models: dict, owner) -> dict:
    """Single-model view of a sliced result for the layer table and 3D well tab: median layer properties and dip,
    boundary TVDs at each station from the slice that owns it."""
    geoms = {s: model_geometry(data, m) for s, m in models.items()}
    keys = sorted(geoms)
    first = geoms[keys[0]]
    nb = len(first["boundary_tvd_ft"])
    nearest = [min(keys, key=lambda s: abs(s - o)) for o in owner]
    boundary = [[geoms[s]["boundary_tvd_ft"][j][i] for i, s in enumerate(nearest)] for j in range(nb)]

    def med(values):
        v = [x for x in values if x is not None]
        return round(float(np.median(v)), 3) if v else None

    layers = [{key: med([geoms[s]["layers"][i][key] for s in keys])
               for key in ("rh", "rv", "top_tvd_ft", "bottom_tvd_ft")} for i in range(len(first["layers"]))]
    return {"layers": layers,
            "dip_deg": med([g["dip_deg"] for g in geoms.values()]),
            "dip_azimuth_deg": med([g["dip_azimuth_deg"] for g in geoms.values()]),
            "reference_note": "median over slices; each slice is its own 1.5D model fitted on a sliding data window",
            "boundary_tvd_ft": boundary}


def _none(values) -> list:
    return [None if v is None or not np.isfinite(v) else round(float(v), 4) for v in values]


def _curve_meta(lab):
    """Display group (one log track per spacing/frequency, one per geosignal) and kind of a label."""
    if lab.startswith("ZG"):
        return lab[:-1], "geosignal", "phase" if lab[-2] == "P" else "attenuation"
    kind = "avg" if lab.startswith("AR") else "top" if lab.endswith("T") else "bottom"
    m = lab[-1] if kind == "avg" else lab[-2]
    return lab[2:5].rstrip("PA") if kind == "avg" else lab[2:-2], kind, "phase" if m == "P" else "attenuation"


def model_geometry(data, m) -> dict:
    """Layer table and per-station boundary TVDs (ft) of a layered model along the interval's well path."""
    n = m.normal()
    ned = data.traj.ned
    shift = (ned[:, 0] * n[0] + ned[:, 1] * n[1]) / n[2]
    ref_z = data.ref_ned[2]
    boundary_tvd = [((b - shift) + ref_z) / FT for b in m.boundaries_m]
    tops = [None] + [(b + ref_z) / FT for b in m.boundaries_m]
    bottoms = [(b + ref_z) / FT for b in m.boundaries_m] + [None]
    return {
        "layers": [{"rh": round(float(rh), 3), "rv": round(float(rv), 3),
                    "top_tvd_ft": None if t is None else round(t, 2),
                    "bottom_tvd_ft": None if b is None else round(b, 2)}
                   for rh, rv, t, b in zip(m.rh, m.rv, tops, bottoms)],
        "dip_deg": round(float(m.dip_deg), 2), "dip_azimuth_deg": round(float(m.dip_azimuth_deg), 1),
        "reference_note": "layer tops/bottoms are TVD at the window centre; boundaries dip along the well azimuth",
        "boundary_tvd_ft": [_none(b) for b in boundary_tvd],
    }


def serialize(data, res, weights, sigma, lc, elapsed, used=None, model=None) -> dict:
    m = res.model
    valid = data.valid if data.valid is not None else np.ones_like(data.obs, bool)
    units = data.units or ["log"] * len(data.labels)
    used = used or {}
    curves = []
    res_pct, chi = [], []
    for j, lab in enumerate(data.labels):
        ok = valid[:, j] & np.isfinite(res.residual[:, j])
        if not ok.any() and weights[j] == 0:
            continue
        r = res.residual[ok, j]
        log = units[j] == "log"
        conv = (lambda v: 10 ** v) if log else (lambda v: v)
        group, kind, measurement = _curve_meta(lab)
        entry = {"label": lab, "group": group, "kind": kind, "measurement": measurement,
                 "guessed_geometry": lab.startswith("ZR") and int(re.match(r"\D+(\d+)", lab[2:])[1]) in LS_SPACINGS,
                 "unit": "ohm.m" if log else units[j], "source": used.get(lab, {}).get("source", lab),
                 "used": bool(weights[j] > 0), "weight": float(weights[j]), "sigma": round(float(sigma[lab]), 4),
                 "correction_applied": bool(lc is not None and (lc.a[j] or lc.g[j])),
                 "obs": _none(np.where(ok, conv(data.obs[:, j]), np.nan)), "pred": _none(conv(res.pred[:, j])),
                 "rms_percent": round(float(100 * (10 ** np.sqrt(np.mean(r ** 2)) - 1)), 2) if log and r.size else None,
                 "rms": round(float(np.sqrt(np.mean(r ** 2))), 4) if r.size else None,
                 "rms_normalised": round(float(np.sqrt(np.mean((r / sigma[lab]) ** 2))), 2) if r.size else None,
                 "mean_residual_percent": round(float(100 * (10 ** np.mean(r) - 1)), 2) if log and r.size else None}
        curves.append(entry)
        if weights[j] > 0:
            chi.append(r / sigma[lab])
            if log:
                res_pct.append(r)
    res_pct = np.concatenate(res_pct) if res_pct else np.array([])
    chi = np.concatenate(chi) if chi else np.array([])
    return {
        "well": data.well,
        "md_ft": _none(data.md_ft), "tvd_ft": _none(data.tvd_ft),
        "inclination_deg": _none(np.rad2deg(np.arccos(np.clip(data.traj.axis[:, 2], -1, 1)))),
        "curves": curves,
        "model": model if model is not None else model_geometry(data, m),
        "rms_percent_used": round(float(100 * (10 ** np.sqrt(np.mean(res_pct ** 2)) - 1)), 2) if res_pct.size else None,
        "misfit_normalised": round(float(np.sqrt(np.mean(chi ** 2))), 2) if chi.size else None,
        "stations": int(len(data.md_ft)), "forward_evaluations": int(res.nfev), "elapsed_s": round(elapsed, 1),
    }
