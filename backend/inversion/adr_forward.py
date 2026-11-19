"""ADR averaged-resistivity forward model for a 1.5D (dipping, layered TIV) earth.

Physics assumptions (none of these are vendor-confirmed; see docs/inversion/HACKATHON_PLAN.md):

* The averaged ``AR`` curves are the azimuthal mean of the 45-degree tilted receivers. The mean of
  ``cos(t)Hzz + sin(t)(Hxz cos(psi) + Hyz sin(psi))`` over psi is ``cos(t)Hzz``, so each AR channel
  is modelled as a coaxial (ZZ) receiver-pair ratio.
* Two receivers sit ``receiver_sep_in`` apart, symmetric about the tool midpoint; transmitters sit at
  +/- ``spacing`` from that midpoint. Compensation averages the up and down transmitters (phase in
  degrees, attenuation in dB), as in the ADR patent formulas.
* Apparent resistivity uses a homogeneous isotropic whole-space transform with the same geometry.
  The vendor transform includes mandrel, borehole and calibration effects we cannot reproduce,
  which is why ``backend.inversion.invert`` supports per-channel correction factors.

Units: metres and ohm-m internally. Trajectory inputs use the delivered DLIS curves
(MD/TVD in ft, INC/AZI in degrees, UTM in m).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import empymod
import numpy as np

FT = 0.3048
INCH = 0.0254
HTARG = {"dlf": "key_201_2012"}


@dataclass(frozen=True)
class Channel:
    name: str
    frequency_hz: float
    spacing_in: float


DEFAULT_CHANNELS = (
    Channel("ARH16", 2e6, 16), Channel("ARH32", 2e6, 32), Channel("ARH48", 2e6, 48),
    Channel("ARM16", 5e5, 16), Channel("ARM32", 5e5, 32), Channel("ARM48", 5e5, 48),
    Channel("ARL48", 1.25e5, 48),
)


@dataclass
class Trajectory:
    """Station positions (NED, metres, relative to a reference point) and tool axes."""

    md_ft: np.ndarray
    ned: np.ndarray          # (n, 3)
    axis: np.ndarray         # (n, 3) unit, bit-ward

    @classmethod
    def from_curves(cls, md_ft, tvd_ft, inc_deg, azi_deg, utm_e, utm_n, ref=None):
        ned = np.column_stack([utm_n, utm_e, np.asarray(tvd_ft) * FT])
        ref = ned.mean(axis=0) if ref is None else np.asarray(ref)
        inc, azi = np.deg2rad(inc_deg), np.deg2rad(azi_deg)
        axis = np.column_stack([np.sin(inc) * np.cos(azi), np.sin(inc) * np.sin(azi), np.cos(inc)])
        return cls(np.asarray(md_ft, float), ned - ref, axis)

    def __len__(self):
        return len(self.md_ft)


@dataclass
class LayerModel:
    """Planar dipping TIV layers. Boundaries are TVDs (m, relative to the trajectory reference)
    at the reference N/E point, ordered shallow to deep."""

    boundaries_m: np.ndarray
    rh: np.ndarray
    rv: np.ndarray
    dip_deg: float = 0.0
    dip_azimuth_deg: float = 0.0

    def normal(self):
        d, a = np.deg2rad(self.dip_deg), np.deg2rad(self.dip_azimuth_deg)
        return np.array([-np.sin(d) * np.cos(a), -np.sin(d) * np.sin(a), np.cos(d)])


@dataclass
class ADRForward:
    channels: tuple = DEFAULT_CHANNELS
    receiver_sep_in: float = 8.0
    rho_grid: np.ndarray = field(default_factory=lambda: np.logspace(-1, 3.3, 260))

    def __post_init__(self):
        self.freqs = np.array(sorted({c.frequency_hz for c in self.channels}))
        self.spacings = np.array(sorted({c.spacing_in for c in self.channels}))
        half = 0.5 * self.receiver_sep_in * INCH
        self.rx_offsets = np.array([-half, half])
        self.tx_offsets = np.concatenate([-self.spacings, self.spacings]) * INCH
        self._tables = None

    # ------------------------------------------------------------------ raw responses
    def _raw(self, depth, res, aniso, zc, cos_rel):
        """Compensated (phase deg, atten dB) for all channels at one station."""
        sin_rel = np.sqrt(max(0.0, 1.0 - cos_rel * cos_rel))
        dip = np.rad2deg(np.arcsin(np.clip(cos_rel, -1, 1)))

        def pts(off):
            n = len(off)
            return [off * sin_rel, np.zeros(n), zc + off * cos_rel, np.zeros(n), np.full(n, dip)]

        h = empymod.bipole(pts(self.tx_offsets), pts(self.rx_offsets), depth=list(depth), res=list(res),
                           freqtime=self.freqs, aniso=list(aniso), msrc=True, mrec=True, verb=0,
                           htarg=HTARG)
        h = np.conj(np.asarray(h).reshape(len(self.freqs), 2, len(self.tx_offsets)))  # e^{-iwt}
        ns = len(self.spacings)
        out_p, out_a = [], []
        for c in self.channels:
            fi = int(np.searchsorted(self.freqs, c.frequency_hz))
            si = int(np.searchsorted(self.spacings, c.spacing_in))
            up = h[fi, 0, si] / h[fi, 1, si]            # Tx above: near Rx is index 0
            dn = h[fi, 1, ns + si] / h[fi, 0, ns + si]  # Tx below: near Rx is index 1
            out_p.append(-0.5 * (np.angle(up, deg=True) + np.angle(dn, deg=True)))  # phase lag, > 0
            out_a.append(0.5 * 20 * (np.log10(abs(up)) + np.log10(abs(dn))))
        return np.array(out_p), np.array(out_a)

    # ------------------------------------------------------------------ transforms
    def tables(self):
        if self._tables is None:
            ph, at = [], []
            for r in self.rho_grid:
                p, a = self._raw([], [r], [1.0], 0.0, 1.0)
                ph.append(p); at.append(a)
            self._tables = (np.array(ph), np.array(at))   # (n_rho, n_chan), both decrease with rho
        return self._tables

    def apparent(self, phase, atten):
        """Phase/attenuation arrays (..., n_chan) to (Rp, Ra) in ohm-m via the whole-space transform."""
        ph_t, at_t = self.tables()
        lr = np.log10(self.rho_grid)
        rp = np.empty_like(phase); ra = np.empty_like(atten)
        for k in range(len(self.channels)):
            rp[..., k] = 10 ** np.interp(-phase[..., k], -ph_t[:, k], lr)
            a = np.minimum.accumulate(at_t[:, k])            # enforce monotonic for interpolation
            ra[..., k] = 10 ** np.interp(-atten[..., k], -a, lr)
        return rp, ra

    # ------------------------------------------------------------------ 1.5D driver
    def simulate(self, model: LayerModel, traj: Trajectory):
        """Return (Rp, Ra), each (n_stations, n_channels), for a dipping layered TIV model."""
        n = model.normal()
        zc = traj.ned @ n
        cos_rel = traj.axis @ n
        ref_pts = np.column_stack([np.zeros_like(model.boundaries_m), np.zeros_like(model.boundaries_m),
                                   model.boundaries_m])
        depth = ref_pts @ n
        aniso = np.sqrt(model.rv / model.rh)
        ph = np.empty((len(traj), len(self.channels))); at = np.empty_like(ph)
        for i in range(len(traj)):
            ph[i], at[i] = self._raw(depth, model.rh, aniso, zc[i], cos_rel[i])
        return self.apparent(ph, at)

    def simulate_homogeneous(self, rh, rv, cos_rel):
        p, a = self._raw([], [rh], [np.sqrt(rv / rh)], 0.0, cos_rel)
        rp, ra = self.apparent(p[None], a[None])
        return rp[0], ra[0]

    def channel_labels(self):
        return [c.name + "P" for c in self.channels] + [c.name + "A" for c in self.channels]
