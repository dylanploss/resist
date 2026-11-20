from types import SimpleNamespace
import unittest

import numpy as np

from backend.inversion import facets
from backend.inversion.invert import FitConfig, Layout


class FacetPlanTests(unittest.TestCase):
    def test_image_selection_adds_right_left_and_geosignal_right(self):
        names = ["ARH16P", "ZRH16P", "ZRM48A", "ZGM112P", "ZRM32PL", "ZRM32P", "ZRM50P", "GR"]
        run = SimpleNamespace(curves={n: None for n in names})
        plan = facets.build_plan(run, ["ARH16P", "ZRH16P", "ZRM48A", "ZGM112P", "ZRM32PL", "ZRM50P", "GR"])
        used = {u["label"]: u for u in plan["used"]}
        for side, kind in (("T", "top"), ("R", "right"), ("B", "bottom"), ("L", "left")):
            self.assertEqual(plan["_sources"][f"ZRH16P{side}"], ("ZRH16P", side))
            self.assertEqual(used[f"ZRH16P{side}"]["kind"], kind)
        self.assertIn("ZRM32PL", used)                       # a directly selected left curve brings its image
        self.assertEqual(plan["_sources"]["ZGM112PR"], ("ZGM112P", "R"))
        self.assertEqual(plan["_sources"]["ZGM112PL"], ("ZGM112P", "L"))   # bin minus mean: left is not -right
        self.assertEqual(used["ZRM48AL"]["weight"], used["ZRM48AT"]["weight"])
        reasons = {i["curve"]: i["reason"] for i in plan["ignored"]}
        # Long-spacing images use the guessed geometry at full weight, and get right/left quadrants too.
        self.assertEqual(plan["_sources"]["ZRM50PR"], ("ZRM50P", "R"))
        self.assertTrue(used["ZRM50PL"]["guessed_geometry"])
        self.assertEqual(used["ZRM50PT"]["weight"], used["ZRM32PT"]["weight"])
        self.assertFalse(any("left/right" in r for r in reasons.values()))

    def test_warns_without_right_left_quadrants(self):
        run = SimpleNamespace(curves={"ARH16P": None})
        self.assertTrue(any("sideways" in w for w in facets.build_plan(run, ["ARH16P"])["warnings"]))

    def test_windows_half_overlap_and_cover_interval(self):
        c = facets.window_centres(22200, 22600, 100)
        np.testing.assert_allclose(np.diff(c), 50)
        self.assertEqual((c[0] - 50, c[-1] + 50), (22200, 22600))
        np.testing.assert_allclose(facets.window_centres(0, 60, 100), [30])


class CrossDipLayoutTests(unittest.TestCase):
    def layout(self, cross):
        return Layout(FitConfig(n_layers=2, fit_cross_dip=cross), 4, dip_azimuth=170.0)

    def test_zero_cross_dip_equals_along_well_dip(self):
        x15 = np.array([3.0, 1.0, 1.5, 0.1, -2.0])
        m15 = self.layout(False).model(x15)
        m3d = self.layout(True).model(np.append(x15, 0.0))
        np.testing.assert_allclose(m3d.normal(), m15.normal(), atol=1e-12)

    def test_positive_cross_dip_deepens_beds_to_the_right_of_the_heading(self):
        lay = self.layout(True)
        self.assertEqual(lay.n_earth, 6)
        m = lay.model(np.array([3.0, 1.0, 1.5, 0.1, 0.0, 5.0]))
        self.assertAlmostEqual(m.dip_deg, 5.0, places=9)
        self.assertAlmostEqual(m.dip_azimuth_deg % 360, 260.0, places=9)   # heading 170 + 90 = right
        n = m.normal()
        right = np.array([np.cos(np.deg2rad(260)), np.sin(np.deg2rad(260)), 0.0])
        depth_change = -(n[:2] @ right[:2]) / n[2]                         # dz per metre moved to the right
        self.assertGreater(depth_change, 0)
        lo, hi = lay.bounds(-10, 10)
        self.assertEqual((lo[-1], hi[-1], len(lay.steps())), (-15.0, 15.0, 6))


if __name__ == "__main__":
    unittest.main()
