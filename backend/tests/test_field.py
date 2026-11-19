import unittest

from fastapi.testclient import TestClient
import numpy as np

from backend.app import app
from backend.data.loader import WellRun
from backend.qc import api
from backend.services import field, runs, well3d

RUN = "2_4-VC-2_Y3H_16634-17888ft_RES_GEOSIGNAL"
ARRAYS = ("md_ft", "east_m", "north_m", "tvd_m", "values")


def without(data: WellRun, *names: str) -> WellRun:
    curves = {k: v for k, v in data.curves.items() if k not in names}
    return WellRun(data.path, data.well, data.depth_m, curves, data.metadata, data.parameters)


@unittest.skipUnless((api.DATA_DIR / f"{RUN}.dlis").exists(), "Ekofisk data not available")
class FieldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = runs.get_run(RUN)
        cls.body = TestClient(app).get("/field", params={"max_points": 300}).json()

    def test_every_run_is_placed_or_skipped_with_a_reason(self):
        placed = {r["run"] for r in self.body["runs"]}
        skipped = {s["run"] for s in self.body["skipped"]}
        self.assertEqual(placed | skipped, set(runs.run_paths()))
        self.assertFalse(placed & skipped)
        self.assertIn(RUN, placed)
        self.assertTrue(all(s["reason"] for s in self.body["skipped"]))

    def test_paths_are_thinned_aligned_and_absolute(self):
        for entry in self.body["runs"]:
            lengths = {len(entry[k]) for k in ARRAYS}
            self.assertEqual(len(lengths), 1, entry["run"])
            self.assertLessEqual(lengths.pop(), 300)
            self.assertEqual(entry["md_range_ft"], [entry["md_ft"][0], entry["md_ft"][-1]])
            # Ekofisk: UTM zone 31 eastings near 514 km, northings near 6260 km, reservoir near 3 km TVD.
            self.assertTrue(400_000 < min(entry["east_m"]) and max(entry["east_m"]) < 600_000)
            self.assertTrue(6_000_000 < min(entry["north_m"]) < 7_000_000)
            self.assertTrue(1_000 < min(entry["tvd_m"]) and max(entry["tvd_m"]) < 6_000)
        entry = next(r for r in self.body["runs"] if r["run"] == RUN)
        self.assertEqual(entry["path_source"], "utm")
        self.assertAlmostEqual(entry["east_m"][0], self.data.curves["UTMX"][0], places=1)
        self.assertAlmostEqual(entry["north_m"][0], self.data.curves["UTMY"][0], places=1)
        self.assertAlmostEqual(entry["tvd_m"][0], self.data.curves["TVD"][0] * well3d.FT_TO_M, places=1)

    def test_colour_is_one_log10_spec_over_a_deep_ar_resistivity(self):
        self.assertEqual(self.body["color"]["scale"], "Jet")
        self.assertTrue(self.body["color"]["log10"])
        entry = next(r for r in self.body["runs"] if r["run"] == RUN)
        self.assertTrue(entry["curve"].startswith("AR"))
        self.assertEqual(entry["curve"], well3d._reference_resistivity(self.data, {}))
        centre = self.body["centre"]
        east = [e for r in self.body["runs"] for e in r["east_m"]]
        self.assertAlmostEqual(centre["east_m"], (min(east) + max(east)) / 2)

    def test_min_curvature_run_is_placed_at_its_first_utm_sample(self):
        flat = without(self.data, "UTMX", "UTMY")
        constant = dict(flat.curves, UTMX=np.full_like(self.data.depth_m, self.data.curves["UTMX"][0]),
                        UTMY=np.full_like(self.data.depth_m, self.data.curves["UTMY"][0]))
        placed = field.field_path(WellRun(flat.path, flat.well, flat.depth_m, constant, flat.metadata,
                                          flat.parameters), max_points=20000)
        reference = field.field_path(self.data, max_points=20000)
        self.assertEqual(placed["path_source"], "min_curvature")
        self.assertAlmostEqual(placed["east_m"][0], reference["east_m"][0], places=1)
        # Same 2 m tolerance as test_well3d.test_min_curvature_agrees_with_utm_path.
        for key in ("east_m", "north_m", "tvd_m"):
            self.assertLess(abs(placed[key][-1] - reference[key][-1]), 2.0, key)

    def test_run_without_position_or_trajectory_is_skipped(self):
        body = field.field({"no_utm": without(self.data, "UTMX", "UTMY"),
                            "no_path": without(self.data, "UTMX", "UTMY", "INC", "AZI"),
                            "broken": OSError("bad file"), RUN: self.data})
        self.assertEqual([r["run"] for r in body["runs"]], [RUN])
        reasons = {s["run"]: s["reason"] for s in body["skipped"]}
        self.assertIn("no UTMX/UTMY/TVD", reasons["no_utm"])
        self.assertIn("no usable", reasons["no_path"])
        self.assertIn("bad file", reasons["broken"])

    def test_max_points_bounds(self):
        client = TestClient(app)
        self.assertEqual(client.get("/field", params={"max_points": 49}).status_code, 422)
        self.assertEqual(client.get("/field", params={"max_points": 2001}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
