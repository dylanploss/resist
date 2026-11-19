"""Batched bounded Levenberg-Marquardt in JAX: many (window x start) 1.5D fits in one compiled loop.

Each problem has its own window (trajectory, data, weights, noise, correction) and start model; all are padded to a
common station count and solved with ``jax.vmap`` over a ``lax.fori_loop`` LM. On a GPU the batch runs in parallel;
this is what makes multi-start and whole-well sliding-window inversion practical.

The LM step is Marquardt-scaled, ``(J^T J + lam diag(J^T J)) dx = -J^T r``, projected onto the parameter bounds, and
accepted only if it lowers the cost (lam / 3), otherwise rejected (lam * 3).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

import jax
import jax.numpy as jnp

from backend.inversion.adr_forward import ADRForward
from backend.inversion.jax_forward import layout_to_model, pad_stations, shared_jax_forward


@dataclass
class WindowArrays:
    """One window, padded to ``size`` stations. Masked rows/channels do not contribute to the cost."""

    dip_az: float
    ned: np.ndarray
    axis: np.ndarray
    high: np.ndarray
    obs: np.ndarray          # (size, m) inversion units
    wsig: np.ndarray         # (m,) weight / sigma
    mask: np.ndarray         # (size, m) 1 where a used, valid, real station value exists
    corr_a: np.ndarray       # (m,) level-correction intercept (0 = none)
    corr_g: np.ndarray       # (m,) level-correction gain
    lo: np.ndarray           # (P,) bounds
    hi: np.ndarray


def pad_size(n):
    return pad_stations(n)


def window_arrays(data, weights, sigma, lc, lo, hi, size=None, dip_az=None):
    n, m = data.obs.shape
    size = size or pad_size(n)
    high = data.traj.high if data.traj.high is not None else np.tile([0.0, 0.0, -1.0], (n, 1))
    pad = lambda v: np.concatenate([v, np.repeat(v[-1:], size - n, axis=0)])
    valid = data.valid if data.valid is not None else np.ones_like(data.obs, bool)
    w = np.array([weights[lab] for lab in data.labels], float)
    s = np.array([sigma[lab] for lab in data.labels], float)
    mask = (valid & (w > 0)[None, :]).astype(float)
    mask = np.concatenate([mask, np.zeros((size - n, m))])
    if dip_az is None:
        dip_az = float(np.rad2deg(np.arctan2(data.traj.axis[:, 1].mean(), data.traj.axis[:, 0].mean())))
    a = lc.a if lc is not None else np.zeros(m)
    g = lc.g if lc is not None else np.zeros(m)
    return WindowArrays(dip_az, pad(data.traj.ned), pad(data.traj.axis), pad(high), pad(data.obs), w / s, mask,
                        np.asarray(a, float), np.asarray(g, float), np.asarray(lo, float), np.asarray(hi, float))


def stack(windows):
    return {f: jnp.asarray(np.stack([getattr(w, f) for w in windows])) for f in WindowArrays.__dataclass_fields__}


_SOLVERS: dict = {}


def solver(fwd: ADRForward, k, n_aniso, fit_dip, iters=25, pivot=1.0):
    """Compiled ``solve(x0 (B,P), win dict of (B,...)) -> (x (B,P), cost (B,), chi (B,), pred (B,size,m))``.

    ``pred`` is the level-corrected theory at the solution (``Inverter`` ``FitResult.pred`` without bias)."""
    key = (fwd.receiver_sep_in, fwd.azimuthal, k, n_aniso, fit_dip, iters, pivot)
    if key in _SOLVERS:
        return _SOLVERS[key]
    jf = shared_jax_forward(fwd)

    def theory(x, w):
        b, rh, rv, dip = layout_to_model(x, k, n_aniso, fit_dip)
        th = jf.predict_arrays(b, rh, rv, dip, w["dip_az"], w["ned"], w["axis"], w["high"])
        return th + w["corr_a"] + w["corr_g"] * (th - pivot)

    def resid(x, w):
        r = (theory(x, w) - w["obs"]) * w["wsig"] * w["mask"]
        return jnp.where(w["mask"] > 0, r, 0.0).ravel()

    def cost(x, w):
        r = resid(x, w)
        return 0.5 * jnp.sum(r * r)

    def jac(x, w):
        # One JVP per parameter via lax.map: ~1/P of the memory of jacfwd, which matters when batching problems.
        f = lambda x_: resid(x_, w)
        cols = jax.lax.map(lambda v: jax.jvp(f, (x,), (v,))[1], jnp.eye(x.shape[0], dtype=x.dtype))
        return cols.T

    def one(x0, w):
        def body(_, state):
            x, lam, c = state
            r = resid(x, w)
            J = jac(x, w)
            J = jnp.where(jnp.isfinite(J), J, 0.0)
            A = J.T @ J
            g = J.T @ r
            D = jnp.diag(jnp.maximum(jnp.diag(A), 1e-12))
            dx = -jnp.linalg.solve(A + lam * D, g)
            xn = jnp.clip(x + dx, w["lo"], w["hi"])
            cn = cost(xn, w)
            better = jnp.isfinite(cn) & (cn < c)
            return (jnp.where(better, xn, x), jnp.where(better, lam / 3.0, lam * 3.0), jnp.where(better, cn, c))

        x0 = jnp.clip(x0, w["lo"], w["hi"])
        x, _, c = jax.lax.fori_loop(0, iters, body, (x0, jnp.asarray(1e-2, x0.dtype), cost(x0, w)))
        n_used = jnp.maximum(jnp.sum(w["mask"]), 1.0)
        return x, c, jnp.sqrt(2.0 * c / n_used), theory(x, w)

    fn = jax.jit(jax.vmap(one))
    _SOLVERS[key] = fn
    return fn


def default_chunk():
    """Problems per compiled batch: device memory bound (~150 MB per 32-station problem in FP64)."""
    import os
    if os.environ.get("RESIST_SCAN_CHUNK"):
        return int(os.environ["RESIST_SCAN_CHUNK"])
    return 32 if jax.devices()[0].platform == "gpu" else 4


def solve_chunked(fn, x0, windows, chunk=None):
    """Run ``fn`` over a list of windows in chunks (bounded device memory). Returns numpy (x, cost, chi, pred)."""
    chunk = chunk or default_chunk()
    out = [[], [], [], []]
    for i in range(0, len(windows), chunk):
        part = windows[i:i + chunk]
        # pad the chunk to a fixed batch size so the compiled shape is reused
        fill = chunk - len(part)
        batch = part + [part[-1]] * fill
        xb = np.concatenate([x0[i:i + len(part)], np.repeat(x0[i + len(part) - 1:i + len(part)], fill, axis=0)])
        for acc, v in zip(out, fn(jnp.asarray(xb), stack(batch))):
            acc.append(np.asarray(v)[:len(part)])
    return tuple(np.concatenate(v) for v in out)
