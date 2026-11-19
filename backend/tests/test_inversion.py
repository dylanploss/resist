import unittest

import numpy as np

from backend.inversion.adr_forward import FT, ADRForward, LayerModel, Trajectory
from backend.inversion.invert import FitConfig, Inverter, IntervalData


class ForwardTests(unittest.TestCase):
    def test_homogeneous_transform_recovers_resistivity(self):
        fwd = ADRForward()
        for rho in (2.0, 20.0, 200.0):
            rp, ra = fwd.simulate_homogeneous(rho, rho, 1.0)
            np.testing.assert_allclose(rp, rho, rtol=2e-3)
            np.testing.assert_allclose(ra, rho, rtol=2e-3)

    def test_high_angle_anisotropy_separates_phase_above_attenuation(self):
        rp, ra = ADRForward().simulate_homogeneous(9.0, 18.0, np.cos(np.deg2rad(86)))
        self.assertTrue(np.all(rp > ra))
        self.assertTrue(np.all(ra > 9.0))


class InversionTests(unittest.TestCase):
    def test_recovers_boundary_and_channel_bias(self):
        fwd = ADRForward()
        n = 30
        md = 20000 + np.arange(n) * 4.0
        tvd = 10600 + np.linspace(-6, 6, n)
        inc = np.full(n, 87.0)
        traj = Trajectory.from_curves(md, tvd, inc, np.zeros(n), np.zeros(n), (md - md[0]) * FT * 0.999,
                                      ref=[0, 0, 10600 * FT])
        truth = LayerModel(np.array([1.5 * FT]), np.array([8.0, 40.0]), np.array([12.0, 60.0]), 0.0, 0.0)
        rp, ra = fwd.simulate(truth, traj)
        bias = np.zeros(14)
        bias[7] = np.log10(1.12)
        obs = np.log10(np.column_stack([rp, ra])) + bias
        data = IntervalData("synthetic", md, traj, obs, fwd.channel_labels(), np.zeros(n),
                            np.array([0, 0, 10600 * FT]), tvd)
        with Inverter(data, FitConfig(n_layers=2, fit_dip=False, fit_bias=True), workers=4) as inv:
            r = inv.fit(inv.x_from([0.0], [1.0, 1.5], 0.1, bias=np.zeros(14)))
        self.assertAlmostEqual(r.model.boundaries_m[0] / FT, 1.5, delta=0.2)
        self.assertAlmostEqual(10 ** r.bias[7], 1.12, delta=0.01)
        self.assertLess(r.rms_percent(), 0.5)
    def test_level_correction_grows_with_resistivity_on_listed_curve_only(self):
        from backend.inversion.invert import LevelCorrection

        fwd = ADRForward()
        labels = fwd.channel_labels()
        lc = LevelCorrection.from_table(labels, {"ARH16A": (0.08, 0.12)})
        theory = np.log10(np.array([[10.0] * 14, [40.0] * 14]))
        out = 10 ** lc.apply_to_theory(theory)
        j = labels.index("ARH16A")
        self.assertAlmostEqual(out[0, j], 10 * 10 ** 0.08, places=6)
        self.assertAlmostEqual(out[1, j], 40 * 10 ** (0.08 + 0.12 * np.log10(4)), places=6)
        np.testing.assert_allclose(np.delete(out, j, axis=1), np.delete(10 ** theory, j, axis=1))
class PlanTests(unittest.TestCase):
    def test_qc_selection_maps_to_forward_channels(self):
        from types import SimpleNamespace

        from backend.inversion.service import build_plan

        names = ["ARH16PC", "ARH16P", "ARH16A", "ARM32A", "ZRL48P", "ARL48P", "ZGM112A", "ZRM50P", "GR"]
        run = SimpleNamespace(curves={n: None for n in names})
        plan = build_plan(run, ["ARH16PC", "ARH16P", "ARH16A", "ARM32A", "ZRL48P", "ZGM112A", "ZRM50P", "GR"])
        used = {u["label"]: u for u in plan["used"]}
        self.assertEqual(used["ARH16P"]["curve"], "ARH16PC")
        self.assertEqual(used["ARH16P"]["weight"], 1.0)
        self.assertEqual(used["ARH16A"]["weight"], 0.5)
        self.assertIsNotNone(used["ARH16A"]["correction"])
        self.assertEqual(used["ARM32A"]["weight"], 0.25)
        self.assertIsNone(used["ARM32A"]["correction"])
        reasons = {i["curve"]: i["reason"] for i in plan["ignored"]}
        self.assertIn("same channel as ARH16PC", reasons["ARH16P"])
        self.assertIn("ARL48P", reasons["ZRL48P"])
        self.assertIn("geosignal", reasons["ZGM112A"])
        self.assertIn("not in the 1.5D", reasons["ZRM50P"])
        self.assertIn("not an ADR", reasons["GR"])
        raw = build_plan(run, ["ARH16A"], calibration=False)["used"][0]
        self.assertEqual((raw["weight"], raw["correction"]), (1.0, None))


if __name__ == "__main__":
    unittest.main()
