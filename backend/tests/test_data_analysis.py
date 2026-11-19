import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

from backend.data.loader import WellRun, measurement_metadata
from backend.data.transitions import analyze, classify, load_rules


def synthetic(curves, step=0.1524):
    n = len(next(iter(curves.values())))
    units = {"ARH16P": "ohmm", "ARM48P": "ohmm", "ZGH16P": "deg", "GR": "gAPI", "ZRH16P": "ohmm"}
    rows = [{"curve": k, "unit": units[k], "depth_ref": "MD_RKB", **measurement_metadata(k)}
            for k in curves]
    return WellRun(Path("test.dlis"), "test", np.arange(n) * step,
                   curves, pd.DataFrame(rows), {})


class AnalysisTests(unittest.TestCase):
    def test_sustained_step_located_and_unknown_without_calibration(self):
        x = np.r_[np.ones(100), np.full(100, 10.0)]
        run = synthetic({"ARH16P": x, "ZGH16P": np.r_[np.zeros(100), np.full(100, 5.0)]})
        result = analyze(run)
        self.assertEqual(len(result["events"]), 1)
        self.assertLess(abs(result["events"][0]["depth_m"] - run.depth_m[100]), 0.31)
        self.assertEqual(result["events"][0]["environment_before"], "unknown")
        self.assertEqual(result["intervals"]["label"].tolist(), ["unknown"])
        self.assertEqual(result["geological_events"], [])
        self.assertEqual(set(result["events"][0]["families"]), {"AR", "ZG"})

    def test_homogeneous_and_isolated_spike_not_boundaries(self):
        for spike in (False, True):
            v = np.ones(200)
            if spike:
                v[100] = 10000
            result = analyze(synthetic({"ARH16P": v, "GR": v * 50}))
            self.assertEqual(result["events"], [])

    def test_missing_samples_and_depth_gap_not_transitions(self):
        x = np.r_[np.ones(100), np.full(100, 10.0)]
        for gap in (False, True):
            run = synthetic({"ARH16P": x.copy(), "ZGH16P": x.copy() * 5})
            if gap:
                run.depth_m[100:] += 20
            else:
                for values in run.curves.values():
                    values[85:115] = np.nan
            self.assertEqual(analyze(run)["events"], [])

    def test_images_retain_bins_and_do_not_average_opposite_sign_geosignals(self):
        bins = np.tile(np.r_[np.full(16, 5.0), np.full(16, -5.0)], (200, 1))
        bins[:100] = 0
        x = np.r_[np.ones(100), np.full(100, 10.0)]
        run = synthetic({"ZGH16P": bins, "ARH16P": x})
        result = analyze(run)
        self.assertEqual(len(result["events"]), 1)
        table = next(run.tidy())
        self.assertEqual(len(table), 6400)
        self.assertEqual(table["bin"].nunique(), 32)
        self.assertEqual(table["value"].iloc[-1], -5)

    def test_geological_rules_unknown_ambiguous_units_and_sustained_crossing(self):
        rules = {"reference": "synthetic labels, not field calibration", "rules": [
            {"label": "low_GR", "conditions": [{"curve": "GR", "unit": "gAPI", "max": 50}]},
            {"label": "high_GR", "conditions": [{"curve": "GR", "unit": "gAPI", "min": 50}]},
        ]}
        run = synthetic({"GR": np.r_[np.full(100, 20.0), np.full(100, 80.0)]})
        result = analyze(run, rules=rules)
        self.assertEqual(len(result["geological_events"]), 1)
        run.curves["GR"][0:3] = [np.nan, 50, 20]
        labels, _ = classify(run, rules)
        self.assertEqual(labels[:3].tolist(), ["unknown", "ambiguous", "low_GR"])
        rules["rules"][0]["conditions"][0]["unit"] = "wrong"
        with self.assertRaisesRegex(ValueError, "stored unit"):
            classify(run, rules)

    def test_rule_validation_and_missing_curve_warning(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "rules.json"
            path.write_text(json.dumps({"reference": "test", "rules": [
                {"label": "a", "conditions": [{"curve": "GR", "unit": "gAPI", "min": 80, "max": 20}]}
            ]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "min exceeds max"):
                load_rules(path)
        rules = {"rules": [{"label": "a", "conditions": [{"curve": "GR", "unit": "gAPI", "min": 0}]}]}
        labels, warnings = classify(synthetic({"ARH16P": np.ones(200)}), rules)
        self.assertTrue((labels == "unknown").all())
        self.assertIn("missing GR", warnings[0])


if __name__ == "__main__":
    unittest.main()
