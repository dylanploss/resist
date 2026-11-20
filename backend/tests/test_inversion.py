import unittest

import numpy as np

from backend.inversion.adr_forward import FT, ADRForward, LayerModel, Trajectory
from backend.inversion.invert import FitConfig, Inverter, IntervalData


class ForwardTests(unittest.TestCase):
    def test_homogeneous_transform_recovers_resistivity(self):
        fwd = ADRForward(dielectric=False)        # transform and earth share epsilon_r = 1
        for rho in (2.0, 20.0, 200.0):
            rp, ra = fwd.simulate_homogeneous(rho, rho, 1.0)
            np.testing.assert_allclose(rp, rho, rtol=2e-3)
            np.testing.assert_allclose(ra, rho, rtol=2e-3)

    def test_high_angle_anisotropy_separates_phase_above_attenuation(self):
        rp, ra = ADRForward(dielectric=False).simulate_homogeneous(9.0, 18.0, np.cos(np.deg2rad(86)))
        self.assertTrue(np.all(rp > ra))
        self.assertTrue(np.all(ra > 9.0))

    def test_dielectric_effect_reproduces_the_z20_attenuation_bias(self):
        """Earth permittivity from the resistivity relation, transform at epsilon_r = 1: at 10 ohm-m 2 MHz attenuation
        reads 8-20 % high (the Z-20 study measured 13-21 %, shorter spacings most), phase within 5 %, and the
        effect fades at low frequency."""
        from backend.inversion.adr_forward import permittivity

        self.assertAlmostEqual(float(permittivity(10.0)), 108.5 * 10 ** -0.35 + 5)
        fwd = ADRForward()
        names = [c.name for c in fwd.channels]
        rp, ra = fwd.simulate_homogeneous(10.0, 10.0, 1.0)
        high = [names.index(n) for n in ("ARH16", "ARH32", "ARH48")]
        self.assertTrue(np.all((ra[high] > 10.8) & (ra[high] < 12.0)))
        self.assertTrue(np.all(np.diff(ra[high]) < 0))             # shorter spacing, larger effect
        np.testing.assert_allclose(rp, 10.0, rtol=0.05)
        self.assertLess(ra[names.index("ARL48")], ra[names.index("ARH48")])
        # transform_eperm equal to the earth's permittivity cancels the effect again
        same = ADRForward(transform_eperm=float(permittivity(10.0)))
        np.testing.assert_allclose(same.simulate_homogeneous(10.0, 10.0, 1.0)[1], 10.0, rtol=5e-3)

    def test_vertical_permittivity_follows_rv(self):
        fwd = ADRForward()
        kw = fwd._eperm([4.0], [np.sqrt(16.0 / 4.0)])
        from backend.inversion.adr_forward import permittivity
        np.testing.assert_allclose(kw["epermH"], permittivity(4.0))
        np.testing.assert_allclose(kw["epermV"], permittivity(16.0))
        self.assertEqual(ADRForward(dielectric=False)._eperm([4.0, 9.0], [1.0, 1.0]), {"epermH": [1.0, 1.0],
                                                                                         "epermV": [1.0, 1.0]})

    def test_tool_straddling_a_boundary_is_finite_and_continuous(self):
        # empymod returns NaN when a transmitter is in a deeper layer than a receiver; reciprocity fills those pairs.
        fwd = ADRForward()
        cos_rel = np.cos(np.deg2rad(87))
        zc = np.linspace(-0.08, 0.08, 17)
        p = np.array([fwd._raw([0.0], [8.0, 40.0], [1.5, 1.5], z, cos_rel)[0] for z in zc])
        self.assertTrue(np.isfinite(p).all())
        self.assertLess(np.abs(np.diff(p, axis=0)).max(), 0.5 * np.ptp(p, axis=0).max())


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
    def test_qc_selection_maps_to_directional_channels(self):
        from types import SimpleNamespace

        from backend.inversion.service import build_plan

        names = ["ARH16PC", "ARH16P", "ARH16A", "ARM32A", "ZRL48P", "ZRH16PT", "ZRH16P", "ZRH16PL",
                 "ZGM112P", "ZRM50P", "GR"]
        run = SimpleNamespace(curves={n: None for n in names})
        plan = build_plan(run, ["ARH16PC", "ARH16P", "ARH16A", "ARM32A", "ZRL48P", "ZRH16P", "ZRH16PL",
                                "ZGM112P", "ZRM50P", "GR"])
        used = {u["label"]: u for u in plan["used"]}
        reasons = {i["curve"]: i["reason"] for i in plan["ignored"]}
        self.assertTrue(plan["azimuthal"])
        self.assertEqual((used["ARH16P"]["curve"], used["ARH16P"]["weight"]), ("ARH16PC", 1.0))
        self.assertIn("same channel as ARH16PC", reasons["ARH16P"])
        self.assertEqual(used["ARH16A"]["weight"], 0.5)
        self.assertIsNone(used["ARH16A"]["correction"])           # the dielectric model replaced the Z-20 table
        self.assertEqual(used["ARM32A"]["weight"], 0.0)           # 500/125 kHz attenuation: QC only
        # An image gives top and bottom 90-degree sectors of the image itself, for every run.
        self.assertEqual(plan["_sources"]["ZRH16PT"], ("ZRH16P", "T"))
        self.assertEqual(plan["_sources"]["ZRH16PB"], ("ZRH16P", "B"))
        self.assertEqual(plan["_sources"]["ZRL48PT"], ("ZRL48P", "T"))
        self.assertEqual(used["ZRL48PB"]["kind"], "bottom")
        self.assertEqual(plan["_sources"]["ZGM112PT"], ("ZGM112P", "T"))
        self.assertEqual(used["ZGM112PT"]["kind"], "geosignal")
        delivered_only = build_plan(SimpleNamespace(curves={"ZRM32AT": None}), ["ZRM32AT"])
        self.assertEqual(delivered_only["_sources"]["ZRM32AT"], "ZRM32AT")
        self.assertIn("left/right", reasons["ZRH16PL"])
        self.assertTrue(used["ZRM50PT"]["guessed_geometry"])
        self.assertEqual(used["ZRM50PB"]["weight"], 1.0)
        self.assertFalse(used["ZRL48PT"]["guessed_geometry"])
        self.assertTrue(any("Guessed geometry for ZRM50P" in w for w in plan["warnings"]))
        self.assertIn("context log", reasons["GR"])
        averaged_only = build_plan(run, ["ARH16A"], calibration=False)
        self.assertFalse(averaged_only["azimuthal"])
        self.assertEqual((averaged_only["used"][0]["weight"], averaged_only["used"][0]["correction"]), (1.0, None))
        self.assertTrue(any("above or below" in w for w in averaged_only["warnings"]))

    def test_azimuthal_average_is_conductivity_mean_and_skips_bad_bins(self):
        from backend.inversion.invert import azimuthal_average

        image = np.array([[10.0, 10.0, 10.0, 10.0], [5.0, 20.0, np.nan, -999.25]])
        np.testing.assert_allclose(azimuthal_average(image), [10.0, 8.0])

    def test_rh_bounds_follow_config(self):
        from backend.inversion.invert import Layout

        lay = Layout(FitConfig(n_layers=2, rh_min=2.0, rh_max=200.0), 1, 0.0)
        lo, hi = lay.bounds(-10, 10)
        np.testing.assert_allclose(lo[1:3], np.log10([2.0, 2.0]))
        np.testing.assert_allclose(hi[1:3], np.log10([200.0, 200.0]))

    def test_slices_tile_the_interval(self):
        from backend.inversion.service import slice_centres

        np.testing.assert_allclose(slice_centres(100.0, 120.0, 4.0), [102, 106, 110, 114, 118])
        np.testing.assert_allclose(slice_centres(100.0, 121.0, 4.0), [102, 106, 110, 114, 118, 122])
        np.testing.assert_allclose(slice_centres(100.0, 102.0, 4.0), [102])


class DirectionalForwardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fwd = ADRForward(azimuthal=True)
        cls.labels = cls.fwd.channel_labels()

    def horizontal(self, z):
        n = len(z)
        return Trajectory(np.arange(n, dtype=float), np.column_stack([np.zeros(n), np.zeros(n), z]),
                          np.tile([1.0, 0.0, 0.0], (n, 1)), np.tile([0.0, 0.0, -1.0], (n, 1)))

    def values(self, model, z):
        return [dict(zip(self.labels, row)) for row in self.fwd.predict(model, self.horizontal(np.array(z)))]

    def test_homogeneous_has_equal_bins_and_zero_geosignal(self):
        model = LayerModel(np.array([]), np.array([10.0]), np.array([10.0]))
        plain = ADRForward(azimuthal=True, dielectric=False)
        v = dict(zip(self.labels, plain.predict(model, self.horizontal(np.array([0.0])))[0]))
        for lab in ("ARH16P", "ZRH16PT", "ZRH16PB", "ZRL48AT", "ZRM50PT", "ZRL82PB"):
            self.assertAlmostEqual(10 ** v[lab], 10.0, delta=0.02)
        # With the dielectric effect a homogeneous earth still reads the same in every direction.
        (d,) = self.values(model, [0.0])
        for lab in (k for k in d if k.startswith("ZG")):
            self.assertAlmostEqual(v[lab], 0.0, places=6, msg=lab)
            self.assertAlmostEqual(d[lab], 0.0, places=6, msg=lab)
        for top in (k for k in d if k.startswith("ZR") and k.endswith("T")):
            self.assertAlmostEqual(d[top], d[top[:-1] + "B"], places=6, msg=top)

    def test_spec_geometry_uses_the_six_transmitters_and_r3(self):
        from backend.inversion.adr_forward import R3_IN

        fwd = ADRForward(azimuthal=True)
        self.assertEqual(sorted(g.name for g in fwd.geosignals),
                         sorted(["ZGH16", "ZGH32", "ZGH48", "ZGM16", "ZGM32", "ZGM48", "ZGM80", "ZGM96", "ZGM112",
                                 "ZGL48", "ZGL80", "ZGL96", "ZGL112"]))
        transmitters = (-48, -32, -16, 16, 32, 48)
        for g in fwd.geosignals:
            self.assertIn(R3_IN - g.spacing_in, transmitters)          # s = 64 - T
        midpoint = 0.5 * (fwd.receiver_sep_in / 2 + R3_IN)                # R1-R3 midpoint
        self.assertEqual(midpoint, 34.0)
        for ch in fwd.long_spacings:
            self.assertIn(midpoint - ch.spacing_in, (-16, -32, -48))      # T2, T4, T6

    def test_inclined_homogeneous_zero_geosignal_with_unnormalised_vectors(self):
        fwd = ADRForward(azimuthal=True, quadrant="bin", long_spacings=())
        traj = Trajectory(np.zeros(1), np.zeros((1, 3)), np.array([[0.999, 0, 0.0436]]),
                          np.array([[0.0436, 0, -0.999]]))
        row = fwd.predict(LayerModel(np.array([]), np.array([10.0]), np.array([10.0])), traj)[0]
        for lab, val in zip(fwd.channel_labels(), row):
            if lab.startswith("ZG"):
                self.assertAlmostEqual(val, 0.0, places=3, msg=lab)

    def test_bottom_bin_sees_resistive_bed_below_and_mirror_flips_sign(self):
        (below,) = self.values(LayerModel(np.array([1.0]), np.array([8.0, 50.0]), np.array([8.0, 50.0])), [0.8])
        (above,) = self.values(LayerModel(np.array([-1.0]), np.array([50.0, 8.0]), np.array([50.0, 8.0])), [-0.8])
        self.assertGreater(below["ZRL48PB"], below["ZRL48PT"])
        self.assertGreater(below["ZRM50PB"], below["ZRM50PT"])
        self.assertGreater(below["ZRL82PB"], below["ZRL82PT"])
        # Delivered-data convention: top geosignal rises when the bottom bin reads more resistive.
        self.assertGreater(below["ZGM112PT"], 1.0)
        self.assertGreater(below["ZGM112AT"], 0.1)
        self.assertAlmostEqual(above["ZRL48PT"], below["ZRL48PB"], places=6)
        # Bin minus the mean of all bins: mirroring the bed swaps the top and bottom geosignals.
        fwd = ADRForward(azimuthal=True, zg_sides=("T", "B"), long_spacings=())
        mirror = [dict(zip(fwd.channel_labels(), fwd.predict(m, self.horizontal(np.array([z])))[0])) for m, z in (
            (LayerModel(np.array([1.0]), np.array([8.0, 50.0]), np.array([8.0, 50.0])), 0.8),
            (LayerModel(np.array([-1.0]), np.array([50.0, 8.0]), np.array([50.0, 8.0])), -0.8))]
        self.assertAlmostEqual(mirror[1]["ZGM112PT"], mirror[0]["ZGM112PB"], places=6)
        self.assertLess(above["ZGM112PT"], 0.0)

    def test_sector_quadrants_symmetric_in_layers_and_follow_tool_roll(self):
        fwd = ADRForward(azimuthal=True, zr_sides=("T", "R", "B", "L"), zg_sides=("T", "R", "B", "L"))
        labels = fwd.channel_labels()
        model = LayerModel(np.array([1.0]), np.array([8.0, 50.0]), np.array([8.0, 50.0]), 2.0, 0.0)
        traj = self.horizontal(np.array([0.4, 0.7]))
        up = dict(zip(labels, fwd.predict(model, traj)[1]))
        self.assertAlmostEqual(up["ZRM48PR"], up["ZRM48PL"], places=9)
        self.assertAlmostEqual(up["ZGM112PR"], up["ZGM112PL"], places=9)
        self.assertGreater(up["ZRM48PB"], up["ZRM48PT"])
        traj.high = np.tile([0.0, 1.0, 0.0], (len(traj), 1))   # roll the tool 90 degrees about its axis
        rolled = dict(zip(labels, fwd.predict(model, traj)[1]))
        self.assertAlmostEqual(rolled["ZRM48PT"], rolled["ZRM48PB"], places=9)
        self.assertAlmostEqual(abs(rolled["ZRM48PR"] - rolled["ZRM48PL"]), up["ZRM48PB"] - up["ZRM48PT"], places=9)

    def test_sector_flattens_single_bin_contrast(self):
        model = LayerModel(np.array([1.0]), np.array([8.0, 50.0]), np.array([8.0, 50.0]))
        traj = self.horizontal(np.array([0.7]))
        out = {}
        for mode in ("bin", "sector"):
            fwd = ADRForward(azimuthal=True, quadrant=mode)
            out[mode] = dict(zip(fwd.channel_labels(), fwd.predict(model, traj)[0]))
        ratio = (out["sector"]["ZRM48PB"] - out["sector"]["ZRM48PT"]) / (out["bin"]["ZRM48PB"] - out["bin"]["ZRM48PT"])
        self.assertTrue(0.6 < ratio < 1.0)


class QuadrantTests(unittest.TestCase):
    def test_sectors_tile_bins_and_average_conductivity(self):
        from backend.data.quadrants import SIDES, quadrant, sector_bins

        self.assertEqual(sorted(b for s in SIDES for b in sector_bins(s)), list(range(32)))
        self.assertEqual(sector_bins("T"), [28, 29, 30, 31, 0, 1, 2, 3])
        image = np.full((2, 32), 10.0)
        image[0, sector_bins("B")] = [5.0, 20.0] * 4
        image[1, 29] = np.nan
        np.testing.assert_allclose(quadrant(image, "B"), [8.0, 10.0])
        np.testing.assert_allclose(quadrant(image, "T"), [10.0, 10.0])
        np.testing.assert_allclose(quadrant(image, "B", method="bin"), [5.0, 10.0])
        geo = np.zeros((1, 32))
        geo[0, sector_bins("R")] = np.arange(8)
        self.assertAlmostEqual(quadrant(geo, "R", resistivity=False)[0], 3.5)
        with self.assertRaises(ValueError):
            quadrant(np.ones((3, 16)), "T")

    def test_matches_delivered_quadrant_curves_on_z20(self):
        from pathlib import Path

        from backend.data.loader import load_run
        from backend.data.quadrants import CENTRE, quadrant

        path = Path(__file__).resolve().parents[2] / "data" / "2_4-Z-20_18840-23791ft_RES_GEOSIGNAL.dlis"
        if not path.exists():
            self.skipTest("Z-20 data not available")
        c = load_run(path).curves
        for side in CENTRE:
            ok = np.isfinite(c["ZRM48P" + side]) & np.all(c["ZRM48P"] > 0, axis=1)
            err = np.abs(np.log10(quadrant(c["ZRM48P"][ok], side) / c["ZRM48P" + side][ok]))
            single = np.abs(np.log10(quadrant(c["ZRM48P"][ok], side, method="bin") / c["ZRM48P" + side][ok]))
            self.assertLess(np.median(err), np.log10(1.02))
            self.assertLess(np.median(err), np.median(single))


class RobustnessTests(unittest.TestCase):
    def setUp(self):
        n = 6
        md = 20000 + np.arange(n) * 4.0
        traj = Trajectory.from_curves(md, np.full(n, 10600.0), np.full(n, 88.0), np.zeros(n), np.zeros(n),
                                      md * FT, ref=[0, 0, 10600 * FT])
        self.labels = ADRForward().channel_labels()
        obs = np.full((n, len(self.labels)), 1.0)
        self.data = IntervalData("synthetic", md, traj, obs, self.labels, np.zeros(n), np.array([0, 0, 10600 * FT]),
                                 np.full(n, 10600.0))
        self.weights = {lab: (1.0 if lab == "ARH16P" else 0.0) for lab in self.labels}

    def inverter(self, theory_of):
        inv = Inverter(self.data, FitConfig(n_layers=1, fit_dip=False, curve_weights=self.weights), workers=1)
        inv._theory_batch = lambda xs: [theory_of(x) for x in xs]
        return inv

    def test_nan_on_unused_channel_does_not_poison_fit(self):
        def theory(x):
            t = np.full(self.data.obs.shape, x[0])
            t[:, self.labels.index("ARL48A")] = np.nan           # weight 0: display only
            return t

        with self.inverter(theory) as inv:
            r = inv.fit(inv.x_from([], [1.3], 0.1))
        self.assertTrue(np.isfinite(r.cost))
        self.assertAlmostEqual(r.x[0], 1.0, places=3)

    def test_multistart_skips_unusable_start_and_reports_channel(self):
        j = self.labels.index("ARH16P")

        def theory(x):
            t = np.full(self.data.obs.shape, x[0])
            if x[0] > 2.0:
                t[2, j] = np.nan
            return t

        with self.inverter(theory) as inv:
            good = inv.multistart([inv.x_from([], [2.5], 0.1), inv.x_from([], [1.4], 0.1)])
            self.assertAlmostEqual(good.x[0], 1.0, places=3)
            with self.assertRaisesRegex(ValueError, r"ARH16P: non-finite model prediction at 1 station\(s\) \(MD 20008"):
                inv.multistart([inv.x_from([], [2.5], 0.1)])


if __name__ == "__main__":
    unittest.main()
