"""JAX port of the ADR forward model (``ADRForward``): GPU-ready, differentiable, batched.

The layered-TIV magnetic-dipole kernel is a port of the tested UDAR_Bench engine (``UDAR_Bench/source/src/engine1d.js``):
TE/TM reflection recursions, the three source/receiver layer cases, the closed-form full-space direct term, and the
``key_201_2012`` digital-linear-filter Hankel transform. Everything is vectorised over stations x Tx-Rx pairs x
frequencies x filter points, so one call evaluates a whole window, and ``jax.jacfwd`` gives an exact Jacobian.

Channel assembly (compensation, top/bottom bins, geosignals, the guessed long-spacing layout, the whole-space
apparent-resistivity transform) follows ``ADRForward`` exactly; ``tests/test_jax_forward.py`` checks parity with
the empymod path.

Limitation: when the tool axis is within ~3 deg of the bed normal (vertical well, flat beds) the horizontal Tx-Rx
offset is floored at 5% of the spacing instead of using the engine's near-axis extrapolation. All Ekofisk runs are
high-angle, so this never applies there; ``near_axis_fraction`` reports it.
"""

from __future__ import annotations

from functools import partial

import empymod
import numpy as np

import jax
import jax.numpy as jnp

from backend.inversion.adr_forward import FT, INCH, ADRForward

jax.config.update("jax_enable_x64", True)
# Compiled kernels persist across processes (backend restarts, workers); the first compile per shape takes ~30 s.
jax.config.update("jax_compilation_cache_dir",
                  __import__("os").environ.get("RESIST_JAX_CACHE", str(__import__("pathlib").Path.home() / ".cache" / "resist-jax")))
jax.config.update("jax_persistent_cache_min_compile_time_secs", 1.0)
STATION_BUCKET = 32         # station counts are padded to a multiple of this so windows share compiled shapes

MU0 = 4e-7 * np.pi
EPS0 = 8.854187817e-12
EPERM = 1.0                 # relative permittivity, as empymod's default (displacement currents included)
RHO_FLOOR = 0.05            # fraction of |L|: near-axis floor (see module docstring)


def _filter():
    f = empymod.filters.key_201_2012()
    return np.asarray(f.base), np.asarray(f.j0), np.asarray(f.j1)


# ----------------------------------------------------------------------------------------------- layered kernel
def _onehot(idx, n, dtype=None):
    return jax.nn.one_hot(idx, n, dtype=dtype or jnp.int8)          # int8 keeps the caller's float precision


def _pick(arr, oh):
    """arr (..., N) complex, oh (M, N) -> (M, ...) selected along the last axis (M broadcast as leading dim)."""
    return jnp.sum(arr * oh[:, None, None, :], axis=-1)


def _safe_exp(g, dist, valid):
    """exp(-g dist) where valid, else 0, with gradients that stay finite for the masked (infinite) entries."""
    d = jnp.where(valid, dist, 0.0)
    return jnp.where(valid, jnp.exp(-g * d), 0.0)


def _modes(lam2, kap2, wms, inv_sh, thick, finite):
    """Per mode (TE, TM): g, Ed, E2, RD, RU, each (M, F, Q, N)."""
    out = []
    n = kap2.shape[-1]
    for tm in (False, True):
        a = (kap2 * lam2) if tm else (lam2 + 0.0 * kap2)
        g = jnp.sqrt(a - 1j * wms)
        y = g * inv_sh if tm else g
        ed = jnp.where(finite, jnp.exp(-g * jnp.where(finite, thick, 0.0)), 0.0)
        e2 = ed * ed
        rd = [None] * n
        rd[n - 1] = jnp.zeros_like(g[..., 0])
        for j in range(n - 2, -1, -1):
            r = (y[..., j] - y[..., j + 1]) / (y[..., j] + y[..., j + 1])
            t = rd[j + 1] * e2[..., j + 1]
            rd[j] = (r + t) / (1 + r * t)
        ru = [None] * n
        ru[0] = jnp.zeros_like(g[..., 0])
        for j in range(1, n):
            r = (y[..., j] - y[..., j - 1]) / (y[..., j] + y[..., j - 1])
            t = ru[j - 1] * e2[..., j - 1]
            ru[j] = (r + t) / (1 + r * t)
        out.append((g, ed, e2, jnp.stack(rd, -1), jnp.stack(ru, -1)))
    return out


def _greens(mode, s, r, zs, zr, top, bot, n):
    """G, Gz, Gs, Gzs for one mode; s, r (M,) int layer indices; zs, zr (M,); top/bot (N,) with +-inf halfspaces."""
    g, ed, e2, rd, ru = mode
    oh = lambda idx: _onehot(jnp.clip(idx, 0, n - 1), n)
    ohs, ohr = oh(s), oh(r)
    gs, eds, e2s, rup, rdn = (_pick(v, ohs) for v in (g, ed, e2, ru, rd))
    gr, edr, rur, rdr = (_pick(v, ohr) for v in (g, ed, ru, rd))
    zs_, zr_ = zs[:, None, None], zr[:, None, None]
    top_s, bot_s = (jnp.sum(jnp.where(ohs > 0, v, 0.0), -1)[:, None, None] for v in
                    (jnp.where(jnp.isfinite(top), top, 0.0), jnp.where(jnp.isfinite(bot), bot, 0.0)))
    top_r, bot_r = (jnp.sum(jnp.where(ohr > 0, v, 0.0), -1)[:, None, None] for v in
                    (jnp.where(jnp.isfinite(top), top, 0.0), jnp.where(jnp.isfinite(bot), bot, 0.0)))
    has_top_s, has_bot_s = (s > 0)[:, None, None], (s < n - 1)[:, None, None]
    has_top_r, has_bot_r = (r > 0)[:, None, None], (r < n - 1)[:, None, None]

    i2 = 1.0 / (2.0 * gs)
    ea = _safe_exp(gs, zs_ - top_s, has_top_s)
    eb = _safe_exp(gs, bot_s - zs_, has_bot_s)
    de = 1.0 - rup * rdn * e2s
    rdeb, ruea = rdn * eds * eb, rup * eds * ea
    dt = rup * i2 * (ea + rdeb) / de
    ub = rdn * i2 * (eb + ruea) / de
    dd = -0.5 * rup * (ea - rdeb) / de
    du = 0.5 * rdn * (eb - ruea) / de

    # same layer (reflected part only; the direct field is added analytically)
    ez1 = _safe_exp(gs, zr_ - top_s, has_top_s)
    ez2 = _safe_exp(gs, bot_s - zr_, has_bot_s)
    p1, p2 = dt * ez1, ub * ez2
    q1, q2 = dd * ez1, du * ez2
    same = (p1 + p2, gs * (p2 - p1), q1 + q2, gs * (q2 - q1))

    # receiver above the source layer
    ut = ea * i2 + ub * eds
    dut = -0.5 * ea + du * eds
    sm1 = _onehot(jnp.clip(s - 1, 0, n - 1), n)
    c_up = (1 + rup) / (1 + _pick(ru, sm1) * _pick(e2, sm1))
    for j in range(n - 1):
        f = ed[..., j + 1] * (1 + ru[..., j + 1]) / (1 + ru[..., j] * e2[..., j])
        use = ((r <= j) & (j <= s - 2))[:, None, None]
        c_up = c_up * jnp.where(use, f, 1.0)
    up = _safe_exp(gr, bot_r - zr_, has_bot_r)
    dn = _safe_exp(gr, zr_ - top_r, has_top_r)
    rdn_ = rur * edr * dn
    w, wz = up + rdn_, gr * (up - rdn_)
    a_, b_ = ut * c_up, dut * c_up
    above = (a_ * w, a_ * wz, b_ * w, b_ * wz)

    # receiver below the source layer
    db = eb * i2 + dt * eds
    ddb = 0.5 * eb + dd * eds
    sp1 = _onehot(jnp.clip(s + 1, 0, n - 1), n)
    c_dn = (1 + rdn) / (1 + _pick(rd, sp1) * _pick(e2, sp1))
    for j in range(1, n - 1):
        f = ed[..., j] * (1 + rd[..., j]) / (1 + rd[..., j + 1] * e2[..., j + 1])
        use = ((s + 1 <= j) & (j <= r - 1))[:, None, None]
        c_dn = c_dn * jnp.where(use, f, 1.0)
    dn2 = _safe_exp(gr, zr_ - top_r, has_top_r)
    up2 = _safe_exp(gr, bot_r - zr_, has_bot_r)
    ru_ = rdr * edr * up2
    v, vz = dn2 + ru_, gr * (ru_ - dn2)
    a2, b2 = db * c_dn, ddb * c_dn
    below = (a2 * v, a2 * vz, b2 * v, b2 * vz)

    sel_same, sel_above = (r == s)[:, None, None], (r < s)[:, None, None]
    return tuple(jnp.where(sel_same, x, jnp.where(sel_above, y, z)) for x, y, z in zip(same, above, below))


def _direct(omega, sh, sv, rho, dz):
    """Closed-form full-space TIV tensor (xx, yy, zz, xz, zx) for a source and receiver in the same layer.

    sh, sv may be complex conductivities (displacement currents included)."""
    kap = jnp.sqrt(sh / sv)
    kh = jnp.sqrt(1j * omega * MU0 * sh)
    kv = jnp.sqrt(1j * omega * MU0 * sv)
    R, Rv = jnp.hypot(rho, dz), jnp.sqrt(rho ** 2 + (kap * dz) ** 2)
    eh, ev = jnp.exp(1j * kh * R), jnp.exp(1j * kv * Rv)
    ph, ps = eh / R, ev / Rv
    kh2, kv2 = kh * kh, kv * kv
    f1 = (1j * kh - 1 / R) * ph
    f1p = ph * (-kh2 - 2j * kh / R + 2 / R ** 2)
    d2z = (1 / R - dz ** 2 / R ** 3) * f1 + (dz ** 2 / R ** 2) * f1p
    dr = (rho * dz / R ** 2) * (f1p - f1 / R)
    q = 1 / (4 * np.pi)
    coef = 1j * kh * q / rho ** 2
    diff = eh - ev
    return (-q * (d2z + f1 / R) + coef * diff, q * (f1 / R + kap * kv2 * ps) - coef * diff,
            q * (d2z + kh2 * ph), q * dr, q * dr)


def tensor(omega, zi, sh, sv, zs, zr, rho, base, j0, j1, eperm=EPERM):
    """Formation-frame magnetic tensor (xx, yy, zz, xz, zx) per unit moment, e^{-iwt}.

    omega (F,); layers zi (N-1,), sh/sv (N,) real conductivities; geometry zs, zr, rho (M,). Returns 5 arrays (M, F).
    Displacement currents enter through the complex conductivity sigma - i w eps0 eperm."""
    n = sh.shape[0]
    inf = jnp.full((1,), jnp.inf, zi.dtype if zi.size else sh.dtype)
    top = jnp.concatenate([inf * -1, zi.astype(inf.dtype)])
    bot = jnp.concatenate([zi.astype(inf.dtype), inf])
    thick = bot - top
    finite = jnp.isfinite(thick)
    s = jnp.sum(zi[None, :] < zs[:, None], axis=1)
    r = jnp.sum(zi[None, :] < zr[:, None], axis=1)
    disp = 1j * omega[:, None] * EPS0 * eperm                             # (F, 1)
    shc, svc = sh[None, :] - disp, sv[None, :] - disp                     # (F, N) complex
    lam = base[None, None, :] / rho[:, None, None]                       # (M, 1, Q)
    lam2 = (lam * lam)[..., None]                                         # (M, 1, Q, 1)
    wms_fn = omega[:, None] * MU0 * shc                                   # (F, N)
    wms = wms_fn[None, :, None, :]
    kap2 = (shc / svc)[None, :, None, :]
    modes = _modes(lam2, kap2, wms, (1.0 / shc)[None, :, None, :], thick, finite)
    te = _greens(modes[0], s, r, zs, zr, top, bot, n)
    tm_g = _greens(modes[1], s, r, zs, zr, top, bot, n)[0]
    ohs = _onehot(s, n)
    k2i = jnp.einsum("mn,fn->mf", ohs, wms_fn)
    gm = 1j * k2i[..., None] * tm_g                                       # (M, F, Q)
    g_te, gz_te, gs_te, gzs_te = te
    w0, w1 = j0[None, None, :], j1[None, None, :]
    lam_ = lam
    zz = jnp.sum(lam_ ** 3 * w0 * g_te, -1)
    zx = jnp.sum(lam_ ** 2 * w1 * gs_te, -1)
    xz = -jnp.sum(lam_ ** 2 * w1 * gz_te, -1)
    x0 = jnp.sum(lam_ * w0 * gzs_te, -1)
    x1 = jnp.sum(w1 * (gm - gzs_te), -1)
    y0 = jnp.sum(lam_ * w0 * gm, -1)
    y1 = jnp.sum(w1 * (gzs_te - gm), -1)
    q, ir = 1 / (2 * np.pi), (1.0 / rho)[:, None]
    t = [q * (ir * x0 + ir ** 2 * x1), q * (ir * y0 + ir ** 2 * y1), q * ir * zz, q * ir * xz, q * ir * zx]
    same = (r == s)[:, None]
    sh_s = jnp.einsum("mn,fn->mf", ohs, shc)
    sv_s = jnp.einsum("mn,fn->mf", ohs, svc)
    d = _direct(omega[None, :], sh_s, sv_s, rho[:, None], (zr - zs)[:, None])
    return tuple(ti + jnp.where(same, di, 0.0) for ti, di in zip(t, d))


def _voltage(T, a, b):
    """b^T H a for formation-frame tensor components T = (xx, yy, zz, xz, zx) and antenna vectors (..., 3)."""
    xx, yy, zz, xz, zx = T
    return (xx * b[..., 0] * a[..., 0] + yy * b[..., 1] * a[..., 1] + zz * b[..., 2] * a[..., 2]
            + xz * b[..., 0] * a[..., 2] + zx * b[..., 2] * a[..., 0])


# ----------------------------------------------------------------------------------------------- ADR assembly
class JaxADRForward:
    """Same channels, label order and units as ``ADRForward.predict``, as a pure jittable function."""

    def __init__(self, fwd: ADRForward, dtype=jnp.float64):
        self.fwd = fwd
        self.dtype = dtype
        self.labels = fwd.channel_labels()
        base, j0, j1 = _filter()
        self.base, self.j0, self.j1 = (jnp.asarray(v, dtype) for v in (base, j0, j1))
        self.omega = jnp.asarray(2 * np.pi * fwd.freqs, dtype)
        self.polarity = fwd._polarity() if fwd.azimuthal else 1
        c, s_ = np.cos(np.deg2rad(fwd.tilt_deg)), np.sin(np.deg2rad(fwd.tilt_deg))
        self.tilt = (float(c), float(s_))
        ns = len(fwd.spacings)
        self.ns = ns
        half = 0.5 * fwd.receiver_sep_in * INCH
        rx = {"near_up": -half, "near_dn": half}
        tx = {f"up{i}": -fwd.spacings[i] * INCH for i in range(ns)}
        tx.update({f"dn{i}": fwd.spacings[i] * INCH for i in range(ns)})
        pairs = [(t, r_) for r_ in ("near_up", "near_dn") for t in list(tx)]
        if fwd.azimuthal:
            if fwd.geosignals:
                rx["geo"] = 0.0
                for j, g in enumerate(fwd.geosignals):
                    tx[f"geo{j}"] = -g.spacing_in * INCH
                    pairs.append((f"geo{j}", "geo"))
            if fwd.long_spacings:
                rx["ls"] = fwd.ls_receiver_in * INCH
                self.ls_tx = []
                for j, ch in enumerate(fwd.long_spacings):
                    d = ch.spacing_in - fwd.ls_receiver_in
                    hit = np.flatnonzero(np.isclose(fwd.spacings, d))
                    name = f"up{int(hit[0])}" if hit.size else f"lsx{j}"
                    if not hit.size:
                        tx[name] = -d * INCH
                    self.ls_tx.append(name)
                    pairs += [(name, "ls"), (name, "near_dn")]
        self.pairs = list(dict.fromkeys(pairs))
        self.pair_index = {p: i for i, p in enumerate(self.pairs)}
        self.tx_off = np.array([tx[t] for t, _ in self.pairs])
        self.rx_off = np.array([rx[r_] for _, r_ in self.pairs])
        self.fi = {f: int(np.searchsorted(fwd.freqs, f)) for f in fwd.freqs}
        self._tables = None
        self._predict_jit = jax.jit(self.predict_arrays)

    # -- geometry and raw voltages ----------------------------------------------------------------
    def _station_frames(self, n, axis, high):
        x = axis - (axis @ n)[:, None] * n[None, :]
        nx = jnp.linalg.norm(x, axis=1, keepdims=True)
        xh = high - (high @ n)[:, None] * n[None, :]
        x = jnp.where(nx > 1e-9, x / jnp.maximum(nx, 1e-30), xh / jnp.linalg.norm(xh, axis=1, keepdims=True))
        y = jnp.cross(jnp.broadcast_to(n, x.shape), x)
        basis = jnp.stack([x, y, jnp.broadcast_to(n, x.shape)], axis=1)        # (S, 3, 3)
        return jnp.einsum("sij,sj->si", basis, axis), jnp.einsum("sij,sj->si", basis, high)

    def _tensors(self, zi, sh, sv, zc, t_f):
        """Tensor per (station, pair, freq); also the pair-frame sign of the offset. Shapes (S, P, F)."""
        dt = self.dtype
        tx, rx = jnp.asarray(self.tx_off, dt), jnp.asarray(self.rx_off, dt)
        L = rx - tx
        zs = zc[:, None] + tx[None, :] * t_f[:, None, 2]
        zr = zc[:, None] + rx[None, :] * t_f[:, None, 2]
        horiz = jnp.sqrt(jnp.maximum(1.0 - t_f[:, 2] ** 2, 0.0))
        rho = jnp.maximum(jnp.abs(L)[None, :] * horiz[:, None], RHO_FLOOR * jnp.abs(L)[None, :])
        S, P = zs.shape
        T = tensor(self.omega, zi, sh, sv, zs.reshape(-1), zr.reshape(-1), rho.reshape(-1),
                   self.base, self.j0, self.j1)
        return tuple(t.reshape(S, P, -1) for t in T), jnp.sign(L)

    def _volt(self, T, sgn, t_f, b_f, pair, fi):
        """Voltage of one pair at frequency index fi for Tx along the tool axis and receiver direction b_f (S, 3)."""
        p = self.pair_index[pair]
        flip = jnp.array([1.0, 1.0, 0.0], self.dtype) * (sgn[p] - 1.0) + 1.0     # x, y flip with the offset sign
        Tp = tuple(t[:, p, fi] for t in T)
        return _voltage(Tp, t_f * flip, b_f * flip)

    def raw(self, zi, sh, sv, zc, t_f, h_f):
        """Compensated phase (deg) and attenuation (dB) per kind, exactly as ADRForward._raw / _raw_azimuthal."""
        fwd = self.fwd
        T, sgn = self._tensors(zi, sh, sv, zc, t_f)
        c, s_ = self.tilt
        look = {"T": self.polarity * h_f, "B": -self.polarity * h_f}
        rdir = {"A": t_f, "T": c * t_f + s_ * look["T"], "B": c * t_f + s_ * look["B"]}
        out = {}

        def angle(z):
            return jnp.rad2deg(jnp.angle(z))

        avg_p, avg_a, tb = [], [], {"T": ([], []), "B": ([], [])}
        for ch in fwd.channels:
            fi = self.fi[ch.frequency_hz]
            si = int(np.searchsorted(fwd.spacings, ch.spacing_in))
            V = lambda t, r_, k: self._volt(T, sgn, t_f, rdir[k], (t, r_), fi)
            up = V(f"up{si}", "near_up", "A") / V(f"up{si}", "near_dn", "A")
            dn = V(f"dn{si}", "near_dn", "A") / V(f"dn{si}", "near_up", "A")
            avg_p.append(-0.5 * (angle(up) + angle(dn)))
            avg_a.append(10 * (jnp.log10(jnp.abs(up)) + jnp.log10(jnp.abs(dn))))
            if fwd.azimuthal:
                for key, (ku, kd) in {"T": ("T", "B"), "B": ("B", "T")}.items():
                    up = V(f"up{si}", "near_up", ku) / V(f"up{si}", "near_dn", ku)
                    dn = V(f"dn{si}", "near_dn", kd) / V(f"dn{si}", "near_up", kd)
                    tb[key][0].append(-0.5 * (angle(up) + angle(dn)))
                    tb[key][1].append(10 * (jnp.log10(jnp.abs(up)) + jnp.log10(jnp.abs(dn))))
        out["avg"] = (jnp.stack(avg_p, -1), jnp.stack(avg_a, -1))
        if not fwd.azimuthal:
            return out, None
        out["T"] = tuple(jnp.stack(v, -1) for v in tb["T"])
        out["B"] = tuple(jnp.stack(v, -1) for v in tb["B"])
        if fwd.long_spacings:
            for key, k in (("LT", "T"), ("LB", "B")):
                ph, at = [], []
                for ch, tname in zip(fwd.long_spacings, self.ls_tx):
                    fi = self.fi[ch.frequency_hz]
                    ratio = (self._volt(T, sgn, t_f, rdir[k], (tname, "near_dn"), fi)
                             / self._volt(T, sgn, t_f, rdir[k], (tname, "ls"), fi))
                    ph.append(-angle(ratio)); at.append(20 * jnp.log10(jnp.abs(ratio)))
                out[key] = (jnp.stack(ph, -1), jnp.stack(at, -1))
        gs = []
        for j, g in enumerate(fwd.geosignals):
            fi = self.fi[g.frequency_hz]
            vt = self._volt(T, sgn, t_f, rdir["T"], (f"geo{j}", "geo"), fi)
            vb = self._volt(T, sgn, t_f, rdir["B"], (f"geo{j}", "geo"), fi)
            gs += [angle(vt / vb), 20 * jnp.log10(jnp.abs(vb / vt))]
        return out, (jnp.stack(gs, -1) if gs else None)

    # -- whole-space transform ---------------------------------------------------------------------
    def tables(self):
        """Homogeneous-isotropic transform tables from this same kernel (exact self-consistency)."""
        if self._tables is None:
            grid = np.asarray(self.fwd.rho_grid)
            t_f = jnp.array([[1.0, 0.0, 0.0]])
            h_f = jnp.array([[0.0, 0.0, -1.0]])

            def one(r):
                sh = jnp.array([1.0 / r]); out, _ = self.raw(jnp.zeros((0,)), sh, sh, jnp.zeros(1), t_f, h_f)
                return out

            res = jax.jit(jax.vmap(one))(jnp.asarray(grid))
            tabs = {}
            for key in ("avg", "LT"):
                if key in res:
                    ph, at = (np.asarray(v)[:, 0, :] for v in res[key])
                    ph = np.maximum.accumulate(ph[::-1], axis=0)[::-1]
                    at = np.minimum.accumulate(at, axis=0)
                    tabs[key] = (jnp.asarray(ph), jnp.asarray(at))
            self._tables = (jnp.asarray(np.log10(grid)), tabs)
        return self._tables

    def apparent(self, phase, atten, key):
        lr, tabs = self.tables()
        ph_t, at_t = tabs["LT" if key in ("LT", "LB") else "avg"]
        rp = jnp.stack([10 ** jnp.interp(-phase[:, k], -ph_t[:, k], lr) for k in range(phase.shape[1])], -1)
        ra = jnp.stack([10 ** jnp.interp(-atten[:, k], -at_t[:, k], lr) for k in range(atten.shape[1])], -1)
        return rp, ra

    # -- full prediction -----------------------------------------------------------------------------
    def predict_arrays(self, bounds_m, rh, rv, dip_deg, dip_az_deg, ned, axis, high):
        """All channel_labels() in inversion units (log10 ohm-m, deg, dB). Pure function of jnp arrays."""
        d, a = jnp.deg2rad(dip_deg), jnp.deg2rad(dip_az_deg)
        n = jnp.stack([-jnp.sin(d) * jnp.cos(a), -jnp.sin(d) * jnp.sin(a), jnp.cos(d)])
        zi = bounds_m * n[2]
        sh, sv = 1.0 / rh, 1.0 / rv
        zc = ned @ n
        t_f, h_f = self._station_frames(n, axis, high)
        out, gs = self.raw(zi, sh, sv, zc, t_f, h_f)
        cols = []
        rp, ra = self.apparent(*out["avg"], "avg")
        cols += [jnp.log10(rp), jnp.log10(ra)]
        if self.fwd.azimuthal:
            for top, bottom in (("T", "B"), ("LT", "LB")):
                if top not in out:
                    continue
                rt, rb = self.apparent(*out[top], top), self.apparent(*out[bottom], bottom)
                for m in (0, 1):
                    cols.append(jnp.log10(jnp.stack([rt[m], rb[m]], -1).reshape(rt[m].shape[0], -1)))
            if gs is not None:
                cols.append(gs)
        return jnp.concatenate(cols, axis=1)

    def predict(self, model, traj):
        """Drop-in for ADRForward.predict (numpy in, numpy out)."""
        high = traj.high if traj.high is not None else np.tile([0.0, 0.0, -1.0], (len(traj), 1))
        self.tables()                                   # build before tracing (needs concrete arrays)
        f = self._predict_jit
        return np.asarray(f(jnp.asarray(model.boundaries_m, self.dtype), jnp.asarray(model.rh, self.dtype),
                            jnp.asarray(model.rv, self.dtype), jnp.asarray(model.dip_deg, self.dtype),
                            jnp.asarray(model.dip_azimuth_deg, self.dtype), jnp.asarray(traj.ned, self.dtype),
                            jnp.asarray(traj.axis, self.dtype), jnp.asarray(high, self.dtype)))

    def near_axis_fraction(self, model, traj):
        return float(np.mean(np.abs(traj.axis @ model.normal()) > np.cos(np.deg2rad(3.0))))


# ----------------------------------------------------------------------------------------------- inversion hook
def layout_to_model(x, k, n_aniso, fit_dip):
    """jnp version of invert.Layout.model: x (earth params) -> (bounds_m, rh, rv, dip_deg)."""
    i = k - 1
    bounds = (jnp.cumsum(x[:k - 1]) * FT) if k > 1 else jnp.zeros((0,), x.dtype)
    rh = 10 ** x[i:i + k]
    la = x[i + k:i + k + n_aniso]
    rv = rh * 10 ** (jnp.repeat(la, k) if n_aniso == 1 else la)
    dip = x[i + k + n_aniso] if fit_dip else jnp.asarray(0.0, x.dtype)
    return bounds, rh, rv, dip


class JaxTheory:
    """Theory and exact Jacobian of one window for the Inverter (``RESIST_COMPUTE=jax``).

    Compiled functions are shared across windows: geometry is an argument, not a closure constant, so XLA only
    recompiles for a new (layers, station count) shape."""

    def __init__(self, fwd: ADRForward, traj, k, n_aniso, fit_dip, dip_azimuth, precision=64):
        dt = jnp.float32 if precision == 32 else jnp.float64
        self.dt = dt
        jf = shared_jax_forward(fwd, dt)
        high = traj.high if traj.high is not None else np.tile([0.0, 0.0, -1.0], (len(traj), 1))
        self.n = len(traj)
        size = max(STATION_BUCKET, -(-self.n // STATION_BUCKET) * STATION_BUCKET)
        pad = lambda v: np.concatenate([v, np.repeat(v[-1:], size - self.n, axis=0)])       # padded rows dropped
        self.args = (jnp.asarray(dip_azimuth, dt),) + tuple(jnp.asarray(pad(v), dt) for v in (traj.ned, traj.axis, high))
        self._f, self._j = _compiled(jf, k, n_aniso, fit_dip)

    def __call__(self, x):
        return np.asarray(self._f(jnp.asarray(x, self.dt), *self.args), np.float64)[:self.n]

    def jacobian(self, x):
        return np.asarray(self._j(jnp.asarray(x, self.dt), *self.args), np.float64)[:self.n]   # (stations, labels, params)


_COMPILED: dict = {}


def _compiled(jf, k, n_aniso, fit_dip):
    key = (id(jf), k, n_aniso, fit_dip)
    if key not in _COMPILED:
        def theory(x, dip_az, ned, axis, high):
            b, rh, rv, dip = layout_to_model(x, k, n_aniso, fit_dip)
            return jf.predict_arrays(b, rh, rv, dip, dip_az, ned, axis, high)

        _COMPILED[key] = (jax.jit(theory), jax.jit(jax.jacfwd(theory)))
    return _COMPILED[key]


_SHARED: dict = {}


def shared_jax_forward(fwd: ADRForward, dtype=jnp.float64) -> JaxADRForward:
    key = (fwd.receiver_sep_in, fwd.azimuthal, fwd.tilt_deg, fwd.ls_receiver_in, jnp.dtype(dtype).name)
    if key not in _SHARED:
        jf = JaxADRForward(fwd, dtype)
        jf.tables()
        _SHARED[key] = jf
    return _SHARED[key]
