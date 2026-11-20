"""Windowed 1.5D inversion of ADR averaged resistivities with optional per-channel corrections.

Data space: log10 apparent resistivity for every (channel, phase|attenuation) curve.
Model space (one window): K planar TIV layers sharing a signed dip along the well azimuth,
plus optional per-curve correction terms ``b_c``:

    log10 R_measured = log10 R_theory(model) + b_c

``b_c`` absorbs tool-versus-theory mismatch (mandrel, borehole, vendor transform, calibration).
A common shift of every ``b_c`` is indistinguishable from scaling Rh/Rv, so the biases of the
reference curves are constrained to zero mean.
"""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares

from backend.data.quadrants import quadrant
from backend.inversion.adr_forward import FT, ADRForward, LayerModel, Trajectory

DEFAULT_REFERENCE = ("ARH16P", "ARH32P", "ARH48P", "ARM16P", "ARM32P", "ARM48P", "ARL48P")

# Z-20 20100-20500 ft study (docs/inversion/HACKATHON_PLAN.md): phase agrees with theory within a few
# percent; 2 MHz attenuation reads systematically high (corrected below); 500k/125k attenuation shows no
# transferable correction, so it is QC-only by default.
HACKATHON_WEIGHTS = {"ARH16A": 0.5, "ARH32A": 0.5, "ARH48A": 0.5,
                     "ARM16A": 0.0, "ARM32A": 0.0, "ARM48A": 0.0, "ARL48A": 0.0}
Z20_ATTENUATION_CORRECTION = {"ARH16A": (0.0820, 0.1251), "ARH32A": (0.0567, 0.0871), "ARH48A": (0.0526, 0.0760)}


@dataclass
class IntervalData:
    well: str
    md_ft: np.ndarray
    traj: Trajectory
    obs: np.ndarray            # (n, n_curves) inversion units: log10 ohm-m, or deg/dB for geosignals
    labels: list
    gr: np.ndarray
    ref_ned: np.ndarray        # absolute NED of the reference point (m)
    tvd_ft: np.ndarray
    valid: np.ndarray | None = None   # (n, n_curves) True where a measured value exists
    units: list | None = None         # per label: 'log', 'deg' or 'dB' (None = all 'log')

    def subset(self, mask):
        return IntervalData(self.well, self.md_ft[mask], self.traj.subset(mask), self.obs[mask], self.labels,
                            self.gr[mask], self.ref_ned, self.tvd_ft[mask],
                            None if self.valid is None else self.valid[mask], self.units)

    def tvd_rel_ft(self, tvd_ft):
        return (np.asarray(tvd_ft) * FT - self.ref_ned[2]) / FT

    def is_log(self):
        return np.array([u == "log" for u in (self.units or ["log"] * len(self.labels))])


def load_interval(path, md_min, md_max, fwd: ADRForward, step_ft=2.0, corrected=False):
    from backend.data.loader import load_run

    sfx = "C" if corrected else ""
    sources = {lab: lab + sfx for lab in fwd.channel_labels()}
    return interval_from_run(load_run(path), md_min, md_max, fwd, step_ft, sources)


TRAJECTORY_CURVES = ("TVD", "INC", "AZI", "UTMX", "UTMY")


def azimuthal_average(image):
    """Conductivity mean of the bins of a resistivity image (depth x bins); reproduces the delivered AR curve."""
    img = np.asarray(image, float)
    if img.ndim == 1:
        return img
    with np.errstate(divide="ignore", invalid="ignore"):
        cond = np.where(img > 0, 1.0 / img, np.nan)
        return 1.0 / np.nanmean(cond, axis=1)


def _source_values(c, src, idx):
    """A source is a curve name, ``(image, bin index)`` for one bin, or ``(image, side)`` for a quadrant sector."""
    if isinstance(src, tuple):
        image = np.asarray(c[src[0]][idx], float)
        if isinstance(src[1], str):
            return quadrant(image, src[1], resistivity=src[0].startswith("ZR"))
        return image[:, src[1]]
    return azimuthal_average(c[src][idx])


def _has_source(c, src):
    return (src[0] if isinstance(src, tuple) else src) in c


def interval_from_run(run, md_min, md_max, fwd: ADRForward, step_ft=2.0, sources=None, required=None):
    """Interval data for a loaded WellRun.

    ``sources`` maps each forward-model label to its delivered data: a curve name (``ARH16P``, ``ARH16PC``,
    ``ZRH16PT``; a 32-bin image such as ``ZRH16P`` is reduced by ``azimuthal_average``), ``(image, bin)`` for one
    bin, or ``(image, side)`` for a 90-degree quadrant sector (``("ZRH16P", "T")``; see ``backend.data.quadrants``). Labels without a usable source are kept as NaN-free zeros and must
    get weight 0. Stations are dropped only where a ``required`` label (default: all sourced labels) or the
    trajectory is missing.
    """
    c = run.curves
    missing = [k for k in TRAJECTORY_CURVES if k not in c]
    if missing:
        raise ValueError(f"run lacks trajectory curves needed for 1.5D inversion: {', '.join(missing)}")
    labels = fwd.channel_labels()
    units = fwd.units()
    is_log = np.array([u == "log" for u in units])
    sources = {lab: src for lab, src in (sources or {lab: lab for lab in labels}).items() if _has_source(c, src)}
    required = list(sources) if required is None else list(required)
    md = c["DEPT"]
    idx = np.flatnonzero((md >= md_min) & (md <= md_max))
    if len(idx) > 1:
        idx = idx[::max(1, int(round(step_ft / np.median(np.diff(md[idx])))))]
    raw = np.column_stack([_source_values(c, sources[lab], idx) if lab in sources else np.full(len(idx), np.nan)
                           for lab in labels])
    with np.errstate(divide="ignore", invalid="ignore"):
        obs = np.where(is_log, np.log10(np.where(raw > 0, raw, np.nan)), raw)
    traj_cols = [c[k][idx] for k in TRAJECTORY_CURVES]
    req = [labels.index(lab) for lab in required]
    ok = np.all(np.isfinite(obs[:, req]), axis=1) & np.all([np.isfinite(t) for t in traj_cols], axis=0)
    if ok.sum() < 3:
        raise ValueError(f"fewer than 3 stations with complete data between {md_min} and {md_max} ft MD")
    tvd, inc, azi, ue, un = (t[ok] for t in traj_cols)
    ref = np.array([un.mean(), ue.mean(), tvd.mean() * FT])
    traj = Trajectory.from_curves(md[idx][ok], tvd, inc, azi, ue, un, ref=ref)
    obs = obs[ok]
    valid = np.isfinite(obs)
    obs[~valid] = 0.0
    gr = c["GR"][idx][ok] if "GR" in c else np.full(int(ok.sum()), np.nan)
    return IntervalData(run.well, md[idx][ok], traj, obs, labels, gr, ref, tvd, valid, units)


def noise_estimate(values, floor):
    """Robust noise level of a log from its sample-to-sample differences (MAD), never below ``floor``."""
    d = np.diff(np.asarray(values, float))
    d = d[np.isfinite(d)]
    if d.size < 3:
        return floor
    return max(floor, float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)))


# ---------------------------------------------------------------------------- parameterisation
@dataclass
class FitConfig:
    n_layers: int = 3
    shared_anisotropy: bool = True
    fit_dip: bool = True
    fit_bias: bool = False
    fixed_bias: np.ndarray | None = None
    reference: tuple = DEFAULT_REFERENCE
    bias_prior: float = 0.1            # decades, weak Tikhonov prior on b_c
    sigma: float = 0.02                # decades, data standard deviation
    curve_sigma: dict | None = None    # label -> sigma in inversion units (overrides ``sigma``)
    azimuthal: bool = False            # forward model with directional ZR top/bottom and ZG channels
    fit_cross_dip: bool = False        # second dip angle across the well, so the dip azimuth is free (3D facets)
    dip_limit_deg: float = 15.0        # bound on the along- and cross-well dip angles
    rh_min: float = 0.1                # ohm-m bounds on every layer's Rh
    rh_max: float = 1000.0
    forward_options: dict | None = None  # extra ADRForward arguments, e.g. zr_sides for left/right quadrants
    curve_weights: dict | None = None  # label -> weight multiplier (0 excludes a curve)
    level_correction: "LevelCorrection | None" = None  # fixed tool-vs-theory correction on the theory
    max_nfev: int = 25
    # Interpreter constraints (dip lines drawn on the section): Gaussian priors appended to the residual.
    dip_prior: tuple | None = None     # (dip deg, sigma deg) on the along-well dip
    boundary_priors: tuple = ()        # ((boundary ft relative to the reference, sigma ft), ...) on the nearest boundary


@dataclass
class Layout:
    cfg: FitConfig
    n_curves: int
    dip_azimuth: float

    @property
    def n_aniso(self):
        return 1 if self.cfg.shared_anisotropy else self.cfg.n_layers

    @property
    def n_earth(self):
        k = self.cfg.n_layers
        return (k - 1) + k + self.n_aniso + int(self.cfg.fit_dip) + int(self.cfg.fit_cross_dip)

    @property
    def n_params(self):
        return self.n_earth + (self.n_curves if self.cfg.fit_bias else 0)

    @property
    def dip_index(self):
        return (self.cfg.n_layers - 1) + self.cfg.n_layers + self.n_aniso

    def prior_rows(self, x):
        """Constraint residuals and their Jacobian rows: the dip prior, then each boundary prior on the nearest
        boundary not yet claimed by another prior."""
        cfg, k = self.cfg, self.cfg.n_layers
        rows, jac = [], []
        if cfg.dip_prior is not None and cfg.fit_dip:
            d0, s = cfg.dip_prior
            rows.append((x[self.dip_index] - d0) / s)
            g = np.zeros(self.n_params); g[self.dip_index] = 1.0 / s
            jac.append(g)
        if cfg.boundary_priors and k > 1:
            bounds = np.cumsum(x[:k - 1])
            free = list(range(k - 1))
            for b0, s in cfg.boundary_priors:
                if not free:
                    break
                j = min(free, key=lambda i: abs(bounds[i] - b0))
                free.remove(j)
                rows.append((bounds[j] - b0) / s)
                g = np.zeros(self.n_params); g[:j + 1] = 1.0 / s
                jac.append(g)
        return np.array(rows, float), (np.array(jac) if jac else np.zeros((0, self.n_params)))

    def model(self, x):
        k = self.cfg.n_layers
        i = k - 1
        bounds = (np.concatenate([[x[0]], x[0] + np.cumsum(x[1:k - 1])]) * FT) if k > 1 else np.array([])
        lrh = x[i:i + k]; i += k
        la = x[i:i + self.n_aniso]; i += self.n_aniso
        dip = x[i] if self.cfg.fit_dip else 0.0
        i += int(self.cfg.fit_dip)
        rh = 10 ** lrh
        rv = rh * 10 ** (np.repeat(la, k) if self.n_aniso == 1 else la)
        if not self.cfg.fit_cross_dip:
            return LayerModel(bounds, rh, rv, dip, self.dip_azimuth)
        # Signed dips along and across the well (positive across = beds deepen to the right of the heading).
        ta, tc = np.tan(np.deg2rad(dip)), np.tan(np.deg2rad(x[i]))
        return LayerModel(bounds, rh, rv, float(np.rad2deg(np.arctan(np.hypot(ta, tc)))),
                          float(self.dip_azimuth + np.rad2deg(np.arctan2(tc, ta))))

    def bias(self, x):
        if self.cfg.fit_bias:
            return x[self.n_earth:]
        if self.cfg.fixed_bias is not None:
            return np.asarray(self.cfg.fixed_bias)
        return np.zeros(self.n_curves)

    def bounds(self, tvd_lo, tvd_hi):
        k = self.cfg.n_layers
        lrh_lo, lrh_hi = np.log10(self.cfg.rh_min), np.log10(self.cfg.rh_max)
        lo = [tvd_lo] + [0.5] * (k - 2) + [lrh_lo] * k + [0.0] * self.n_aniso
        hi = [tvd_hi] + [60.0] * (k - 2) + [lrh_hi] * k + [1.0] * self.n_aniso
        if k == 1:
            lo, hi = lo[1:], hi[1:]
        lim = self.cfg.dip_limit_deg
        if self.cfg.fit_dip:
            lo.append(-lim); hi.append(lim)
        if self.cfg.fit_cross_dip:
            lo.append(-lim); hi.append(lim)
        if self.cfg.fit_bias:
            lo += [-0.5] * self.n_curves; hi += [0.5] * self.n_curves
        return np.array(lo), np.array(hi)

    def steps(self):
        k = self.cfg.n_layers
        s = [0.05] * (k - 1) + [0.004] * k + [0.004] * self.n_aniso + ([0.05] if self.cfg.fit_dip else [])
        return np.array(s + ([0.05] if self.cfg.fit_cross_dip else []))


# ---------------------------------------------------------------------------- parallel forward
_FWD: ADRForward | None = None
_TRAJ: Trajectory | None = None


def _init_worker(receiver_sep_in, traj, azimuthal=False, options=None):
    global _FWD, _TRAJ
    _FWD = ADRForward(receiver_sep_in=receiver_sep_in, azimuthal=azimuthal, **(options or {}))
    _FWD.tables()
    _TRAJ = traj


def _predict(task):
    model, idx = task if isinstance(task, tuple) else (task, None)
    return _FWD.predict(model, _TRAJ if idx is None else _TRAJ.subset(idx))


def worker_pool(traj: Trajectory, workers: int, receiver_sep_in=8.0, azimuthal=False, options=None):
    """A pool on the full trajectory, shared by Inverters of sub-windows (``Inverter(pool=..., station_idx=...)``)."""
    return ProcessPoolExecutor(max_workers=workers, initializer=_init_worker,
                               initargs=(receiver_sep_in, traj, azimuthal, options))


@dataclass
class FitResult:
    x: np.ndarray
    model: LayerModel
    bias: np.ndarray
    pred: np.ndarray           # log10 theory + bias
    theory: np.ndarray         # log10 theory only
    residual: np.ndarray       # obs - pred (decades)
    labels: list
    cost: float
    nfev: int
    extra: dict = field(default_factory=dict)

    def rms_percent(self, axis=None):
        return 100 * (10 ** np.sqrt(np.mean(self.residual ** 2, axis=axis)) - 1)

    def summary(self):
        m = self.model
        return {
            "boundaries_tvd_rel_ft": (m.boundaries_m / FT).round(2).tolist(),
            "rh": m.rh.round(2).tolist(), "rv": m.rv.round(2).tolist(),
            "dip_deg": round(float(m.dip_deg), 2), "dip_azimuth_deg": round(float(m.dip_azimuth_deg), 1),
            "rms_percent": round(float(self.rms_percent()), 2),
            "rms_percent_by_curve": dict(zip(self.labels, self.rms_percent(axis=0).round(2).tolist())),
            "mean_residual_percent_by_curve": dict(zip(self.labels, (100 * (10 ** self.residual.mean(0) - 1)).round(2).tolist())),
            "correction_factor_by_curve": dict(zip(self.labels, (10 ** self.bias).round(4).tolist())),
            "nfev": self.nfev,
        }


class Inverter:
    """Parallel finite-difference Levenberg-Marquardt (trust-region) fit for one window."""

    def __init__(self, data: IntervalData, cfg: FitConfig, receiver_sep_in=8.0, workers=None, on_eval=None,
                 pool=None, station_idx=None):
        self.data, self.cfg = data, cfg
        self.on_eval = on_eval
        az = float(np.rad2deg(np.arctan2(data.traj.axis[:, 1].mean(), data.traj.axis[:, 0].mean())))
        self.lay = Layout(cfg, data.obs.shape[1], az)
        self.ref_idx = np.array([data.labels.index(r) for r in cfg.reference if r in data.labels])
        w = cfg.curve_weights or {}
        sig = cfg.curve_sigma or {}
        self.w = np.array([float(w.get(lab, 1.0)) / float(sig.get(lab, cfg.sigma)) for lab in data.labels])
        self._owns_pool = pool is None
        self.station_idx = None if station_idx is None else np.asarray(station_idx)
        self.pool = pool or worker_pool(data.traj, workers or min(16, self.lay.n_earth + 1), receiver_sep_in,
                                        cfg.azimuthal, cfg.forward_options)
        self._cache = {}

    def close(self):
        if self._owns_pool:
            self.pool.shutdown()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _theory_batch(self, xs):
        keys = [tuple(np.round(x[:self.lay.n_earth], 10)) for x in xs]
        todo = [(k, x) for k, x in zip(keys, xs) if k not in self._cache]
        uniq = dict(todo)
        if uniq:
            tasks = [self.lay.model(x) if self.station_idx is None else (self.lay.model(x), self.station_idx)
                     for x in uniq.values()]
            for k, p in zip(uniq, self.pool.map(_predict, tasks)):
                self._cache[k] = p
        if len(self._cache) > 64:
            for k in list(self._cache)[:-32]:
                if k not in keys:
                    del self._cache[k]
        return [self._cache[k] for k in keys]

    def _corrected(self, theory):
        lc = self.cfg.level_correction
        return theory if lc is None else lc.apply_to_theory(theory)

    def _dcorr(self):
        lc = self.cfg.level_correction
        return np.ones(self.lay.n_curves) if lc is None else 1.0 + lc.g

    def _resid(self, x, theory):
        # Zero-weight channels are carried for display only; mask them so a NaN there (NaN * 0 = NaN) cannot
        # poison the fit.
        diff = (self._corrected(theory) + self.lay.bias(x) - self.data.obs) * self.w
        r = np.where(self.w > 0, diff, 0.0).ravel()
        prior = self.lay.prior_rows(x)[0]
        if not self.cfg.fit_bias:
            return np.concatenate([r, prior])
        b = self.lay.bias(x)
        bias_prior = b / self.cfg.bias_prior
        ref = np.array([b[self.ref_idx].sum() * 100.0])
        return np.concatenate([r, bias_prior, ref, prior])

    def fun(self, x):
        r = self._resid(x, self._theory_batch([x])[0])
        if self.on_eval:
            self.on_eval(self, x, r)
        return r

    def jac(self, x):
        ne = self.lay.n_earth
        steps = self.lay.steps()
        xs = [x]
        for j in range(ne):
            xp = x.copy(); xp[j] += steps[j]; xs.append(xp)
        th = self._theory_batch(xs)
        n, m = self.data.obs.shape
        J = np.zeros((len(self._resid(x, th[0])), self.lay.n_params))
        for j in range(ne):
            col = (th[j + 1] - th[0]) / steps[j] * self.w * self._dcorr()
            J[:n * m, j] = np.where(np.isfinite(col) & (self.w > 0), col, 0.0).ravel()
        if self.cfg.fit_bias:
            nb = self.lay.n_curves
            J[:n * m, ne:] = np.tile(np.diag(self.w), (n, 1))
            J[n * m:n * m + nb, ne:] = np.eye(nb) / self.cfg.bias_prior
            J[n * m + nb, ne + self.ref_idx] = 100.0
        prior_jac = self.lay.prior_rows(x)[1]
        if len(prior_jac):
            J[-len(prior_jac):] = prior_jac
        return J

    def check_start(self, x0):
        """Raise a ValueError naming the channels/stations that make the residual non-finite at ``x0``."""
        theory = self._theory_batch([x0])[0]
        r = self._resid(x0, theory).reshape(-1)[:theory.size].reshape(theory.shape)
        if np.isfinite(r).all():
            return
        problems = []
        for j in np.flatnonzero(~np.isfinite(r).all(axis=0)):
            rows = np.flatnonzero(~np.isfinite(r[:, j]))
            what = ("model prediction" if not np.isfinite(theory[rows, j]).all()
                    else "measured data" if not np.isfinite(self.data.obs[rows, j]).all() else "weight/sigma")
            md = ", ".join(f"{v:.0f}" for v in self.data.md_ft[rows[:3]])
            problems.append(f"{self.data.labels[j]}: non-finite {what} at {rows.size} station(s) (MD {md} ft)")
        raise ValueError("start model gives non-finite residuals; " + "; ".join(problems))

    def fit(self, x0):
        tvd_rel = self.data.tvd_rel_ft(self.data.tvd_ft)
        lo, hi = self.lay.bounds(tvd_rel.min() - 40, tvd_rel.max() + 40)
        x0 = np.clip(np.asarray(x0, float), lo + 1e-9, hi - 1e-9)
        if not np.isfinite(x0).all():
            raise ValueError(f"start model has non-finite parameters: {x0}")
        self.check_start(x0)
        sol = least_squares(self.fun, x0, jac=self.jac, bounds=(lo, hi), method="trf",
                            x_scale="jac", max_nfev=self.cfg.max_nfev)
        theory = self._theory_batch([sol.x])[0]
        bias = self.lay.bias(sol.x)
        pred = self._corrected(theory) + bias
        return FitResult(sol.x, self.lay.model(sol.x), bias, pred, theory, self.data.obs - pred,
                         self.data.labels, float(sol.cost), int(sol.nfev), {"jac": np.asarray(sol.jac)})

    def multistart(self, starts):
        """Best fit over the starts; a start that cannot be evaluated is skipped, not fatal."""
        best, errors = None, []
        for x0 in starts:
            try:
                r = self.fit(x0)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            if best is None or r.cost < best.cost:
                best = r
        if best is None:
            raise ValueError("no start model could be evaluated: " + " | ".join(dict.fromkeys(errors)))
        return best

    def x_from(self, boundaries_rel_ft, log_rh, log_aniso, dip=0.0, bias=None, cross_dip=0.0):
        b = list(boundaries_rel_ft)
        layer_part = ([b[0]] + list(np.diff(b))) if b else []
        x = layer_part + list(log_rh) + list(np.atleast_1d(log_aniso)[:self.lay.n_aniso])
        if self.cfg.fit_dip:
            x.append(dip)
        if self.cfg.fit_cross_dip:
            x.append(cross_dip)
        if self.cfg.fit_bias:
            x += list(np.zeros(self.lay.n_curves) if bias is None else bias)
        return np.array(x, float)


def default_run_path(data_dir: str | Path, well_token: str):
    hits = sorted(Path(data_dir).glob(f"*{well_token}*.dlis"))
    if not hits:
        raise FileNotFoundError(f"no DLIS matching {well_token} in {data_dir}")
    return hits[0]


def default_starts(inv: Inverter, data: IntervalData, k: int, bias=None, weights=None):
    """Three starts that slide the first boundary through the TVD range of the window, with the low and
    high resistivity levels taken from the weighted phase resistivities (else any weighted resistivity)."""
    w = np.ones(len(data.labels)) if weights is None else np.asarray(weights, float)
    res = data.is_log() & (w > 0)
    phase = np.array([lab[-1] == "P" or lab[-2:] in ("PT", "PB") for lab in data.labels])
    cols = np.flatnonzero(res & phase)
    if not cols.size:
        cols = np.flatnonzero(res) if res.any() else np.flatnonzero(data.is_log())
    level = 10 ** np.median(data.obs[:, cols], axis=1)
    if k == 1:
        return [inv.x_from([], [np.log10(np.median(level))], 0.1, 0.0, bias)]
    tvd = data.tvd_rel_ft(data.tvd_ft)
    low, high = np.log10(np.percentile(level, 15)), np.log10(np.percentile(level, 90))
    starts = []
    for b1 in np.linspace(tvd.min(), tvd.max() + 5, 3):
        bs = [b1 + 6 * j for j in range(k - 1)]
        rh = [low, high] + [0.5 * (low + high)] * (k - 2)
        starts.append(inv.x_from(bs, rh[:k], 0.1, 0.0, bias))
    return starts


@dataclass
class LevelCorrection:
    """Per-curve, resistivity-dependent correction in log space:

        log10 R_measured = log10 R_theory + a_c + g_c * (log10 R_theory - pivot)

    ``g_c = 0`` reduces to a constant multiplicative factor ``10**a_c``. Curves not listed are
    left uncorrected. Fit on residuals from a model that did not use the corrected curves.
    """

    labels: list
    a: np.ndarray
    g: np.ndarray
    pivot: float = 1.0

    @classmethod
    def fit(cls, theory, obs, labels, curves, gain=True, pivot=1.0):
        a = np.zeros(len(labels)); g = np.zeros(len(labels))
        for lab in curves:
            j = labels.index(lab)
            x = theory[:, j] - pivot
            A = np.column_stack([np.ones_like(x), x]) if gain else np.ones((len(x), 1))
            coef, *_ = np.linalg.lstsq(A, obs[:, j] - theory[:, j], rcond=None)
            a[j] = coef[0]; g[j] = coef[1] if gain else 0.0
        return cls(list(labels), a, g, pivot)

    @classmethod
    def from_table(cls, labels, table, pivot=1.0):
        """table: {curve: (a, g)} in decades, e.g. Z20_ATTENUATION_CORRECTION."""
        a = np.array([table.get(lab, (0.0, 0.0))[0] for lab in labels], float)
        g = np.array([table.get(lab, (0.0, 0.0))[1] for lab in labels], float)
        return cls(list(labels), a, g, pivot)

    def apply_to_theory(self, theory):
        return theory + self.a + self.g * (theory - self.pivot)

    def to_measured_frame(self):
        return {lab: {"factor_at_10_ohmm": round(float(10 ** self.a[j]), 4),
                      "gain_per_decade": round(float(self.g[j]), 4),
                      "factor_at_40_ohmm": round(float(10 ** (self.a[j] + self.g[j] * (np.log10(40) - self.pivot))), 4)}
                for j, lab in enumerate(self.labels) if self.a[j] or self.g[j]}
