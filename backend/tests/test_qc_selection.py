import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from backend.data.loader import WellRun, measurement_metadata
from backend.qc import metrics
from backend.qc.selection import select_curves

RNG = np.random.default_rng(0)
N = 2000
DEPTH = np.arange(N) * 0.5


def smooth_log_res(period=80.0, offset=0.5):
    return 10 ** (offset + 0.4 * np.sin(DEPTH / period * 2 * np.pi) + 1e-4 * RNG.standard_normal(N))


def static_res():
    return 10 ** (0.5 + 0.3 * RNG.standard_normal(N))


def geosignal(clean=True):
    psi = np.arange(metrics.BINS) * 2 * np.pi / metrics.BINS
    if not clean:
        return RNG.standard_normal((N, metrics.BINS))
    amplitude = 5 * np.sin(DEPTH / 60 * 2 * np.pi)
    return amplitude[:, None] * np.cos(psi[None, :] - 0.3)


def well(curves):
    units = {"GR": "gAPI"}
    rows = [{"curve": k, "unit": units.get(k, "deg" if k.startswith("ZG") else "ohmm"),
             "depth_ref": "MD_RKB", "valid_fraction": float(np.isfinite(v).mean()),
             **measurement_metadata(k)} for k, v in curves.items()]
    return WellRun(Path("synthetic.dlis"), "synthetic", DEPTH * 0.3048,
                   curves, pd.DataFrame(rows), {})


class MetricTests(unittest.TestCase):
    def test_jaggedness_scale(self):
        self.assertLess(metrics.jaggedness(np.log10(smooth_log_res())), 0.1)
        self.assertAlmostEqual(metrics.jaggedness(RNG.standard_normal(N)), 1.0, delta=0.15)
        self.assertGreater(metrics.jaggedness(np.tile([1.0, -1.0], N // 2)
                                              + 0.1 * RNG.standard_normal(N)), 1.5)

    def test_spikes_counted_but_steps_not(self):
        x = np.sin(DEPTH / 50) + 1e-3 * RNG.standard_normal(N)
        x[N // 2:] += 5
        self.assertEqual(metrics.spike_fraction(x), 0.0)
        x[[100, 500, 900]] += 10
        self.assertAlmostEqual(metrics.spike_fraction(x), 3 / (N - 2))

    def test_saturation_masked_and_reported(self):
        x = smooth_log_res()
        x[:200] = 2000.0
        masked, clipped = metrics.mask_saturation(x)
        self.assertAlmostEqual(clipped, 0.1)
        self.assertTrue(np.isnan(masked[:200]).all())

    def test_harmonic_purity_and_antisymmetry(self):
        clean, noise = geosignal(True), geosignal(False)
        self.assertGreater(metrics.harmonics(clean)["purity"], 0.99)
        self.assertLess(metrics.harmonics(noise)["purity"], 0.2)
        self.assertLess(metrics.antisymmetry(clean), 1e-6)
        self.assertGreater(metrics.antisymmetry(noise), 0.5)
        with self.assertRaises(ValueError):
            metrics.harmonics(np.ones((10, 8)))

    def test_doi_index_orders_spacing_frequency_and_type(self):
        doi = metrics.doi_index
        self.assertEqual(doi(16, 2_000_000, "phase"), 1.0)
        self.assertGreater(doi(48, 2_000_000, "phase"), doi(16, 2_000_000, "phase"))
        self.assertGreater(doi(16, 125_000, "phase"), doi(16, 500_000, "phase"))
        self.assertGreater(doi(16, 2_000_000, "attenuation"), doi(16, 2_000_000, "phase"))


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.curves = {
            "ARH16P": smooth_log_res(80, 0.5),
            "ARH16PC": smooth_log_res(80, 0.5),
            "ARM32P": smooth_log_res(90, 0.6),
            "ARM48A": smooth_log_res(110, 0.4),
            "ARM82P": smooth_log_res(130, 0.7),
            "ARL82A": static_res(),
            "ZGM96P": geosignal(True),
            "ZGL112A": geosignal(False),
            "GR": 50 + 10 * np.sin(DEPTH / 30),
        }
        self.result = select_curves(well(self.curves), n_select=5)

    def test_contract(self):
        r = self.result
        rejected = [x["curve"] for x in r["rejected"]]
        self.assertEqual(sorted(r["selected"] + rejected), sorted(self.curves))
        self.assertEqual(set(r["scores"]), set(self.curves))
        self.assertEqual(set(r["selected_reasons"]), set(r["selected"]))
        for s in r["scores"].values():
            self.assertTrue({"score", "coverage", "noise", "range_ok"} <= set(s))
        json.dumps(r, allow_nan=False)

    def test_noisy_and_non_resistivity_curves_rejected_with_reasons(self):
        reasons = {x["curve"]: x["reason"] for x in self.result["rejected"]}
        self.assertIn("static", reasons["ARL82A"])
        self.assertRegex(reasons["ZGL112A"], "static|geosignal")
        self.assertIn("no resistivity", reasons["GR"])
        self.assertEqual(self.result["warnings"], [])

    def test_deep_curves_selected_and_twins_dropped(self):
        selected = self.result["selected"]
        self.assertIn("ZGM96P", selected)
        self.assertIn("ARM82P", selected)
        self.assertNotEqual({"ARH16P", "ARH16PC"} <= set(selected), True)

    def test_coverage_is_relative_to_best_curve_in_run(self):
        curves = {k: v.copy() for k, v in self.curves.items()}
        for k in curves:
            curves[k][: N // 2] = np.nan
        curves["ARM32P"][N // 2: int(N * 0.8)] = np.nan
        reasons = {x["curve"]: x["reason"] for x in select_curves(well(curves), 5)["rejected"]}
        self.assertIn("coverage", reasons["ARM32P"])
        self.assertNotIn("ARM82P", reasons)

    def test_longest_clean_spacing_fills_deep_slot_despite_correlated_shorter_curve(self):
        curves = dict(self.curves)
        curves["ARM66P"] = self.curves["ARM82P"] * 1.01
        curves["ARM82P"] = self.curves["ARM82P"] * (1 + 0.02 * RNG.standard_normal(N))
        result = select_curves(well(curves), n_select=6)
        reasons = {x["curve"]: x["reason"] for x in result["rejected"]}
        self.assertIn("ARM82P", result["selected"])
        self.assertIn("82 in", result["selected_reasons"]["ARM82P"])
        self.assertFalse(reasons.get("ARM66P", "").startswith("redundant"))

    def test_n_select_bounds(self):
        for n in (4, 11):
            with self.assertRaises(ValueError):
                select_curves(well(self.curves), n_select=n)


if __name__ == "__main__":
    unittest.main()
