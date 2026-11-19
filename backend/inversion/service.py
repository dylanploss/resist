"""Inversion jobs driven by the QC curve selection.

The QC page picks curves; this module maps them onto the 1.5D forward model (``backend.inversion.adr_forward``):

* ``AR`` averaged resistivities are used as is; a ``C`` variant (``ARH16PC``) uses the vendor-corrected curve.
* A ``ZR`` image at 16/32/48 in contributes its **top and bottom** bins (delivered ``ZR..T``/``ZR..B`` curves, or image
  bins 0 and 16 when a run lacks them); ``ZR..T``/``ZR..B`` curves can also be selected directly. These carry the
  up/down information that places boundaries above or below the well.
* A ``ZG`` geosignal image contributes its **top** bin (bin 0; phase in deg, attenuation in dB).
* Phase weight 1. With ``calibration`` on, attenuation is down-weighted and 2 MHz attenuation (averaged and
  top/bottom) gets the Z-20 resistivity-dependent correction (docs/inversion/HACKATHON_PLAN.md).
* Single bins and geosignals are weighted by their own noise, estimated from the data in the interval.
* ``ZR`` 50/66/82 in long-spacing images and conventional logs are listed as ignored with a reason.

Jobs run one at a time in a background thread because each uses a process pool.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
import threading
import time
import uuid

import numpy as np

from backend.inversion.adr_forward import FT, FREQ_LETTER, ADRForward
from backend.inversion.invert import (FitConfig, Inverter, LevelCorrection, Z20_ATTENUATION_CORRECTION,
                                      default_starts, interval_from_run, noise_estimate)

AR_CURVE = re.compile(r"^AR([HML])(\d+)([PA])(C?)$")
ZR_CURVE = re.compile(r"^ZR([HML])(\d+)([PA])([TBLR]?)$")
ZG_CURVE = re.compile(r"^ZG([HML])(\d+)([PA])$")
FREQ_HZ = {letter: f for f, letter in FREQ_LETTER.items()}
TOP_BIN, BOTTOM_BIN = 0, 16           # bin 1 = up, bin 17 = down (dossier); matches the delivered ZR T/B curves
CALIBRATED_ATTENUATION_WEIGHT = {2e6: 0.5, 5e5: 0.25, 1.25e5: 0.25}
GEOSIGNAL_WEIGHT = {"ZGL112AT": 0.25}  # 125 kHz attenuation geosignal barely tracks ZR top/bottom (r < 0.16)
SIGMA_FLOOR = {"log": 0.02, "deg": 0.5, "dB": 0.05}
WORKERS = 6
MAX_STATIONS = 250
MAX_INTERVAL_FT = 1500.0

# The 2 MHz attenuation bias is a property of the channel, so it applies to its top/bottom bins too.
ATTENUATION_CORRECTION = {**Z20_ATTENUATION_CORRECTION,
                          **{f"ZR{lab[2:]}{b}": v for lab, v in Z20_ATTENUATION_CORRECTION.items() for b in "TB"}}


def channel_labels(azimuthal: bool = True) -> list[str]:
    return ADRForward(azimuthal=azimuthal).channel_labels()


def _ignore_reason(name: str) -> str:
    zr = ZR_CURVE.fullmatch(name)
    if zr and zr[4] in "LR" and zr[4]:
        return "left/right bin: carries no up/down information in a 1.5D (layered) model"
    if zr or ZG_CURVE.fullmatch(name):
        return (f"no forward-model geometry for {name[2:]}: the 50/66/82 in long-spacing antenna layout is not "
                "confirmed" if zr else "no forward-model geometry for this geosignal spacing")
    if AR_CURVE.fullmatch(name):
        return "no forward-model geometry for this spacing/frequency"
    return "not an ADR resistivity measurement (context log)"


def _targets(run, name):
    """[(label, source, kind)] that a selected curve contributes, or [] if it cannot be modelled."""
    ar, zr, zg = AR_CURVE.fullmatch(name), ZR_CURVE.fullmatch(name), ZG_CURVE.fullmatch(name)
    if ar:
        return [(f"AR{ar[1]}{ar[2]}{ar[3]}", name, "avg")]
    if zr and zr[4] in ("T", "B"):
        return [(name, name, "top" if zr[4] == "T" else "bottom")]
    if zr and not zr[4]:
        out = []
        for side, b, kind in (("T", TOP_BIN, "top"), ("B", BOTTOM_BIN, "bottom")):
            label = f"{name}{side}"
            out.append((label, label if label in run.curves else (name, b), kind))
        return out
    if zg:
        return [(f"{name}T", (name, TOP_BIN), "geosignal")]
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
            if kind == "geosignal":
                weight = GEOSIGNAL_WEIGHT.get(label, 1.0)
            elif measurement == "attenuation" and calibration:
                weight = CALIBRATED_ATTENUATION_WEIGHT[freq]
            else:
                weight = 1.0
            entry = {"curve": name, "label": label, "kind": kind, "measurement": measurement,
                     "frequency_hz": freq, "spacing_in": int(re.match(r"\D+(\d+)", label[2:])[1]),
                     "source": source if isinstance(source, str) else f"{source[0]} bin {source[1]}",
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

    def to_dict(self) -> dict:
        end = self.finished or time.time()
        return {"id": self.id, "run": self.run, "status": self.status, "progress": round(self.progress, 3),
                "message": self.message, "request": self.request, "plan": public_plan(self.plan),
                "error": self.error, "elapsed_s": round(end - (self.started or end), 1), "result": self.result}


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
    common = dict(n_layers=k, curve_weights=weights, curve_sigma=sigma, level_correction=lc, azimuthal=azimuthal)
    x0 = None
    if coarse:
        sub = data.subset(np.arange(len(data.md_ft)) % 2 == 0)
        with Inverter(sub, FitConfig(**common, max_nfev=8), workers=WORKERS, on_eval=tick) as inv:
            x0 = inv.multistart(default_starts(inv, sub, k, weights=w)).x
    with Inverter(data, FitConfig(**common, max_nfev=fine_nfev), workers=WORKERS, on_eval=tick) as inv:
        res = inv.fit(x0) if x0 is not None else inv.multistart(default_starts(inv, data, k, weights=w))
    return serialize(data, res, w, sigma, lc, time.time() - t0, used)


def _none(values) -> list:
    return [None if v is None or not np.isfinite(v) else round(float(v), 4) for v in values]


def _curve_meta(lab):
    """Display group (one log track per spacing/frequency, one per geosignal) and kind of a label."""
    if lab.startswith("ZG"):
        return lab[:-1], "geosignal", "phase" if lab[-2] == "P" else "attenuation"
    kind = "avg" if lab.startswith("AR") else "top" if lab.endswith("T") else "bottom"
    m = lab[-1] if kind == "avg" else lab[-2]
    return lab[2:5].rstrip("PA") if kind == "avg" else lab[2:-2], kind, "phase" if m == "P" else "attenuation"


def serialize(data, res, weights, sigma, lc, elapsed, used=None) -> dict:
    m = res.model
    n = m.normal()
    ned = data.traj.ned
    shift = (ned[:, 0] * n[0] + ned[:, 1] * n[1]) / n[2]
    ref_z = data.ref_ned[2]
    boundary_tvd = [((b - shift) + ref_z) / FT for b in m.boundaries_m]
    tops = [None] + [(b + ref_z) / FT for b in m.boundaries_m]
    bottoms = [(b + ref_z) / FT for b in m.boundaries_m] + [None]
    valid = data.valid if data.valid is not None else np.ones_like(data.obs, bool)
    units = data.units or ["log"] * len(data.labels)
    used = used or {}
    curves = []
    res_pct, chi = [], []
    for j, lab in enumerate(data.labels):
        ok = valid[:, j]
        if not ok.any() and weights[j] == 0:
            continue
        r = res.residual[ok, j]
        log = units[j] == "log"
        conv = (lambda v: 10 ** v) if log else (lambda v: v)
        group, kind, measurement = _curve_meta(lab)
        entry = {"label": lab, "group": group, "kind": kind, "measurement": measurement,
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
        "model": {
            "layers": [{"rh": round(float(rh), 3), "rv": round(float(rv), 3),
                        "top_tvd_ft": None if t is None else round(t, 2),
                        "bottom_tvd_ft": None if b is None else round(b, 2)}
                       for rh, rv, t, b in zip(m.rh, m.rv, tops, bottoms)],
            "dip_deg": round(float(m.dip_deg), 2), "dip_azimuth_deg": round(float(m.dip_azimuth_deg), 1),
            "reference_note": "layer tops/bottoms are TVD at the window centre; boundaries dip along the well azimuth",
            "boundary_tvd_ft": [_none(b) for b in boundary_tvd],
        },
        "rms_percent_used": round(float(100 * (10 ** np.sqrt(np.mean(res_pct ** 2)) - 1)), 2) if res_pct.size else None,
        "misfit_normalised": round(float(np.sqrt(np.mean(chi ** 2))), 2) if chi.size else None,
        "stations": int(len(data.md_ft)), "forward_evaluations": int(res.nfev), "elapsed_s": round(elapsed, 1),
    }
