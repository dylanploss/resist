"""Inversion jobs driven by the QC curve selection.

The QC page picks curves; this module maps them onto the 1.5D forward model (``backend.inversion.adr_forward``):

* ``AR`` averaged resistivities are used as is; a ``C`` variant (``ARH16PC``) uses the vendor-corrected curve.
* A ``ZR`` image at 16/32/48 in contributes its **top and bottom** quadrants, extracted from the image as 90-degree
  sectors (``backend.data.quadrants``) for every run, so data and forward model use the same definition. Selecting
  ``ZR..T``/``ZR..B`` directly uses the image sector when the image exists, else the delivered curve. These carry the
  up/down information that places boundaries above or below the well.
* A ``ZG`` geosignal image (any spacing 16-112 in, one transmitter into R3) contributes its **top** quadrant sector
  (phase in deg, attenuation in dB; each bin minus the mean of all bins).
* ``ZR`` 50/66/82 in long-spacing images contribute top/bottom sectors of T2/T4/T6 into R1 and R3, uncompensated
  (``adr_forward.R3_IN``; the pairing is inferred), at ``GUESSED_GEOMETRY_WEIGHT`` and with a plan warning.
* Phase weight 1. With ``calibration`` on, 2 MHz attenuation has weight 0.5 and 500/125 kHz attenuation weight 0
  (QC only). The forward model includes the dielectric effect (``adr_forward.permittivity``), which replaced the
  empirical Z-20 attenuation correction. Rv/Rh is fitted to phase only (``FitConfig.anisotropy_from_phase``).
* ``WELL_CHANNEL_WEIGHTS`` scales channels that misbehave in one well (VC-2: 16 in 2 MHz).
* Single bins and geosignals are weighted by their own noise, estimated from the data in the interval.
* Clipped samples (``backend.data.loader.CLIP_OHMM``) are missing data: a station stays in the fit while any weighted
  channel has data there, and each missing value is left out on its own.
* ``ZR`` left/right bins and conventional logs are listed as ignored with a reason.

Jobs run one at a time in a background thread because each uses a process pool. The interval is cut into slices
(default 4 ft); each slice is a separate 1.5D fit on a sliding data window centred on it (default 20 ft), warm-started
from its neighbour, so neighbouring windows overlap and the curtain can show their mean.

Finished inversions are kept in the inversion store (``backend.inversion.store``: the shared Cosmos DB graph, or
memory + the committed snapshot). A job id is the first 12 characters of the request **fingerprint**, so a repeated
request is answered from the store (``source: "graph"``) without computing, unless ``force`` is set.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import logging
import os
import re
import threading
import time
import hashlib
import json
from types import SimpleNamespace

import numpy as np

from backend.inversion import remote
from backend.inversion.adr_forward import FT, FREQ_LETTER, R3_IN, ADRForward, LayerModel
from backend.inversion.invert import (FitConfig, Inverter, default_starts, interval_from_run, noise_estimate,
                                      worker_pool)

log = logging.getLogger("resist.inversion")
AR_CURVE = re.compile(r"^AR([HML])(\d+)([PA])(C?)$")
ZR_CURVE = re.compile(r"^ZR([HML])(\d+)([PA])([TBLR]?)$")
ZG_CURVE = re.compile(r"^ZG([HML])(\d+)([PA])$")
FREQ_HZ = {letter: f for f, letter in FREQ_LETTER.items()}
# 500/125 kHz attenuation is QC only (docs/inversion/HACKATHON_PLAN.md) until the dielectric model is checked on it.
CALIBRATED_ATTENUATION_WEIGHT = {2e6: 0.5, 5e5: 0.0, 1.25e5: 0.0}
GEOSIGNAL_WEIGHT = {"ZGL112AT": 0.25}  # 125 kHz attenuation geosignal barely tracks ZR top/bottom (r < 0.16)
GUESSED_GEOMETRY_WEIGHT = 1.0           # ZR 50/66/82 in: antenna layout guessed, uncompensated; kept at full weight
ANISOTROPY_FROM_PHASE = True            # Rv/Rh from phase only, then held while attenuation joins the fit
# Per-well weight factors on resistivity channels (AR and ZR, not ZG geosignals): (well substring, frequency Hz,
# spacing in, factor, reason). In VC-2 the 16 in 2 MHz pair reads ~8 % below 32 in on phase and ~20 % above on
# attenuation over the whole run (a shallow, near-borehole effect the 1D model cannot fit), so it is left out.
WELL_CHANNEL_WEIGHTS = (
    ("VC-2", 2e6, 16, 0.0, "VC-2: 16 in 2 MHz reads off the deeper spacings over the whole run (near-borehole effect)"),
)
LS_SPACINGS = (50, 66, 82)
SIGMA_FLOOR = {"log": 0.02, "deg": 0.5, "dB": 0.05}
WORKERS = int(os.environ.get("RESIST_INVERSION_WORKERS", 6))  # process-pool size per job
MAX_STATIONS = 250
MAX_INTERVAL_FT = 1500.0
# Each slice of the curtain is its own 1.5D fit on a sliding data window centred on it.
DEFAULT_SLICE_FT = 4.0
DEFAULT_WINDOW_FT = 20.0
MAX_SLICES = 300
MIN_WINDOW_STATIONS = 3
# Bump when the inversion code changes its results: repeated requests then recompute and supersede the old ones.
# "2": quadrant sectors, per-slice sliding-window fits with warm starts, Rh fit bounds.
# "3": per-slice posterior uncertainty, 50/66/82 in at full weight, dip-line constraints and partial re-runs.
# "4": ADR spec geometry: R3 at +64 in for long spacing and geosignals (all 16-112 in), bin-minus-average geosignals.
# "5": clip values masked, dielectric forward model (no Z-20 table), 500/125 kHz attenuation weight 0, phase-only
#      anisotropy, per-channel missing data, VC-2 16 in 2 MHz left out.
INVERSION_VERSION = "5"
# Request fields that never change the result; every other field of the validated request is fingerprinted.
NON_RESULT_FIELDS = frozenset({"force", "target"})
# Fields that only matter with dip lines / a base job; dropped otherwise so plain requests keep their fingerprint.
LINE_FIELDS = ("lines", "dip_sigma_deg", "boundary_sigma_ft", "downweight_misfit")
RERUN_FIELDS = ("base_job_id", "rerun_md_min_ft", "rerun_md_max_ft")
# Dip-line constraints: prior widths, the steepest dip a line may impose, and the misfit re-weighting of curves.
DEFAULT_DIP_SIGMA_DEG = 2.0
DEFAULT_BOUNDARY_SIGMA_FT = 2.0
MAX_LINE_DIP_DEG = 60.0
DOWNWEIGHT_MIN_CHI = 2.0      # a curve is only down-weighted when its misfit/noise exceeds this ...
DOWNWEIGHT_REL_CHI = 1.5      # ... and this multiple of the median curve misfit/noise in the window
DOWNWEIGHT_FLOOR = 0.05
UNCERTAINTY_DAMPING = 1e-2    # keeps parameters the data cannot see finite (they come out at ~10 decades, capped)
MAX_RH_STD_LOG = 2.0
MAX_BOUNDARY_STD_FT = 50.0



def well_channel_factor(well: str, label: str) -> tuple[float, str | None]:
    """(weight factor, reason) for a resistivity channel in this well from ``WELL_CHANNEL_WEIGHTS``."""
    if label.startswith("ZG"):
        return 1.0, None
    freq, spacing = FREQ_HZ[label[2]], int(re.match(r"\D+(\d+)", label[2:])[1])
    for token, f, sp, factor, reason in WELL_CHANNEL_WEIGHTS:
        if token in well and f == freq and sp == spacing:
            return factor, reason
    return 1.0, None


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
    ignored, well_notes = [], {}
    well = f"{getattr(run, 'well', '')} {getattr(getattr(run, 'path', None), 'name', '')}"
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
            factor, why = well_channel_factor(well, label)
            if why:
                weight *= factor
                well_notes.setdefault((why, factor), []).append(label)
            entry = {"curve": name, "label": label, "kind": kind, "measurement": measurement,
                     "frequency_hz": freq, "spacing_in": spacing, "guessed_geometry": guessed,
                     "source": source if isinstance(source, str) else f"{source[0]} {source[1]} sector",
                     "vendor_corrected": kind == "avg" and name.endswith("C"), "weight": weight, "correction": None}
            if why:
                entry["well_note"] = why
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
    for (why, factor), labs in well_notes.items():
        warnings.append(f"{why}: {', '.join(labs)} weighted x{factor:g}"
                        + (" (shown for QC, not fitted)." if factor == 0 else "."))
    guessed = sorted({e["curve"] for e in entries if e["guessed_geometry"]})
    if guessed:
        warnings.append(f"Guessed geometry for {', '.join(guessed)}: the 50/66/82 in long-spacing pairing is "
                        f"inferred, not published. The model fires T2/T4/T6 (16/32/48 in uphole) into R1 (near) and R3 "
                        f"(far, {R3_IN:.0f} in downhole of the tool centre), uncompensated; the spacing is to the R1-R3 "
                        f"midpoint. These channels have weight x{GUESSED_GEOMETRY_WEIGHT:g}; check their misfit, and "
                        "treat boundaries they alone resolve with caution.")
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
    source: str = "computed"           # "computed" (run in this backend) | "graph" (read from the store)
    fingerprint: str | None = None
    request_key: str | None = None
    force: bool = False
    summary: dict | None = None        # listing info when the result is not loaded
    base: dict | None = None           # result of the base job a partial re-run copies its untouched slices from
    target: str = "local"              # "local" (this backend) | "server" (proxied to the inversion server)
    remote_id: str | None = None       # job id on the inversion server
    polled: float = 0.0
    poll_failures: int = 0

    def to_dict(self) -> dict:
        end = self.finished or time.time()
        return {"id": self.id, "run": self.run, "status": self.status, "progress": round(self.progress, 3),
                "message": self.message, "request": self.request, "plan": public_plan(self.plan),
                "error": self.error, "elapsed_s": round(end - (self.started or end), 1), "result": self.result,
                "partial": self.partial if self.status == "running" else None, "source": self.source,
                "target": self.target}


def public_plan(plan: dict) -> dict:
    return {k: v for k, v in plan.items() if not k.startswith("_")}


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()
_slot = threading.Semaphore(1)


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def canonical_request(run_id: str, request: dict) -> dict:
    """The request validated by the API model with its defaults filled in, minus fields that do not change the result,
    so every result-affecting field (including ones added later) is part of the fingerprint."""
    from backend.inversion.api import InversionRequest   # api imports this module
    body = InversionRequest(**{**request, "run": run_id}).model_dump(exclude=set(NON_RESULT_FIELDS))
    body["curves"] = sorted(body["curves"])
    if not body["lines"]:
        for key in LINE_FIELDS:
            body.pop(key)
    if body["base_job_id"] is None:
        for key in RERUN_FIELDS:
            body.pop(key)
    return body


def fingerprint(run_id: str, request: dict, plan: dict, version: str | None = None) -> tuple[str, str]:
    """(fingerprint, request_key). The request_key hashes the canonical request + used labels, so a new code version
    that changes the weights still supersedes the old result; the fingerprint adds the weights and the version."""
    body = {**canonical_request(run_id, request), "plan": sorted(e["label"] for e in plan["used"])}
    request_key = hashlib.sha256(_canonical(body).encode()).hexdigest()
    weights = sorted([e["label"], float(e["weight"])] for e in plan["used"])
    fp = hashlib.sha256(_canonical({**body, "weights": weights, "version": version or INVERSION_VERSION}).encode()).hexdigest()
    return fp, request_key


def _store():
    from backend.inversion import store
    return store.get_store()


def job_from_record(rec: dict) -> Job:
    job = Job(rec["job_id"], rec["run"], rec["request"], rec.get("plan") or {}, status="done", progress=1.0,
              message="loaded from the inversion graph", result=rec.get("result"), created=rec.get("created") or 0,
              started=rec.get("started"), finished=rec.get("finished"), source="graph",
              fingerprint=rec["fingerprint"], request_key=rec.get("request_key"), summary=rec.get("summary"))
    return job


def record_from_job(job: Job, supersedes: list[str]) -> dict:
    return {"fingerprint": job.fingerprint, "job_id": job.id, "run": job.run, "version": INVERSION_VERSION,
            "request_key": job.request_key, "request": job.request, "plan": public_plan(job.plan),
            "result": job.result, "created": job.created, "started": job.started, "finished": job.finished,
            "supersedes": supersedes, "superseded": False}


def submit(run_id: str, run, request: dict, force: bool = False, target: str = "local") -> Job:
    """Start (or return the stored/active) job; target "server" computes it on the remote inversion server."""
    request = {k: v for k, v in request.items() if k not in NON_RESULT_FIELDS}
    plan = build_plan(run, request["curves"], request["calibration"])
    if not plan["used"]:
        raise ValueError("none of the selected curves can be inverted; select AR, ZR (16/32/48 in) or ZG curves in QC")
    fp, request_key = fingerprint(run_id, request, plan)
    job_id = fp[:12]
    base = _base_result(run_id, request) if request.get("base_job_id") else None
    with _jobs_lock:
        active = _jobs.get(job_id)
        if active is not None and active.status in ("queued", "running"):
            return active                              # same request already computing
    if not force:
        try:
            rec = _store().find(fp, run=run_id)
        except Exception as exc:                       # store down: compute instead of failing the request
            rec = None
            log.warning("inversion store lookup failed: %s", type(exc).__name__)
        if rec is not None:
            return job_from_record(rec)
    job = Job(job_id, run_id, request, plan, fingerprint=fp, request_key=request_key, force=force, base=base,
              target=target)
    with _jobs_lock:
        _jobs[job.id] = job
    if target == "server":
        job.base = None
        job.message = "sending to the inversion server"
        remote.start(job, force)
        return job
    threading.Thread(target=_execute, args=(job, run), daemon=True).start()
    return job


# A partial re-run reuses the base job's stations and slices, so it must share every setting that places them.
RERUN_MATCH = ("md_min_ft", "md_max_ft", "step_ft", "layers", "slice_ft", "window_ft")


def _base_result(run_id: str, request: dict) -> dict:
    base = get(request["base_job_id"])
    if base is None or base.status != "done" or base.result is None:
        raise ValueError(f"base inversion {request['base_job_id']} is not a finished inversion")
    if base.run != run_id:
        raise ValueError("the base inversion belongs to another run")
    mine, theirs = canonical_request(run_id, request), canonical_request(run_id, base.request)
    differ = [k for k in RERUN_MATCH if float(theirs[k]) != float(mine[k])]
    if differ:
        raise ValueError(f"the base inversion differs in {', '.join(differ)}: run a full inversion instead")
    if not base.result.get("slices"):
        raise ValueError("the base inversion has no slices to keep")
    return base.result


def get(job_id: str) -> Job | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is not None:
        if job.target == "server":
            remote.poll(job)
        return job
    try:
        rec = _store().get(job_id)
    except Exception as exc:
        log.warning("inversion store read failed: %s", type(exc).__name__)
        return None
    return job_from_record(rec) if rec else None


def finished_jobs(run_id: str) -> list[Job]:
    """Completed jobs of a run, newest first: the store's newest versions plus done jobs of this process."""
    with _jobs_lock:
        local = {j.id: j for j in _jobs.values() if j.run == run_id and j.status == "done"}
    try:
        stored = [job_from_record(r) for r in _store().list_finished(run_id)]
    except Exception as exc:
        log.warning("inversion store listing failed: %s", type(exc).__name__)
        stored = []
    merged = {j.id: j for j in stored}
    merged.update(local)
    return sorted(merged.values(), key=lambda j: j.finished or 0, reverse=True)


def save_result(job: Job) -> str:
    """Store a finished job (force replaces, older versions get superseded); returns a message suffix."""
    if job.fingerprint is None or job.result is None:
        return ""
    st = _store()
    if job.force:
        st.delete(job.fingerprint, run=job.run)
    older = [fp for fp in st.older_versions(job.run, job.request_key, INVERSION_VERSION) if fp != job.fingerprint]
    info = st.save(record_from_job(job, older)) or {}
    parts = [f"saved to the {st.kind} store"]
    if older:
        parts.append(f"supersedes {len(older)} older version(s)")
    if info.get("observed_updated"):
        parts.append(f"{info['observed_updated']} stored observations differed and were updated")
    if info.get("warning"):
        parts.append(f"warning: {info['warning']}")
    return "; ".join(parts)


def _execute(job: Job, run) -> None:
    with _slot:
        job.status, job.started, job.message = "running", time.time(), "loading interval"
        try:
            job.result = run_inversion(run, job.request, job.plan, job, base=job.base)
        except Exception as exc:  # reported to the client, not raised in the thread
            job.status, job.error, job.message = "error", f"{type(exc).__name__}: {exc}", "failed"
            job.finished = time.time()
            return
        finally:
            job.base = None
        job.finished = time.time()
        job.progress, job.message = 0.99, "saving to the inversion store"
        try:
            note = save_result(job)
        except Exception as exc:  # the result is still served from memory
            log.warning("could not save inversion %s: %s: %s", job.id, type(exc).__name__, str(exc)[:200])
            note = f"not saved to the store ({type(exc).__name__})"
        job.status, job.progress = "done", 1.0
        job.message = "finished" + (f"; {note}" if note else "")


def run_inversion(run, request: dict, plan: dict, job: Job | None = None, base: dict | None = None) -> dict:
    azimuthal = plan["azimuthal"]
    fwd = ADRForward(azimuthal=azimuthal)
    labels = fwd.channel_labels()
    used = {e["label"]: e for e in plan["used"]}
    sources = {lab: plan["_sources"].get(lab, lab) for lab in labels}
    data = interval_from_run(run, request["md_min_ft"], request["md_max_ft"], fwd, request["step_ft"],
                             sources, required=_weighted(used), require="any")
    if len(data.md_ft) > MAX_STATIONS:
        raise ValueError(f"{len(data.md_ft)} stations exceed {MAX_STATIONS}; shorten the interval or increase the step")
    weights = {lab: used[lab]["weight"] if lab in used else 0.0 for lab in labels}
    w = np.array([weights[lab] for lab in labels])
    # Averaged curves keep the 2% floor; single bins and geosignals are weighted by their own measured noise.
    obs = data.masked_obs()
    sigma = {lab: SIGMA_FLOOR[u] if lab.startswith("AR") else noise_estimate(obs[:, j], SIGMA_FLOOR[u])
             for j, (lab, u) in enumerate(zip(labels, data.units))}
    lc = None   # the dielectric forward model replaced the empirical Z-20 attenuation correction
    k = request["layers"]
    slice_ft, window_ft = request.get("slice_ft", DEFAULT_SLICE_FT), request.get("window_ft", DEFAULT_WINDOW_FT)
    centres = slice_centres(float(data.md_ft[0]), float(data.md_ft[-1]), slice_ft)
    if len(centres) > MAX_SLICES:
        raise ValueError(f"{len(centres)} slices exceed {MAX_SLICES}; shorten the interval or widen the slices")
    nfev = 6 if request["quick"] else 12
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
                    rh_min=request.get("rh_min_ohmm", 0.1), rh_max=request.get("rh_max_ohmm", 1000.0),
                    max_nfev=nfev, anisotropy_from_phase=ANISOTROPY_FROM_PHASE)
    lines = request.get("lines") or []
    dip_sigma = request.get("dip_sigma_deg", DEFAULT_DIP_SIGMA_DEG)
    boundary_sigma = request.get("boundary_sigma_ft", DEFAULT_BOUNDARY_SIGMA_FT)
    downweight = bool(lines) and request.get("downweight_misfit", True)
    keep, rerun_range = _kept_slices(data, centres, request, base, lines, window_ft)
    base_pred = _base_pred(data, base, labels) if keep else None
    budget = max(1, len(centres) - len(keep)) * nfev * (2 if downweight else 1) + 2 * nfev
    pred = np.full(data.obs.shape, np.nan)
    owner = np.argmin(np.abs(data.md_ft[:, None] - centres[None, :]), axis=1)
    done = dict(keep)
    if job is not None and keep:
        job.partial = {**well_path, "slice_ft": slice_ft, "window_ft": window_ft,
                       "slices": [done[i] for i in sorted(done)], "rerun": rerun_range, "evaluation": 0,
                       "slice": 0, "n_slices": len(centres), "misfit_normalised": None}
    models, x_prev, chi_prev, total_nfev, prev_constrained = {}, None, np.inf, 0, False
    factors: dict[str, list[float]] = {}
    with worker_pool(data.traj, WORKERS, azimuthal=azimuthal) as pool:
        for s, c in enumerate(centres):
            current[0] = s
            if s in keep:   # partial re-run: this slice is outside the re-run range and is copied from the base
                models[s] = _model_from_slice(data, keep[s])
                mine = owner == s
                pred[mine] = base_pred[mine]
                x_prev, chi_prev = _x_from_model(models[s]), keep[s].get("misfit_normalised") or np.inf
                prev_constrained = False
                continue
            idx = np.flatnonzero(np.abs(data.md_ft - c) <= window_ft / 2 + 1e-6)
            if idx.size < MIN_WINDOW_STATIONS:
                continue
            sub = data.subset(idx)
            cons = _slice_constraints(data, sub, lines, c, window_ft, dip_sigma, boundary_sigma, cfg.dip_limit_deg)
            scfg = replace(cfg, **cons["cfg"]) if cons else cfg
            with Inverter(sub, scfg, on_eval=tick, pool=pool, station_idx=idx) as inv:
                res = None
                if x_prev is not None:
                    try:
                        res = inv.fit(x_prev)
                    except ValueError:
                        res = None
                chi = _chi(res, sigma, labels, w) if res is not None else np.inf
                # Warm start from the previous slice; restart when it clearly failed to fit this window, or when
                # entering a dip-line constraint (the previous slice's dip may be far from the line's).
                if res is None or chi > 1.5 * chi_prev or (cons and not prev_constrained):
                    starts = default_starts(inv, sub, k, weights=w)
                    fresh = inv.multistart(_constrained_starts(inv, starts, cons, k) if cons else starts)
                    if res is None or fresh.cost < res.cost:
                        res, chi = fresh, _chi(fresh, sigma, labels, w)
                unc = _uncertainty(inv, res)
            slice_factors = {}
            if cons and downweight:
                # Curves that still disagree with the line-constrained model lose weight; refit once with them.
                f = _misfit_factors(res, sigma, labels, w)
                if any(v < 1 for v in f.values()):
                    rcfg = replace(scfg, curve_weights={lab: weights[lab] * f.get(lab, 1.0) for lab in labels})
                    with Inverter(sub, rcfg, on_eval=tick, pool=pool, station_idx=idx) as inv2:
                        try:
                            refit = inv2.fit(res.x)
                        except ValueError:
                            refit = None
                        if refit is not None:
                            res, chi, unc = refit, _chi(refit, sigma, labels, w), _uncertainty(inv2, refit)
                    slice_factors = {lab: round(v, 3) for lab, v in f.items() if v < 1}
                for lab, v in f.items():
                    factors.setdefault(lab, []).append(v)
            x_prev, chi_prev, prev_constrained = res.x, chi, bool(cons)
            total_nfev += res.nfev
            models[s] = res.model
            mine = owner[idx] == s
            pred[idx[mine]] = res.pred[mine]
            entry = {**_slice_entry(data, res.model, idx, c, slice_ft, chi), **unc}
            if cons:
                entry["constraint"] = cons["summary"]
            if slice_factors:
                entry["downweighted"] = slice_factors
            done[s] = entry
            if job is not None:
                job.partial = {**well_path, "slice_ft": slice_ft, "window_ft": window_ft,
                               "slices": [done[i] for i in sorted(done)], "rerun": rerun_range,
                               "evaluation": count[0], "slice": s + 1, "n_slices": len(centres),
                               "misfit_normalised": round(chi, 2)}
    if not models:
        raise ValueError(f"no slice had {MIN_WINDOW_STATIONS} stations in its {window_ft:g} ft data window; "
                         "use a smaller station step or a wider window")
    combined = SimpleNamespace(pred=pred, residual=obs - pred, nfev=total_nfev, model=None)
    out = serialize(data, combined, w, sigma, lc, time.time() - t0, used,
                    model=summary_model(data, models, owner))
    for curve in out["curves"]:
        if curve["label"] in factors:
            curve["downweight_factor"] = round(float(np.mean(factors[curve["label"]])), 3)
    slices = [done[i] for i in sorted(done)]
    extra = {"rerun": rerun_range} if rerun_range else {}
    if lines:
        extra["constraints"] = {"lines": lines, "dip_sigma_deg": dip_sigma, "boundary_sigma_ft": boundary_sigma,
                                "downweight_misfit": downweight,
                                "constrained_slices": sum(1 for s, e in done.items() if s not in keep and "constraint" in e)}
    return {**out, "slice_ft": slice_ft, "window_ft": window_ft, "slices": slices, **extra}


def _extrapolate(xs, ys, x) -> float:
    """Linear interpolation of ys(xs) at x, extended linearly beyond the ends (lines may reach past the interval)."""
    if xs[0] <= x <= xs[-1] or len(xs) < 2:
        return float(np.interp(x, xs, ys))
    i, j = (0, min(len(xs) - 1, 5)) if x < xs[0] else (max(0, len(xs) - 6), len(xs) - 1)
    if xs[j] == xs[i]:
        return float(ys[i])
    return float(ys[i] + (ys[j] - ys[i]) * (x - xs[i]) / (xs[j] - xs[i]))


def line_dip(data, azimuth_deg: float, line: dict) -> tuple[float, float] | None:
    """(dip deg, boundary ft relative to the reference) of a section line, in the inverter's convention: boundaries
    dip along ``azimuth_deg`` and their TVD at a point is ``b + tan(dip) * h + ref`` with ``h`` the horizontal
    distance along the azimuth. None when the line spans no horizontal distance."""
    a = np.deg2rad(azimuth_deg)
    h = data.traj.ned[:, 0] * np.cos(a) + data.traj.ned[:, 1] * np.sin(a)
    h1, h2 = (_extrapolate(data.md_ft, h, line[f"md{i}_ft"]) for i in (1, 2))
    if abs(h2 - h1) < 0.05:
        return None
    t = (line["tvd2_ft"] - line["tvd1_ft"]) * FT / (h2 - h1)
    return float(np.rad2deg(np.arctan(t))), float((line["tvd1_ft"] * FT - data.ref_ned[2] - t * h1) / FT)


def _slice_constraints(data, sub, lines, centre, window_ft, dip_sigma, boundary_sigma, dip_limit):
    """FitConfig overrides for the dip lines whose MD span (plus half a window) covers this slice, or None."""
    active = [ln for ln in lines
              if min(ln["md1_ft"], ln["md2_ft"]) - window_ft / 2 <= centre <= max(ln["md1_ft"], ln["md2_ft"]) + window_ft / 2]
    if not active:
        return None
    az = float(np.rad2deg(np.arctan2(sub.traj.axis[:, 1].mean(), sub.traj.axis[:, 0].mean())))
    dips, anchors = [], []
    for ln in active:
        got = line_dip(data, az, ln)
        if got is None:
            continue
        dips.append(got[0])
        if ln.get("anchor", True):
            anchors.append(got[1])
    if not dips:
        return None
    dip = float(np.clip(np.mean(dips), -MAX_LINE_DIP_DEG, MAX_LINE_DIP_DEG))
    return {"cfg": {"dip_prior": (dip, dip_sigma), "boundary_priors": tuple((b, boundary_sigma) for b in anchors),
                    "dip_limit_deg": max(dip_limit, min(MAX_LINE_DIP_DEG + 5, abs(dip) + 5))},
            "summary": {"dip_deg": round(dip, 2), "lines": len(dips), "anchored": len(anchors)}}


def _constrained_starts(inv, starts, cons, k):
    """The default starts at the lines' dip, plus one with the boundaries placed on the anchored lines."""
    d0 = cons["cfg"]["dip_prior"][0]
    di = inv.lay.dip_index
    out = []
    for x in starts:
        x = np.array(x, float)
        x[di] = d0
        out.append(x)
    anchors = sorted(b for b, _ in cons["cfg"]["boundary_priors"])
    if anchors and k > 1:
        bs = list(anchors[:k - 1])
        while len(bs) < k - 1:
            bs.append(bs[-1] + 6.0)
        for i in range(1, len(bs)):
            bs[i] = max(bs[i], bs[i - 1] + 1.0)
        x = out[0].copy()
        x[0] = bs[0]
        x[1:k - 1] = np.diff(bs)
        out.append(x)
    return out


def _misfit_factors(res, sigma, labels, w) -> dict[str, float]:
    """Weight multiplier per used curve: 1 unless its misfit/noise in the window is an outlier, then (tau/chi)^2."""
    chi = {}
    for j in np.flatnonzero(w > 0):
        r = res.residual[:, j] / sigma[labels[j]]
        r = r[np.isfinite(r)]
        if r.size:
            chi[labels[j]] = float(np.sqrt(np.mean(r ** 2)))
    if len(chi) < 3:
        return {lab: 1.0 for lab in chi}
    tau = max(DOWNWEIGHT_MIN_CHI, DOWNWEIGHT_REL_CHI * float(np.median(list(chi.values()))))
    return {lab: 1.0 if v <= tau else max(DOWNWEIGHT_FLOOR, (tau / v) ** 2) for lab, v in chi.items()}


def _uncertainty(inv, res) -> dict:
    """Posterior standard deviations from the final Jacobian: log10 Rh per layer (decades), boundary depth (ft) and
    dip (deg). Layers the data cannot see come out large (capped), which is what the display fades first."""
    jac = res.extra.get("jac") if res.extra else None
    if jac is None:
        return {}
    ne = inv.lay.n_earth
    J = np.asarray(jac)[:, :ne]
    rows = int(np.count_nonzero(np.any(J != 0, axis=1)))
    s2 = max(1.0, 2 * res.cost / max(1, rows - ne))
    try:
        cov = np.linalg.inv(J.T @ J + UNCERTAINTY_DAMPING * np.eye(ne)) * s2
    except np.linalg.LinAlgError:
        return {}
    k = inv.cfg.n_layers
    var = np.clip(np.diag(cov), 0, None)
    out = {"rh_std_log": [round(float(min(MAX_RH_STD_LOG, np.sqrt(v))), 3) for v in var[k - 1:2 * k - 1]]}
    if k > 1:
        A = np.tril(np.ones((k - 1, k - 1)))
        vb = np.clip(np.diag(A @ cov[:k - 1, :k - 1] @ A.T), 0, None)
        out["boundary_std_ft"] = [round(float(min(MAX_BOUNDARY_STD_FT, np.sqrt(v))), 2) for v in vb]
    if inv.cfg.fit_dip:
        out["dip_std_deg"] = round(float(min(90.0, np.sqrt(var[inv.lay.dip_index]))), 2)
    return out


def _kept_slices(data, centres, request, base, lines, window_ft):
    """({slice index: base slice entry} to copy, re-run range) for a partial re-run; ({}, None) for a full run."""
    if base is None:
        return {}, None
    lo, hi = request.get("rerun_md_min_ft"), request.get("rerun_md_max_ft")
    if lo is None:
        if not lines:
            return {}, None
        lo = min(min(ln["md1_ft"], ln["md2_ft"]) for ln in lines) - window_ft / 2
        hi = max(max(ln["md1_ft"], ln["md2_ft"]) for ln in lines) + window_ft / 2
    base_md = np.array([np.nan if v is None else v for v in base["md_ft"]], float)
    if base_md.shape != data.md_ft.shape or not np.allclose(base_md, data.md_ft, atol=1e-3):
        raise ValueError("the base inversion used different stations: run a full inversion instead")
    by_centre = {round(float(e["md_centre_ft"]), 2): e for e in base["slices"]}
    keep = {}
    for s, c in enumerate(centres):
        e = by_centre.get(round(float(c), 2))
        if not (lo <= c <= hi) and e is not None and len(e["layers"]) == request["layers"]:
            keep[s] = e
    return keep, {"base_job_id": request.get("base_job_id"), "md_min_ft": round(float(lo), 2),
                  "md_max_ft": round(float(hi), 2), "kept_slices": len(keep), "recomputed_slices": len(centres) - len(keep)}


def _base_pred(data, base, labels) -> np.ndarray:
    """The base result's predictions in inversion units (log10 for resistivities), per station and label."""
    pred = np.full((len(data.md_ft), len(labels)), np.nan)
    for c in base["curves"]:
        if c["label"] not in labels:
            continue
        v = np.array([np.nan if x is None else x for x in c["pred"]], float)
        if c.get("unit") == "ohm.m":
            with np.errstate(divide="ignore", invalid="ignore"):
                v = np.log10(v)
        pred[:, labels.index(c["label"])] = v
    return pred


def _model_from_slice(data, entry) -> LayerModel:
    """Rebuild a slice's layered model from its stored entry (inverse of ``model_geometry`` at one station)."""
    rh = np.array([layer["rh"] for layer in entry["layers"]], float)
    rv = np.array([layer["rv"] for layer in entry["layers"]], float)
    m = LayerModel(np.zeros(len(rh) - 1), rh, rv, float(entry["dip_deg"]), float(entry["dip_azimuth_deg"]))
    n = m.normal()
    bounds = []
    for b in entry["boundary_tvd_ft"]:
        i = next((i for i, v in enumerate(b) if v is not None), None)
        if i is None:
            bounds.append(np.nan)
            continue
        ned = data.traj.ned[int(np.argmin(np.abs(data.md_ft - entry["md_ft"][i])))]
        bounds.append(b[i] * FT + (ned[0] * n[0] + ned[1] * n[1]) / n[2] - data.ref_ned[2])
    m.boundaries_m = np.array(bounds, float)
    return m


def _x_from_model(m) -> np.ndarray:
    """Inverter parameters (shared anisotropy, fitted dip) of a layered model, as a warm start."""
    b = m.boundaries_m / FT
    layer_part = ([b[0]] + list(np.diff(b))) if len(b) else []
    return np.array(layer_part + list(np.log10(m.rh)) + [np.log10(m.rv[0] / m.rh[0]), m.dip_deg], float)


def section_preview(run, request: dict) -> dict:
    """Well path and measured channels of the interval, as the inversion would load them, without inverting."""
    plan = build_plan(run, request["curves"], request["calibration"])
    if not plan["used"]:
        raise ValueError("none of the selected curves can be inverted; select AR, ZR or ZG curves in QC")
    fwd = ADRForward(azimuthal=plan["azimuthal"])
    labels = fwd.channel_labels()
    used = {e["label"]: e for e in plan["used"]}
    sources = {lab: plan["_sources"].get(lab, lab) for lab in labels}
    data = interval_from_run(run, request["md_min_ft"], request["md_max_ft"], fwd, request["step_ft"],
                             sources, required=_weighted(used), require="any")
    curves = []
    for j, lab in enumerate(labels):
        if lab not in used:
            continue
        group, kind, measurement = _curve_meta(lab)
        log_unit = data.units[j] == "log"
        values = np.where(data.valid[:, j], 10 ** data.obs[:, j] if log_unit else data.obs[:, j], np.nan)
        curves.append({"label": lab, "group": group, "kind": kind, "measurement": measurement,
                       "unit": "ohm.m" if log_unit else data.units[j], "used": True,
                       "weight": used[lab]["weight"], "source": used[lab]["source"], "obs": _none(values)})
    return {"run": request["run"], "well": data.well, "md_ft": _none(data.md_ft), "tvd_ft": _none(data.tvd_ft),
            "inclination_deg": _none(np.rad2deg(np.arccos(np.clip(data.traj.axis[:, 2], -1, 1)))),
            "stations": int(len(data.md_ft)), "curves": curves}


def _weighted(used: dict) -> list[str]:
    """Labels that carry weight in the fit (a station needs at least one of them); all used labels if none do."""
    return [lab for lab, e in used.items() if e["weight"] > 0] or list(used)


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
