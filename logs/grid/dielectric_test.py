"""How far does formation permittivity move each ADR channel, read through the inversion's eps_r=1 transform?

    python logs/grid/dielectric_test.py

Homogeneous earth, true resistivity R, relative permittivity eps_r (and optional anisotropy at a high
relative angle). Raw compensated phase/attenuation come from the repo's own ``ADRForward._raw`` geometry with
``epermH/epermV`` passed to empymod; apparent Rp/Ra use ``ADRForward.apparent`` (whole-space tables at eps_r=1),
exactly as the inversion does. Output: apparent / true resistivity per channel.
"""

import numpy as np

from backend.inversion import adr_forward as af


class DielectricADR(af.ADRForward):
    eps_r: float = 1.0

    def _raw(self, depth, res, aniso, zc, cos_rel):
        sin_rel = np.sqrt(max(0.0, 1.0 - cos_rel * cos_rel))
        dip = np.rad2deg(np.arcsin(np.clip(cos_rel, -1, 1)))

        def pts(off):
            n = len(off)
            return [off * sin_rel, np.zeros(n), zc + off * cos_rel, np.zeros(n), np.full(n, dip)]

        n_lay = len(res)
        h = af._bipole(pts(self.tx_offsets), pts(self.rx_offsets), depth=list(depth), res=list(res),
                       freqtime=self.freqs, aniso=list(aniso), epermH=[1.0] + [self.eps_r] * (n_lay - 1)
                       if n_lay > 1 else [self.eps_r], epermV=[1.0] + [self.eps_r] * (n_lay - 1)
                       if n_lay > 1 else [self.eps_r], verb=0, htarg=af.HTARG)
        h = np.conj(h)
        ns = len(self.spacings)
        out_p, out_a = [], []
        for c in self.channels:
            fi = int(np.searchsorted(self.freqs, c.frequency_hz))
            si = int(np.searchsorted(self.spacings, c.spacing_in))
            up = h[fi, 0, si] / h[fi, 1, si]
            dn = h[fi, 1, ns + si] / h[fi, 0, ns + si]
            out_p.append(-0.5 * (np.angle(up, deg=True) + np.angle(dn, deg=True)))
            out_a.append(0.5 * 20 * (np.log10(abs(up)) + np.log10(abs(dn))))
        return np.array(out_p), np.array(out_a)


def run(R, eps, rv_rh=1.0, cos_rel=1.0):
    ref = af.ADRForward()                      # eps_r = 1 transform tables, as in the inversion
    m = DielectricADR()
    m.eps_r = eps
    p, a = m._raw([], [R], [np.sqrt(rv_rh)], 0.0, cos_rel)
    rp, ra = ref.apparent(p[None], a[None])
    return rp[0] / R, ra[0] / R, [c.name for c in ref.channels]


def main():
    names = None
    print("apparent / true resistivity (eps_r=1 transform)\n")
    for label, rv_rh, cos_rel in (("vertical well, isotropic", 1.0, 1.0),
                                  ("88 deg relative angle, Rv/Rh = 2", 2.0, np.cos(np.deg2rad(88)))):
        print(f"--- {label}")
        for R in (3.0, 10.0, 30.0):
            for eps in (1.0, 20.0, 60.0, 150.0):
                fp, fa, names = run(R, eps, rv_rh, cos_rel)
                if eps == 1.0 and R == 3.0:
                    print(f"{'R':>5} {'eps_r':>6}   " + " ".join(f"{n[2:]+'P':>7}" for n in names) + "   "
                          + " ".join(f"{n[2:]+'A':>7}" for n in names))
                print(f"{R:5.0f} {eps:6.0f}   " + " ".join(f"{v:7.2f}" for v in fp) + "   "
                      + " ".join(f"{v:7.2f}" for v in fa))
        print()


if __name__ == "__main__":
    main()
