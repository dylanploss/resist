"""Inversion jobs driven by the QC curve selection.

The QC page picks curves; this module maps them onto the 1.5D forward model:

* ``AR`` averaged resistivities are inverted. A ``C`` variant (``ARH16PC``) uses the vendor-corrected curve for the
  same channel. Phase curves get weight 1. With ``calibration`` on, attenuation curves are down-weighted and
  2 MHz attenuation receives the Z-20 resistivity-dependent correction (docs/inversion/HACKATHON_PLAN.md).
* ``ZR``/``ZG`` azimuthal curves and conventional logs are listed as ignored with a reason.

Jobs run one at a time in a background thread because each uses a process pool.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
import threading
import time
import uuid

import numpy as np

from backend.data.loader import measurement_metadata
from backend.inversion.adr_forward import FT, ADRForward
from backend.inversion.invert import (FitConfig, Inverter, LevelCorrection, Z20_ATTENUATION_CORRECTION,
                                      default_starts, interval_from_run)

AR_CURVE = re.compile(r"^(AR[HML]\d+)([PA])(C?)$")
CALIBRATED_ATTENUATION_WEIGHT = {2_000_000: 0.5, 500_000: 0.25, 125_000: 0.25}
WORKERS = 6
MAX_STATIONS = 250
MAX_INTERVAL_FT = 1500.0


def channel_labels() -> list[str]:
    return ADRForward().channel_labels()


def build_plan(run, curves: list[str], calibration: bool = True) -> dict:
    labels = channel_labels()
    used: dict[str, dict] = {}
    ignored = []
    for name in curves:
        match = AR_CURVE.fullmatch(name)
        if name not in run.curves:
            ignored.append({"curve": name, "reason": "not in this run"})
            continue
        if not match:
            twin = re.fullmatch(r"ZR([HML]\d+[PA])", name)
            if twin and f"AR{twin[1]}" in run.curves:
                reason = (f"azimuthal image: not in the 1.5D model yet; its azimuthal average is AR{twin[1]} "
                          "- select that in QC to use this channel")
            elif name.startswith(("ZR", "ZG")):
                reason = "azimuthal image / geosignal: not in the 1.5D averaged-resistivity model yet"
            else:
                reason = "not an ADR averaged resistivity"
            ignored.append({"curve": name, "reason": reason})
            continue
        label = match[1] + match[2]
        if label not in labels:
            ignored.append({"curve": name, "reason": "no forward-model geometry for this spacing/frequency"})
            continue
        if label in used:
            ignored.append({"curve": name, "reason": f"same channel as {used[label]['curve']}"})
            continue
        meta = measurement_metadata(name)
        attenuation = meta["measurement"] == "attenuation"
        weight = CALIBRATED_ATTENUATION_WEIGHT[meta["frequency_hz"]] if attenuation and calibration else 1.0
        entry = {"curve": name, "label": label, "measurement": meta["measurement"],
                 "frequency_hz": meta["frequency_hz"], "spacing_in": meta["spacing_in"],
                 "vendor_corrected": bool(match[3]), "weight": weight, "correction": None}
        if calibration and label in Z20_ATTENUATION_CORRECTION:
            a, g = Z20_ATTENUATION_CORRECTION[label]
            entry["correction"] = {"a": a, "g": g, "factor_at_10_ohmm": round(10 ** a, 3),
                                   "factor_at_40_ohmm": round(10 ** (a + g * (np.log10(40) - 1)), 3)}
        used[label] = entry
    entries = sorted(used.values(), key=lambda e: labels.index(e["label"]))
    warnings = []
    if not any(e["measurement"] == "phase" for e in entries):
        warnings.append("No phase curve selected: phase is the best-calibrated data for this tool.")
    if len(entries) < 3:
        warnings.append("Fewer than 3 usable curves: the layered model is poorly constrained.")
    return {"used": entries, "ignored": ignored, "calibration": calibration, "warnings": warnings}


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

    def to_dict(self) -> dict:
        end = self.finished or time.time()
        return {"id": self.id, "run": self.run, "status": self.status, "progress": round(self.progress, 3),
                "message": self.message, "request": self.request, "plan": self.plan, "error": self.error,
                "elapsed_s": round(end - (self.started or end), 1), "result": self.result}


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()
_slot = threading.Semaphore(1)


def submit(run_id: str, run, request: dict) -> Job:
    plan = build_plan(run, request["curves"], request["calibration"])
    if not plan["used"]:
        raise ValueError("none of the selected curves can be inverted; select AR phase/attenuation curves in QC")
    job = Job(uuid.uuid4().hex[:12], run_id, request, plan)
    with _jobs_lock:
        _jobs[job.id] = job
    threading.Thread(target=_execute, args=(job, run), daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    with _jobs_lock:
        return _jobs.get(job_id)


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
    fwd = ADRForward()
    labels = fwd.channel_labels()
    used = {e["label"]: e for e in plan["used"]}
    sources = {lab: used[lab]["curve"] if lab in used else lab for lab in labels}
    data = interval_from_run(run, request["md_min_ft"], request["md_max_ft"], fwd, request["step_ft"],
                             sources, required=list(used))
    if len(data.md_ft) > MAX_STATIONS:
        raise ValueError(f"{len(data.md_ft)} stations exceed {MAX_STATIONS}; shorten the interval or increase the step")
    weights = {lab: used[lab]["weight"] if lab in used else 0.0 for lab in labels}
    w = np.array([weights[lab] for lab in labels])
    lc = LevelCorrection.from_table(labels, {lab: Z20_ATTENUATION_CORRECTION[lab] for lab in used
                                             if lab in Z20_ATTENUATION_CORRECTION}) if plan["calibration"] else None
    k = request["layers"]
    fine_nfev = 10 if request["quick"] else 20
    coarse = len(data.md_ft) > 60
    budget = (3 * 8 if coarse else 3 * fine_nfev) + (fine_nfev if coarse else 0)
    count = [0]

    def tick():
        count[0] += 1
        if job is not None:
            job.progress = min(0.99, count[0] / budget)
            job.message = f"forward evaluation {count[0]} (~{budget} expected)"

    t0 = time.time()
    cfg = FitConfig(n_layers=k, curve_weights=weights, level_correction=lc, max_nfev=fine_nfev)
    x0 = None
    if coarse:
        sub = data.subset(np.arange(len(data.md_ft)) % 2 == 0)
        cfg_c = FitConfig(n_layers=k, curve_weights=weights, level_correction=lc, max_nfev=8)
        with Inverter(sub, cfg_c, workers=WORKERS, on_eval=tick) as inv:
            x0 = inv.multistart(default_starts(inv, sub, k, weights=w)).x
    with Inverter(data, cfg, workers=WORKERS, on_eval=tick) as inv:
        res = inv.fit(x0) if x0 is not None else inv.multistart(default_starts(inv, data, k, weights=w))
    return serialize(data, res, w, lc, time.time() - t0)


def _none(values) -> list:
    return [None if v is None or not np.isfinite(v) else round(float(v), 4) for v in values]


def serialize(data, res, weights, lc, elapsed) -> dict:
    m = res.model
    n = m.normal()
    ned = data.traj.ned
    shift = (ned[:, 0] * n[0] + ned[:, 1] * n[1]) / n[2]
    ref_z = data.ref_ned[2]
    boundary_tvd = [((b - shift) + ref_z) / FT for b in m.boundaries_m]
    tops = [None] + [(b + ref_z) / FT for b in m.boundaries_m]
    bottoms = [(b + ref_z) / FT for b in m.boundaries_m] + [None]
    valid = data.valid if data.valid is not None else np.ones_like(data.obs, bool)
    curves = []
    used_res = []
    for j, lab in enumerate(data.labels):
        ok = valid[:, j]
        r = res.residual[ok, j]
        obs = np.where(ok, 10 ** data.obs[:, j], np.nan)
        entry = {"label": lab, "measurement": "phase" if lab.endswith("P") else "attenuation",
                 "used": bool(weights[j] > 0), "weight": float(weights[j]),
                 "correction_applied": bool(lc is not None and (lc.a[j] or lc.g[j])),
                 "obs": _none(obs), "pred": _none(10 ** res.pred[:, j]),
                 "theory": _none(10 ** res.theory[:, j]),
                 "rms_percent": round(float(100 * (10 ** np.sqrt(np.mean(r ** 2)) - 1)), 2) if r.size else None,
                 "mean_residual_percent": round(float(100 * (10 ** np.mean(r) - 1)), 2) if r.size else None}
        curves.append(entry)
        if weights[j] > 0:
            used_res.append(r)
    used_res = np.concatenate(used_res) if used_res else np.array([])
    return {
        "well": data.well,
        "md_ft": _none(data.md_ft), "tvd_ft": _none(data.tvd_ft),
        "inclination_deg": _none(np.rad2deg(np.arccos(np.clip(data.traj.axis[:, 2], -1, 1)))),
        "curves": curves,
        "model": {
            "layers": [{"rh": round(float(rh), 3), "rv": round(float(rv), 3),
                        "top_tvd_ft": None if t is None else round(t, 2),
                        "bottom_tvd_ft": None if b is None else round(b, 2)}
                       for rh, rv, t, b in zip(m.rh, m.rv, tops, bottoms)],
            "dip_deg": round(float(m.dip_deg), 2), "dip_azimuth_deg": round(float(m.dip_azimuth_deg), 1),
            "reference_note": "layer tops/bottoms are TVD at the window centre; boundaries dip along the well azimuth",
            "boundary_tvd_ft": [_none(b) for b in boundary_tvd],
        },
        "rms_percent_used": round(float(100 * (10 ** np.sqrt(np.mean(used_res ** 2)) - 1)), 2) if used_res.size else None,
        "stations": int(len(data.md_ft)), "forward_evaluations": int(res.nfev), "elapsed_s": round(elapsed, 1),
    }
