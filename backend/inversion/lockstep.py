"""Lockstep batching: many concurrent single-window fits share batched JAX theory/Jacobian evaluations.

Each fit (one sliding-window slice and its starts) runs the same scipy ``least_squares`` TRF optimiser as the CPU
path, in its own thread, through ``Inverter(theory_factory=batcher.theory)``. Its theory and Jacobian requests block
until the batcher has collected the requests of every running fit (or ``wait_s`` passes); they are then evaluated
in one vmapped, compiled call. On a GPU that call costs about the same as a single window, so all slices of an
interval advance together; the fits, and therefore the results, are identical to running them one by one.
"""

from __future__ import annotations

from contextlib import contextmanager
import threading
import time

import numpy as np

import jax
import jax.numpy as jnp

from backend.inversion.adr_forward import ADRForward
from backend.inversion.jax_forward import layout_to_model, shared_jax_forward


def default_batch() -> int:
    """Largest batch per compiled call (RESIST_BATCH overrides): wide on a GPU, narrow on a CPU."""
    import os
    if os.environ.get("RESIST_BATCH"):
        return max(1, int(os.environ["RESIST_BATCH"]))
    return 64 if jax.devices()[0].platform == "gpu" else 8


def _buckets(max_batch):
    """Compiled batch sizes 1, 4, 16, ... up to max_batch, so a nearly drained queue does not pay for a full batch."""
    out, b = [], 1
    while b < max_batch:
        out.append(b); b *= 4
    return out + [max_batch]


class _Proxy:
    """``JaxTheory``-compatible view of one window: ``__call__(x)`` -> theory, ``jacobian(x)`` -> d theory / dx."""

    def __init__(self, batcher, args, n):
        self.batcher, self.args, self.n = batcher, args, n

    def __call__(self, x):
        return self.batcher.submit("f", x, self.args)[:self.n]

    def jacobian(self, x):
        return self.batcher.submit("j", x, self.args)[:self.n]


class LockstepBatcher:
    def __init__(self, fwd: ADRForward, k, n_aniso, fit_dip, size, precision=64, max_batch=None, wait_s=0.25):
        self.dt = jnp.float32 if precision == 32 else jnp.float64
        jf = shared_jax_forward(fwd, self.dt)
        self.size, self.max_batch, self.wait_s = size, max_batch or default_batch(), wait_s
        self.buckets = _buckets(self.max_batch)

        def theory(x, dip_az, ned, axis, high):
            b, rh, rv, dip = layout_to_model(x, k, n_aniso, fit_dip)
            return jf.predict_arrays(b, rh, rv, dip, dip_az, ned, axis, high)

        self._fn = {"f": jax.jit(jax.vmap(theory)), "j": jax.jit(jax.vmap(jax.jacfwd(theory)))}
        self._cv = threading.Condition()
        self._pending: list = []
        self._active = 0
        self._closed = False
        self.calls = 0
        self._thread = threading.Thread(target=self._loop, name="lockstep-batcher", daemon=True)
        self._thread.start()

    # -- client side -------------------------------------------------------------------------------
    def theory(self, traj, dip_azimuth):
        """Theory factory for ``Inverter``: pads the window to the batcher's station count."""
        n = len(traj)
        if n > self.size:
            raise ValueError(f"window of {n} stations exceeds the batcher size {self.size}")
        high = traj.high if traj.high is not None else np.tile([0.0, 0.0, -1.0], (n, 1))
        pad = lambda v: np.concatenate([v, np.repeat(v[-1:], self.size - n, axis=0)])
        return _Proxy(self, (float(dip_azimuth), pad(traj.ned), pad(traj.axis), pad(high)), n)

    @contextmanager
    def worker(self):
        """Mark the calling thread as a running fit while inside the block (the batcher waits for all of them)."""
        with self._cv:
            self._active += 1
        try:
            yield
        finally:
            with self._cv:
                self._active -= 1
                self._cv.notify_all()

    def submit(self, kind, x, args):
        slot = {"event": threading.Event()}
        with self._cv:
            if self._closed:
                raise RuntimeError("batcher is closed")
            self._pending.append((kind, np.asarray(x, float), args, slot))
            self._cv.notify_all()
        slot["event"].wait()
        if "error" in slot:
            raise slot["error"]
        return slot["value"]

    def close(self):
        with self._cv:
            self._closed = True
            self._cv.notify_all()
        self._thread.join()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- batcher thread ----------------------------------------------------------------------------
    def _loop(self):
        while True:
            with self._cv:
                self._cv.wait_for(lambda: self._closed or self._pending)
                if self._closed and not self._pending:
                    return
                deadline = time.monotonic() + self.wait_s
                while len(self._pending) < self._active and not self._closed:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    self._cv.wait(left)
                batch, self._pending = self._pending, []
            for kind in ("f", "j"):
                items = [b for b in batch if b[0] == kind]
                for i in range(0, len(items), self.max_batch):
                    self._run(kind, items[i:i + self.max_batch])

    def _run(self, kind, items):
        try:
            n = len(items)
            b = next(s for s in self.buckets if s >= n)
            rows = items + [items[-1]] * (b - n)
            dt = self.dt
            x = jnp.asarray(np.stack([r[1] for r in rows]), dt)
            az = jnp.asarray([r[2][0] for r in rows], dt)
            ned, axis, high = (jnp.asarray(np.stack([r[2][j] for r in rows]), dt) for j in (1, 2, 3))
            out = np.asarray(self._fn[kind](x, az, ned, axis, high), np.float64)
            self.calls += 1
            for r, v in zip(items, out):
                r[3]["value"] = v
        except Exception as exc:  # delivered to the waiting fits
            for r in items:
                r[3]["error"] = exc
        for r in items:
            r[3]["event"].set()
