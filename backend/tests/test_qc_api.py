import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import app
from backend.qc import api

RUN = "2_4-VC-2_Y3H_16634-17888ft_RES_GEOSIGNAL"


@unittest.skipUnless((api.DATA_DIR / f"{RUN}.dlis").exists(), "Ekofisk data not available")
class QcApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.qc = cls.client.get(f"/runs/{RUN}/qc").json()

    def test_runs_listed(self):
        runs = [r["run"] for r in self.client.get("/runs").json()["runs"]]
        self.assertIn(RUN, runs)
        self.assertEqual(len(runs), len(list(api.DATA_DIR.glob("*.dlis"))))

    def test_qc_contract(self):
        self.assertEqual(len(self.qc["selected"]), 8)
        rejected = {r["curve"] for r in self.qc["rejected"]}
        self.assertEqual(set(self.qc["selected"]) | rejected, set(self.qc["scores"]))

    def test_scalar_curve_thinned_without_averaging(self):
        body = self.client.get(f"/runs/{RUN}/curves/ARM16P", params={"max_points": 200}).json()
        self.assertFalse(body["image"])
        self.assertLessEqual(len(body["md_ft"]), 200)
        self.assertEqual(len(body["md_ft"]), len(body["values"]))
        full = api._load(RUN).curves["ARM16P"]
        self.assertAlmostEqual(body["values"][1], full[body["stride"]], places=6)

    def test_image_returned_bins_by_depth_within_window(self):
        md = api._load(RUN).depth_m * api.FT_PER_M
        start, end = float(md[100]), float(md[300])
        body = self.client.get(f"/runs/{RUN}/curves/ZRM48A",
                               params={"start_ft": start, "end_ft": end}).json()
        self.assertTrue(body["image"])
        self.assertEqual(len(body["values"]), 32)
        self.assertEqual(len(body["values"][0]), len(body["md_ft"]))
        self.assertGreaterEqual(min(body["md_ft"]), start)
        self.assertLessEqual(max(body["md_ft"]), end)

    def test_unknown_run_and_curve_are_404(self):
        self.assertEqual(self.client.get("/runs/../app/qc").status_code, 404)
        self.assertEqual(self.client.get("/runs/nope/qc").status_code, 404)
        self.assertEqual(self.client.get(f"/runs/{RUN}/curves/NOPE").status_code, 404)

    def test_save_selection_records_overrides(self):
        rejected = next(r["curve"] for r in self.qc["rejected"]
                        if self.qc["scores"][r["curve"]]["family"] != "conventional")
        curves = self.qc["selected"][:-1] + [rejected]
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(api, "SELECTION_DIR", Path(folder)):
            response = self.client.post(f"/runs/{RUN}/selection", json={"curves": curves})
            self.assertEqual(response.status_code, 200)
            saved = json.loads((Path(folder) / f"{RUN}.json").read_text())
        self.assertEqual(saved["curves"], curves)
        self.assertEqual(saved["added"], [rejected])
        self.assertEqual(saved["removed"], [self.qc["selected"][-1]])
        self.assertIn(rejected, saved["overridden_rejections"])

    def test_save_selection_validates_curves(self):
        for body in ({"curves": ["NOPE"]}, {"curves": ["ARM16P", "ARM16P"]}, {"curves": []}):
            self.assertEqual(self.client.post(f"/runs/{RUN}/selection", json=body).status_code, 422)


if __name__ == "__main__":
    unittest.main()
