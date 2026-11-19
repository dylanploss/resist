import os
import unittest

import numpy as np

try:
    import jax  # noqa: F401
    HAVE_JAX = True
except ImportError:
    HAVE_JAX = False

from backend.inversion.adr_forward import FT, ADRForward, LayerModel, Trajectory


def horizontal_traj(z, inc_deg=88.0):
    n = len(z)
    inc = np.deg2rad(inc_deg)
    axis = np.tile([np.sin(inc), 0.0, np.cos(inc)], (n, 1))
    high = np.tile([np.cos(inc), 0.0, -np.sin(inc)], (n, 1))
    ned = np.column_stack([np.arange(n) * 1.2, np.zeros(n), np.asarray(z, float)])
    return Trajectory(np.arange(n, dtype=float), ned, axis, high)


@unittest.skipUnless(HAVE_JAX, "jax not installed")
class JaxKernelTests(unittest.TestCase):
    def setUp(self):
        import jax.numpy as jnp
        from backend.inversion.jax_forward import _filter, tensor
        self.jnp, self.tensor = jnp, tensor
        self.base, self.j0, self.j1 = (jnp.asarray(v) for v in _filter())

    def t(self, f, zi, res, aniso, zs, zr, rho):
        jnp = self.jnp
        sh = 1 / jnp.asarray(res, float)
        sv = sh / jnp.asarray(aniso, float) ** 2
        out = self.tensor(jnp.array([2 * np.pi * f]), jnp.asarray(zi, float), sh, sv, jnp.array([zs]), jnp.array([zr]),
                          jnp.array([rho]), self.base, self.j0, self.j1)
        return [complex(v[0, 0]) for v in out]

    def test_whole_space_matches_closed_form(self):
        from backend.inversion.jax_forward import EPS0, MU0
        f, rho, dz, sigma = 2e6, 0.8, 0.4, 0.1
        T = self.t(f, [], [1 / sigma], [1.0], 0.1, 0.1 + dz, rho)
        om = 2 * np.pi * f
        k = np.sqrt(1j * om * MU0 * (sigma - 1j * om * EPS0))
        R = np.hypot(rho, dz)
        u = np.array([rho, 0.0, dz]) / R

        def A(i, j):
            d = float(i == j)
            return np.exp(1j * k * R) / (4 * np.pi * R ** 3) * ((3 * u[i] * u[j] - d) * (1 - 1j * k * R)
                                                              + (d - u[i] * u[j]) * (k * R) ** 2)

        for got, ref in zip(T, [A(0, 0), A(1, 1), A(2, 2), A(0, 2), A(2, 0)]):
            self.assertLess(abs(got - ref) / abs(ref), 1e-10)

    def test_layered_tiv_matches_empymod(self):
        import empymod
        from backend.inversion.jax_forward import MU0
        f = 5e5
        depth, res, aniso = [0.3, 1.1], [5.0, 40.0, 8.0], [1.3, 1.5, 1.0]
        for zs, zr, rho in ((0.1, 0.5, 0.8), (0.9, 0.2, 1.2), (-0.4, 1.4, 0.6)):
            T = self.t(f, depth, res, aniso, zs, zr, rho)
            for got, (a, b) in zip(T, (([0, 0], [0, 0]), ([90, 0], [90, 0]), ([0, 90], [0, 90]),
                                       ([0, 90], [0, 0]), ([0, 0], [0, 90]))):
                ref = np.conj(empymod.bipole([0, 0, zs, *a], [rho, 0, zr, *b], depth=depth, res=res, aniso=aniso,
                                             freqtime=f, msrc=True, mrec=True, verb=0, xdirect=True,
                                             htarg={"dlf": "key_201_2012", "pts_per_dec": 0}))
                ref = complex(ref) * (2 * np.pi * f * MU0) / 1j           # empymod field normalisation
                self.assertLess(abs(got - ref) / abs(ref), 1e-8)


@unittest.skipUnless(HAVE_JAX, "jax not installed")
class JaxADRTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from backend.inversion.jax_forward import shared_jax_forward
        cls.fwd = ADRForward(azimuthal=True)
        cls.jf = shared_jax_forward(cls.fwd)
        cls.labels = cls.fwd.channel_labels()
        cls.units = cls.fwd.units()

    def test_all_channels_match_empymod_path(self):
        traj = horizontal_traj([0.1, 0.5, 0.9])
        m = LayerModel(np.array([1.0]) * FT * 3, np.array([6.0, 45.0]), np.array([9.0, 60.0]), 1.5, 0.0)
        ref, got = self.fwd.predict(m, traj), self.jf.predict(m, traj)
        log = np.array([u == "log" for u in self.units])
        self.assertLess(np.abs(got - ref)[:, log].max(), 1e-8)            # log10 ohm-m
        self.assertLess(np.abs(got - ref)[:, ~log].max(), 1e-8)           # deg / dB

    def test_exact_jacobian_matches_finite_differences(self):
        from backend.inversion.jax_forward import JaxTheory
        traj = horizontal_traj([0.1, 0.6])
        th = JaxTheory(self.fwd, traj, 2, 1, True, 0.0)
        x = np.array([3.0, 0.8, 1.6, 0.15, 1.0])                          # boundary ft, log rh x2, log aniso, dip
        J = th.jacobian(x)
        for j, h in enumerate([1e-4, 1e-5, 1e-5, 1e-5, 1e-4]):
            e = np.zeros_like(x); e[j] = h
            fd = (th(x + e) - th(x - e)) / (2 * h)
            np.testing.assert_allclose(J[:, :, j], fd, rtol=1e-4, atol=1e-6)


@unittest.skipUnless(HAVE_JAX and os.environ.get("RESIST_SLOW_TESTS"), "slow (compiles the batched LM)")
class BatchedLMTests(unittest.TestCase):
    def test_batched_lm_recovers_boundary_from_wrong_side_start(self):
        from backend.inversion.batched import solver, window_arrays
        from backend.inversion.invert import FitConfig, IntervalData, Layout
        from backend.inversion.jax_forward import shared_jax_forward
        fwd = ADRForward(azimuthal=True)
        labels = fwd.channel_labels()
        traj = horizontal_traj(np.linspace(-0.6, 0.6, 12) * FT)
        truth = LayerModel(np.array([4.0]) * FT, np.array([8.0, 40.0]), np.array([12.0, 60.0]), 0.0, 0.0)
        obs = shared_jax_forward(fwd).predict(truth, traj)
        data = IntervalData("syn", traj.md_ft, traj, obs, labels, np.zeros(12), np.zeros(3), traj.ned[:, 2] / FT)
        use = {"ARM16P", "ZRL48PT", "ZRL48PB", "ZRM48PT", "ZRM48PB", "ZGM112PT"}
        weights = {lab: float(lab in use) for lab in labels}
        sigma = {lab: (0.02 if u == "log" else 0.5 if u == "deg" else 0.05) for lab, u in zip(labels, fwd.units())}
        cfg = FitConfig(n_layers=2, fit_dip=False, curve_weights=weights, curve_sigma=sigma, azimuthal=True)
        lay = Layout(cfg, len(labels), 0.0)
        lo, hi = lay.bounds(-45.0, 45.0)
        win = window_arrays(data, weights, sigma, None, lo, hi, dip_az=0.0)
        fn = solver(fwd, 2, lay.n_aniso, False, iters=30)
        import jax.numpy as jnp
        from backend.inversion.batched import stack
        x, c, chi = fn(jnp.asarray([[-6.0, 1.3, 1.3, 0.1]]), stack([win]))      # start: boundary above the well
        m = lay.model(np.asarray(x)[0])
        self.assertAlmostEqual(m.boundaries_m[0] / FT, 4.0, delta=0.3)
        self.assertLess(float(chi[0]), 0.5)


if __name__ == "__main__":
    unittest.main()
