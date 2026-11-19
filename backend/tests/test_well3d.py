import math
import unittest

from fastapi.testclient import TestClient
import numpy as np

from backend.app import app
from backend.data.loader import WellRun
from backend.qc import api, metrics
from backend.services import runs, well3d

RUN = "2_4-VC-2_Y3H_16634-17888ft_RES_GEOSIGNAL"
GEOSIGNAL_RUN = "2_4-Z-25_20156-21218ft_RES_GEOSIGNAL"
ARRAYS = ("md_ft", "tvd_ft", "inc_deg", "azi_deg", "x_m", "y_m", "z_m", "values")


def qc_percentile(values, p):
    ordered = sorted(v for v in values if v is not None and math.isfinite(v))
    return ordered[math.floor(p * (len(ordered) - 1))]


class MinimumCurvatureTests(unittest.TestCase):
    def test_vertical_well_goes_straight_down(self):
        md = np.linspace(0, 1000, 201)
        x, y, z = well3d.minimum_curvature(md, np.zeros_like(md), np.full_like(md, 123.0))
        np.testing.assert_allclose(x, 0, atol=1e-9)
        np.testing.assert_allclose(y, 0, atol=1e-9)
        np.testing.assert_allclose(z, -md, atol=1e-9)

    def test_horizontal_east_section_moves_east_only(self):
        md = np.linspace(0, 500, 101)
        x, y, z = well3d.minimum_curvature(md, np.full_like(md, 90.0), np.full_like(md, 90.0))
        np.testing.assert_allclose(x, md, atol=1e-9)
        np.testing.assert_allclose(y, 0, atol=1e-9)
        np.testing.assert_allclose(z, 0, atol=1e-9)

    def test_build_from_vertical_to_horizontal_is_a_quarter_circle(self):
        radius = 300.0
        md = np.array([0.0, radius * math.pi / 2])
        x, y, z = well3d.minimum_curvature(md, [0.0, 90.0], [0.0, 0.0])
        self.assertAlmostEqual(y[-1], radius, places=9)
        self.assertAlmostEqual(z[-1], -radius, places=9)
        self.assertAlmostEqual(x[-1], 0.0, places=9)


@unittest.skipUnless((api.DATA_DIR / f"{RUN}.dlis").exists(), "Ekofisk data not available")
class Well3dApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def get(self, run=RUN, **params):
        return self.client.get(f"/runs/{run}/well3d", params=params)

    def test_response_shape_and_aligned_arrays(self):
        body = self.get(curve="ARM48PC", max_points=500).json()
        self.assertEqual(body["run"], RUN)
        self.assertEqual(body["curve"], "ARM48PC")
        self.assertEqual(body["unit"], "ohmm")
        self.assertFalse(body["image"])
        self.assertEqual(body["path_source"], "utm")
        self.assertEqual(set(body["origin"]), {"utmx", "utmy", "tvd_m"})
        lengths = {len(body[k]) for k in ARRAYS}
        self.assertEqual(len(lengths), 1)
        self.assertLessEqual(lengths.pop(), 500)
        self.assertEqual(body["x_m"][0], 0.0)
        self.assertEqual(body["z_m"][0], 0.0)
        md = runs.get_run(RUN).depth_m / well3d.FT_TO_M
        self.assertAlmostEqual(body["md_ft"][1] - body["md_ft"][0], (md[1] - md[0]) * body["stride"])

    def test_path_is_utm_relative_to_first_sample(self):
        data = runs.get_run(RUN)
        body = self.get(curve="ARM48PC", max_points=20000).json()
        self.assertEqual(body["stride"], 1)
        self.assertAlmostEqual(body["origin"]["utmx"], data.curves["UTMX"][0])
        self.assertAlmostEqual(body["x_m"][-1], data.curves["UTMX"][-1] - data.curves["UTMX"][0], places=6)
        self.assertAlmostEqual(body["y_m"][-1], data.curves["UTMY"][-1] - data.curves["UTMY"][0], places=6)
        self.assertAlmostEqual(body["z_m"][-1], -(data.curves["TVD"][-1] - data.curves["TVD"][0]) * 0.3048,
                               places=6)

    def test_depth_window(self):
        body = self.get(curve="ARM48PC", start_ft=17000, end_ft=17100).json()
        self.assertGreaterEqual(min(body["md_ft"]), 17000)
        self.assertLessEqual(max(body["md_ft"]), 17100)
        self.assertEqual(body["x_m"][0], 0.0)

    def test_resistivity_colour_spec_matches_qc_percentiles_over_full_curve(self):
        full = runs.get_run(RUN).curves["ARM48PC"]
        logs = [math.log10(v) for v in full if v > 0]
        body = self.get(curve="ARM48PC", max_points=100).json()
        self.assertEqual(body["color"], {"scale": "Jet", "reverse": False, "log10": True,
                                         "zmin": qc_percentile(logs, 0.02),
                                         "zmax": qc_percentile(logs, 0.98)})

    def test_doi_matches_qc_and_grows_with_depth_of_reading(self):
        shallow = self.get(curve="ARH16P", max_points=100).json()
        deep = self.get(curve="ARL48AC", max_points=100).json()
        self.assertEqual((shallow["doi_index"], shallow["doi_tier"]), (1.0, "shallow"))
        self.assertEqual(deep["doi_index"], metrics.doi_index(48, 125_000, "attenuation"))
        self.assertEqual(deep["doi_tier"], "deep")
        self.assertGreater(deep["doi_index"], shallow["doi_index"])
        conventional = self.get(curve="GR", max_points=100).json()
        self.assertIsNone(conventional["doi_index"])
        self.assertIsNone(conventional["doi_tier"])

    def test_image_curve_rows_of_32(self):
        body = self.get(curve="ZRM48A", max_points=200).json()
        self.assertTrue(body["image"])
        self.assertEqual(body["bins"], 32)
        self.assertEqual(len(body["values"]), len(body["md_ft"]))
        self.assertEqual({len(row) for row in body["values"]}, {32})

    @unittest.skipUnless((api.DATA_DIR / f"{GEOSIGNAL_RUN}.dlis").exists(), "geosignal run not available")
    def test_geosignal_colour_spec_is_symmetric_rdbu(self):
        curve = "ZGL112A"
        full = runs.get_run(GEOSIGNAL_RUN).curves[curve].ravel()
        limit = qc_percentile([abs(v) for v in full], 0.98)
        body = self.get(run=GEOSIGNAL_RUN, curve=curve, max_points=100).json()
        self.assertNotEqual(body["unit"], "ohmm")
        self.assertEqual(body["color"], {"scale": "RdBu", "reverse": True, "log10": False,
                                         "zmin": -limit, "zmax": limit})

    def test_min_curvature_agrees_with_utm_path(self):
        # 0.62 m measured over 382 m of hole; 2 m allows for survey stations being resampled to 0.5 ft
        # (INC/AZI at 0.01 deg) while staying below the 3 m DOI tube radius drawn for ARM48PC.
        data = runs.get_run(RUN)
        path = well3d.well_path(data)
        x, y, z = well3d.minimum_curvature(data.depth_m, path["INC"], path["AZI"])
        deviation = np.sqrt((x - (path["x"] - path["x"][0])) ** 2 + (y - (path["y"] - path["y"][0])) ** 2
                            + (z - (path["z"] - path["z"][0])) ** 2)
        self.assertLess(deviation.max(), 2.0)

    def test_falls_back_to_min_curvature_without_utm(self):
        data = runs.get_run(RUN)
        curves = {k: v for k, v in data.curves.items() if k not in ("UTMX", "UTMY")}
        stripped = WellRun(data.path, data.well, data.depth_m, curves, data.metadata, data.parameters)
        body = well3d.well3d(stripped, "ARM48PC", max_points=20000)
        self.assertEqual(body["path_source"], "min_curvature")
        self.assertIsNone(body["origin"]["utmx"])
        reference = self.get(curve="ARM48PC", max_points=20000).json()
        self.assertLess(abs(body["y_m"][-1] - reference["y_m"][-1]), 2.0)

    def test_errors(self):
        self.assertEqual(self.get(run="nope", curve="ARM48PC").status_code, 404)
        missing = self.get(curve="NOPE")
        self.assertEqual(missing.status_code, 404)
        self.assertIn("error", missing.json())
        self.assertEqual(self.get(curve="ARM48PC", max_points=99).status_code, 422)
        self.assertEqual(self.get(curve="ARM48PC", max_points=20001).status_code, 422)
        self.assertEqual(self.get().status_code, 422)


if __name__ == "__main__":
    unittest.main()
