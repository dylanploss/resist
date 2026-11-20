"""Clip-value masking, per-channel missing data, phase-only anisotropy and the inversion worker pool lifecycle."""

import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest

import numpy as np
import pandas as pd

from backend.data.loader import CLIP_OHMM, WellRun, _mask_clips, measurement_metadata
from backend.data.quadrants import quadrant
from backend.inversion.adr_forward import FT, ADRForward, Trajectory
from backend.inversion.invert import FitConfig, IntervalData, Inverter, azimuthal_average

ROOT = Path(__file__).resolve().parents[2]


class ClipMaskTests(unittest.TestCase):
    def test_loader_masks_clip_values_and_their_corrected_twins(self):
        image = np.full((3, 32), 10.0)
        image[1, :5] = 5000.0
        curves = {"ARH16A": np.array([10.0, 2000.0, 5000.0, 1500.0]),
                  "ARH16AC": np.array([11.0, 2442.3, 1800.0, 1600.0]),   # 1800: corrected copy of a 5000 sample
                  "ARH16P": np.array([9.0, 1999.5, 12.0, np.nan]),
                  "ZRH16P": image, "GR": np.array([3000.0, 1.0, 2.0, 3.0])}
        masks = _mask_clips(curves)
        np.testing.assert_array_equal(np.isnan(curves["ARH16A"]), [False, True, True, False])
        np.testing.assert_array_equal(np.isnan(curves["ARH16AC"]), [False, True, True, False])
        np.testing.assert_array_equal(masks["ARH16P"], [False, True, False, False])
        self.assertEqual(int(np.isnan(curves["ZRH16P"]).sum()), 5)
        self.assertEqual(curves["GR"][0], 3000.0)                       # not an ADR resistivity
        self.assertNotIn("GR", masks)

    def test_clipped_fraction_counts_delivered_samples_in_the_interval(self):
        values = np.array([1.0, np.nan, np.nan, 2.0])
        run = WellRun(Path("x.dlis"), "x", np.arange(4.0), {"ARH16P": values}, pd.DataFrame(), {},
                      {"ARH16P": np.array([False, True, False, False])})
        self.assertAlmostEqual(run.clipped_fraction("ARH16P"), 1 / 3)  # the plain gap is not clipping
        self.assertAlmostEqual(run.clipped_fraction("ARH16P", np.array([False, True, True, False])), 1.0)
        self.assertEqual(run.clipped_fraction("GR"), 0.0)

    def test_sector_and_azimuthal_average_drop_clipped_bins(self):
        img = np.full((2, 32), 10.0)
        img[0, 28:32] = 5000.0                                          # half of the top sector clipped
        img[1, [28, 29, 30, 31, 0]] = 2000.0                            # five of eight: too few usable bins
        top = quadrant(img, "T")
        self.assertAlmostEqual(top[0], 10.0)
        self.assertTrue(np.isnan(top[1]))
        self.assertAlmostEqual(quadrant(img, "B")[1], 10.0)
        np.testing.assert_allclose(azimuthal_average(img), [10.0, 10.0])
        self.assertTrue(np.isnan(azimuthal_average(np.array([CLIP_OHMM + 1]))[0]))
        # geosignals are not resistivities and are never clip-masked
        geo = np.full((1, 32), 3000.0)
        self.assertAlmostEqual(quadrant(geo, "T", resistivity=False)[0], 3000.0)


class ClippedQcTests(unittest.TestCase):
    def test_mostly_clipped_curve_rejected_only_in_its_clipped_interval(self):
        from backend.qc.selection import select_curves

        n = 2000
        md_ft = np.arange(n) * 0.5
        rng = np.random.default_rng(1)

        def smooth(period, offset):
            return 10 ** (offset + 0.4 * np.sin(md_ft / period * 2 * np.pi) + 1e-4 * rng.standard_normal(n))

        curves = {"DEPT": md_ft, "ARH16P": smooth(80, 0.5), "ARM32P": smooth(90, 0.6), "ARM48P": smooth(100, 0.6),
                  "ARM82P": smooth(130, 0.7), "ARL82P": smooth(140, 0.7), "ARM82A": smooth(120, 0.8)}
        clipped = {k: np.zeros(n, bool) for k in curves if k != "DEPT"}
        clipped["ARM82A"][: int(0.7 * n)] = True                       # clipped over the upper 70 % of the run
        curves["ARM82A"][clipped["ARM82A"]] = np.nan
        rows = [{"curve": k, "unit": "ft" if k == "DEPT" else "ohmm", "valid_fraction": float(np.isfinite(v).mean()),
                 **measurement_metadata(k)} for k, v in curves.items()]
        run = WellRun(Path("synthetic.dlis"), "synthetic", md_ft * FT, curves, pd.DataFrame(rows), {}, clipped)

        whole = select_curves(run, n_select=5)
        reasons = {r["curve"]: r["reason"] for r in whole["rejected"]}
        self.assertIn("mostly clipped", reasons["ARM82A"])
        self.assertAlmostEqual(whole["scores"]["ARM82A"]["clipped"], 0.7, places=3)
        lower = select_curves(run, n_select=5, md_min_ft=0.75 * md_ft[-1])
        self.assertNotIn("clipped", {r["curve"]: r["reason"] for r in lower["rejected"]}.get("ARM82A", ""))
        self.assertEqual(lower["scores"]["ARM82A"]["clipped"], 0.0)


class FitTests(unittest.TestCase):
    def setUp(self):
        n = 6
        md = 20000 + np.arange(n) * 4.0
        traj = Trajectory.from_curves(md, np.full(n, 10600.0), np.full(n, 88.0), np.zeros(n), np.zeros(n),
                                      md * FT, ref=[0, 0, 10600 * FT])
        self.labels = ADRForward().channel_labels()
        self.n = n
        self.traj, self.md = traj, md

    def data(self, obs, valid=None):
        return IntervalData("synthetic", self.md, self.traj, obs, self.labels, np.zeros(self.n),
                            np.array([0, 0, 10600 * FT]), np.full(self.n, 10600.0), valid)

    def inverter(self, data, theory_of, **cfg):
        inv = Inverter(data, FitConfig(n_layers=1, fit_dip=False, **cfg), workers=1)
        inv._theory_batch = lambda xs: [theory_of(x) for x in xs]
        return inv

    def test_missing_sample_on_a_weighted_channel_is_left_out(self):
        j = self.labels.index("ARH16P")
        obs = np.full((self.n, len(self.labels)), 1.0)
        obs[2, j] = 0.0                                                  # placeholder of a clipped sample
        valid = np.ones_like(obs, bool)
        valid[2, j] = False
        weights = {lab: float(lab == "ARH16P") for lab in self.labels}
        with self.inverter(self.data(obs, valid), lambda x: np.full(obs.shape, x[0]), curve_weights=weights) as inv:
            r = inv.fit(inv.x_from([], [1.3], 0.1))
        self.assertAlmostEqual(r.x[0], 1.0, places=3)
        self.assertTrue(np.isnan(r.residual[2, j]))
        self.assertLess(r.rms_percent(), 0.1)

    def test_anisotropy_from_phase_ignores_attenuation(self):
        p16, p32, a16 = (self.labels.index(k) for k in ("ARH16P", "ARH32P", "ARH16A"))
        obs = np.zeros((self.n, len(self.labels)))
        obs[:, p16], obs[:, p32], obs[:, a16] = 1.2, 1.4, 2.0          # phase: rh 1.0, aniso 0.2; atten disagrees

        def theory(x):
            t = np.zeros(obs.shape)
            t[:, p16], t[:, p32], t[:, a16] = x[0] + x[1], x[0] + 2 * x[1], x[0] + 3 * x[1]
            return t

        weights = {lab: float(lab in ("ARH16P", "ARH32P", "ARH16A")) for lab in self.labels}
        with self.inverter(self.data(obs), theory, curve_weights=weights, anisotropy_from_phase=True) as inv:
            phase_first = inv.fit(inv.x_from([], [1.3], 0.1))
        with self.inverter(self.data(obs), theory, curve_weights=weights) as inv:
            joint = inv.fit(inv.x_from([], [1.3], 0.1))
        self.assertAlmostEqual(phase_first.x[1], 0.2, places=3)
        self.assertEqual(phase_first.extra["anisotropy_from"], "phase")
        self.assertGreater(joint.x[1], 0.3)                             # attenuation drags a joint fit off
        self.assertNotIn("anisotropy_from", joint.extra)


class WorkerPoolTests(unittest.TestCase):
    def test_workers_run_single_threaded_blas_and_stop_on_shutdown(self):
        from backend.inversion.invert import _worker_env, shutdown_pools, worker_pool

        traj = Trajectory.from_curves(np.array([0.0, 1.0]), np.zeros(2), np.full(2, 88.0), np.zeros(2),
                                      np.zeros(2), np.zeros(2))
        pool = worker_pool(traj, 2)
        self.assertEqual(pool.submit(_worker_env).result(timeout=120), {"OPENBLAS_NUM_THREADS": "1",
                                                                       "VECLIB_MAXIMUM_THREADS": "1"})
        pids = list(pool._processes)
        self.assertGreaterEqual(shutdown_pools(), 1)
        # By pid: Process.is_alive() can still say True for a moment while the pool's own thread reaps the worker.
        self.assertEqual([p for p in pids if _alive(p)], [])
        self.assertEqual(shutdown_pools(), 0)

    def test_workers_exit_when_the_parent_is_killed(self):
        script = (
            "import numpy as np, os, sys, time\n"
            "from backend.inversion.adr_forward import Trajectory\n"
            "from backend.inversion import invert\n"
            "t = Trajectory.from_curves(np.array([0.0, 1.0]), np.zeros(2), np.full(2, 88.0), np.zeros(2), np.zeros(2), np.zeros(2))\n"
            "pool = invert.worker_pool(t, 2)\n"
            "pool.submit(os.getpid).result(timeout=120)\n"
            "print(' '.join(str(p) for p in pool._processes), flush=True)\n"
            "time.sleep(600)\n")
        child = subprocess.Popen([sys.executable, "-c", script], cwd=ROOT, stdout=subprocess.PIPE, text=True,
                                 env={**os.environ, "PYTHONPATH": str(ROOT)})
        try:
            pids = [int(p) for p in child.stdout.readline().split()]
            self.assertTrue(pids)
        finally:
            child.send_signal(signal.SIGKILL)                           # no atexit, no shutdown hook
            child.wait()
        deadline = time.time() + 20
        alive = pids
        while alive and time.time() < deadline:
            time.sleep(0.25)
            alive = [p for p in alive if _alive(p)]
        self.assertEqual(alive, [], "inversion workers outlived their killed parent")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


if __name__ == "__main__":
    unittest.main()
