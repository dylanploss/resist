"""Dip-line constraints, posterior uncertainty and partial re-run helpers of the 1.5D inversion."""

from types import SimpleNamespace
import unittest

import numpy as np

from backend.inversion import service
from backend.inversion.adr_forward import FT, LayerModel, Trajectory
from backend.inversion.invert import FitConfig, IntervalData, Layout


def interval(n=21, inc=85.0, azi=90.0):
    md = 1000.0 + 2.0 * np.arange(n)
    inc_r = np.deg2rad(inc)
    ue = (md - md[0]) * FT * np.sin(inc_r)
    un = np.zeros(n)
    tvd = 5000.0 + (md - md[0]) * np.cos(inc_r)
    ref = np.array([un.mean(), ue.mean(), tvd.mean() * FT])
    traj = Trajectory.from_curves(md, tvd, np.full(n, inc), np.full(n, azi), ue, un, ref=ref)
    return IntervalData("W", md, traj, np.zeros((n, 2)), ["A", "B"], np.zeros(n), ref, tvd,
                        np.ones((n, 2), bool), ["log", "log"])


class LineDipTests(unittest.TestCase):
    def test_line_through_a_model_boundary_recovers_its_dip_and_depth(self):
        data = interval()
        for dip in (4.0, -3.0):
            m = LayerModel(np.array([1.5 * FT]), np.array([1.0, 10.0]), np.array([2.0, 20.0]), dip, 90.0)
            b = service.model_geometry(data, m)["boundary_tvd_ft"][0]
            line = {"md1_ft": float(data.md_ft[2]), "tvd1_ft": b[2], "md2_ft": float(data.md_ft[15]), "tvd2_ft": b[15]}
            got_dip, got_b = service.line_dip(data, 90.0, line)
            self.assertAlmostEqual(got_dip, dip, places=2)
            self.assertAlmostEqual(got_b, 1.5, places=2)

    def test_lines_outside_the_window_do_not_constrain(self):
        data = interval()
        line = {"md1_ft": 1000.0, "tvd1_ft": 5000.0, "md2_ft": 1010.0, "tvd2_ft": 5001.0, "anchor": True}
        far = service._slice_constraints(data, data, [line], 1035.0, 10.0, 2.0, 2.0, 15.0)
        near = service._slice_constraints(data, data, [line], 1012.0, 10.0, 2.0, 2.0, 15.0)
        self.assertIsNone(far)
        self.assertEqual(near["summary"]["anchored"], 1)
        self.assertEqual(near["cfg"]["dip_prior"][1], 2.0)

    def test_steep_line_widens_the_dip_bound(self):
        data = interval()
        line = {"md1_ft": 1000.0, "tvd1_ft": 5000.0, "md2_ft": 1020.0, "tvd2_ft": 5012.0}
        cons = service._slice_constraints(data, data, [line], 1010.0, 10.0, 2.0, 2.0, 15.0)
        self.assertGreater(abs(cons["cfg"]["dip_prior"][0]), 15.0)
        self.assertGreater(cons["cfg"]["dip_limit_deg"], abs(cons["cfg"]["dip_prior"][0]))


class PriorTests(unittest.TestCase):
    def test_prior_jacobian_matches_finite_differences(self):
        cfg = FitConfig(n_layers=3, dip_prior=(5.0, 2.0), boundary_priors=((3.0, 1.0), (9.0, 0.5)))
        lay = Layout(cfg, 2, 90.0)
        x = np.array([0.0, 5.0, 0.0, 1.0, 0.5, 0.1, 1.0])
        rows, jac = lay.prior_rows(x)
        self.assertEqual(rows.shape, (3,))
        fd = np.zeros_like(jac)
        for j in range(len(x)):
            dx = np.zeros_like(x)
            dx[j] = 1e-6
            fd[:, j] = (lay.prior_rows(x + dx)[0] - rows) / 1e-6
        np.testing.assert_allclose(jac, fd, atol=1e-4)

    def test_no_priors_add_no_rows(self):
        lay = Layout(FitConfig(n_layers=2), 2, 0.0)
        rows, jac = lay.prior_rows(np.zeros(lay.n_params))
        self.assertEqual((rows.size, jac.shape[0]), (0, 0))


class ReweightAndUncertaintyTests(unittest.TestCase):
    def test_only_the_outlier_curve_is_downweighted(self):
        labels = ["A", "B", "C", "D"]
        residual = np.column_stack([np.full(10, 0.02), np.full(10, -0.02), np.full(10, 0.03), np.full(10, 0.5)])
        f = service._misfit_factors(SimpleNamespace(residual=residual), dict.fromkeys(labels, 0.02), labels,
                                    np.ones(4))
        self.assertEqual([f["A"], f["B"], f["C"]], [1.0, 1.0, 1.0])
        self.assertLess(f["D"], 0.1)

    def test_unseen_layer_is_the_most_uncertain(self):
        cfg = FitConfig(n_layers=3)
        lay = Layout(cfg, 2, 0.0)
        rng = np.random.default_rng(0)
        jac = rng.normal(0, 30, (60, lay.n_earth))
        jac[:, 4] = 0.0                                     # third layer's log Rh: invisible to the data
        res = SimpleNamespace(extra={"jac": jac}, cost=30.0)
        unc = service._uncertainty(SimpleNamespace(lay=lay, cfg=cfg), res)
        self.assertEqual(unc["rh_std_log"][2], service.MAX_RH_STD_LOG)
        self.assertLess(max(unc["rh_std_log"][:2]), 0.1)
        self.assertEqual(len(unc["boundary_std_ft"]), 2)


class PartialRerunTests(unittest.TestCase):
    def test_slice_entry_round_trips_to_the_model(self):
        data = interval()
        m = LayerModel(np.array([-2.0 * FT, 4.0 * FT]), np.array([1.0, 30.0, 3.0]), np.array([2.0, 60.0, 6.0]),
                       3.0, 90.0)
        entry = service._slice_entry(data, m, np.arange(len(data.md_ft)), 1020.0, 4.0, 1.0)
        back = service._model_from_slice(data, entry)
        np.testing.assert_allclose(back.boundaries_m, m.boundaries_m, atol=1e-3)
        x = service._x_from_model(back)
        np.testing.assert_allclose(x[:2], [-2.0, 6.0], atol=1e-2)
        self.assertAlmostEqual(x[-1], 3.0)

    def test_kept_slices_lie_outside_the_rerun_range(self):
        data = interval()
        centres = service.slice_centres(float(data.md_ft[0]), float(data.md_ft[-1]), 4.0)
        base = {"md_ft": list(data.md_ft), "slices": [{"md_centre_ft": float(c), "layers": [{}, {}]} for c in centres]}
        keep, rng = service._kept_slices(data, centres, {"layers": 2, "rerun_md_min_ft": 1010.0,
                                                         "rerun_md_max_ft": 1020.0, "base_job_id": "b"},
                                         base, [], 20.0)
        self.assertTrue(all(not (1010.0 <= centres[s] <= 1020.0) for s in keep))
        self.assertEqual(rng["kept_slices"] + rng["recomputed_slices"], len(centres))
        self.assertGreater(rng["recomputed_slices"], 0)
        with self.assertRaisesRegex(ValueError, "different stations"):
            service._kept_slices(data, centres, {"layers": 2, "rerun_md_min_ft": 1010.0, "rerun_md_max_ft": 1020.0},
                                 {**base, "md_ft": list(data.md_ft[:-1])}, [], 20.0)


if __name__ == "__main__":
    unittest.main()
