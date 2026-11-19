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
    high: np.ndarray | None = None   # (n, 3) unit high-side direction (tool-face 0)

    @classmethod
    def from_curves(cls, md_ft, tvd_ft, inc_deg, azi_deg, utm_e, utm_n, ref=None):
        ned = np.column_stack([utm_n, utm_e, np.asarray(tvd_ft) * FT])
        ref = ned.mean(axis=0) if ref is None else np.asarray(ref)
        inc, azi = np.deg2rad(inc_deg), np.deg2rad(azi_deg)
        axis = np.column_stack([np.sin(inc) * np.cos(azi), np.sin(inc) * np.sin(azi), np.cos(inc)])
        high = np.column_stack([np.cos(inc) * np.cos(azi), np.cos(inc) * np.sin(azi), -np.sin(inc)])
        return cls(np.asarray(md_ft, float), ned - ref, axis, high)

    def subset(self, mask):
        return Trajectory(self.md_ft[mask], self.ned[mask], self.axis[mask],
                          None if self.high is None else self.high[mask])

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


FREQ_LETTER = {2e6: "H", 5e5: "M", 1.25e5: "L"}
DEFAULT_GEOSIGNALS = (Channel("ZGM112", 5e5, 112), Channel("ZGL112", 1.25e5, 112))


@dataclass
class ADRForward:
    """Averaged (``AR``) and, with ``azimuthal=True``, directional channels:

    * ``ZR<f><s>{P,A}{T,B}``: compensated top/bottom-bin apparent resistivities of the tilted receiver pair.
    * ``ZG<f>112{P,A}T``: top-bin geosignal for one transmitter 112 in uphole of a tilted receiver at the tool
      midpoint: phase(top) - phase(bottom) in deg and 20 log10|V_bottom / V_top| in dB. These signs match the
      delivered data: on Z-19 and Z-20 both rise when the bottom bin reads more resistive (r = +0.52 to +0.66).

    Directional assumptions (not vendor-confirmed): receivers tilted ``tilt_deg`` from the axis; the
    compensated top bin pairs the uphole transmitter at tool-face 0 with the downhole transmitter at tool-face
    180 deg (mirror-symmetric pairing, which keeps the up/down sensitivity); bins are labelled by look direction,
    so the receiver tilt sense (``polarity``) is fixed such that the bottom bin reads a resistive bed below.
    """

    channels: tuple = DEFAULT_CHANNELS
    receiver_sep_in: float = 8.0
    azimuthal: bool = False
    geosignals: tuple = DEFAULT_GEOSIGNALS
    tilt_deg: float = 45.0
    polarity: int | None = None
    rho_grid: np.ndarray = field(default_factory=lambda: np.logspace(-1, 3.3, 260))

    def __post_init__(self):
        geo_f = {g.frequency_hz for g in self.geosignals} if self.azimuthal else set()
        self.freqs = np.array(sorted({c.frequency_hz for c in self.channels} | geo_f))
        self.spacings = np.array(sorted({c.spacing_in for c in self.channels}))
        half = 0.5 * self.receiver_sep_in * INCH
        self.rx_offsets = np.array([-half, half])
        self.tx_offsets = np.concatenate([-self.spacings, self.spacings]) * INCH
        self._tables = None

    # ------------------------------------------------------------------ labels
    def ar_labels(self):
        return [c.name + "P" for c in self.channels] + [c.name + "A" for c in self.channels]

    def channel_labels(self):
        labels = self.ar_labels()
        if self.azimuthal:
            for m in "PA":
                for c in self.channels:
                    labels += [f"ZR{c.name[2:]}{m}T", f"ZR{c.name[2:]}{m}B"]
            for g in self.geosignals:
                labels += [g.name + "PT", g.name + "AT"]
        return labels

    def units(self):
        """'log' for resistivities (inverted as log10 ohm-m), 'deg'/'dB' for geosignals (inverted as is)."""
        return ["deg" if lab.startswith("ZG") and lab[-2] == "P" else "dB" if lab.startswith("ZG") else "log"
                for lab in self.channel_labels()]

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

    @staticmethod
    def _angles(v):
        return np.rad2deg(np.arctan2(v[..., 1], v[..., 0])), np.rad2deg(np.arcsin(np.clip(v[..., 2], -1, 1)))

    def _raw_azimuthal(self, depth, res, aniso, zc, t_f, h_f, polarity):
        """Phase/attenuation for averaged, top and bottom bins (n_chan each) plus top geosignals at one station.

        ``t_f`` and ``h_f`` are the tool axis and high-side directions in the formation frame (x along the bedding,
        z = bed normal, down)."""
        c, s = np.cos(np.deg2rad(self.tilt_deg)), np.sin(np.deg2rad(self.tilt_deg))
        look = {"T": polarity * h_f, "B": -polarity * h_f}
        rx_off = list(self.rx_offsets) + ([0.0] if self.geosignals else [])
        rx = [(o, k) for o in rx_off for k in "TB"]
        tx_off = np.concatenate([self.tx_offsets, [-g.spacing_in * INCH for g in self.geosignals]])

        def points(offsets, dirs):
            offsets = np.asarray(offsets, float)
            pos = offsets[:, None] * t_f[None, :] + np.array([0.0, 0.0, zc])
            az, dip = self._angles(np.asarray(dirs))
            return [pos[:, 0], pos[:, 1], pos[:, 2], az, dip]

        rdirs = [c * t_f + s * look[k] for _, k in rx]
        v = empymod.bipole(points(tx_off, [t_f] * len(tx_off)), points([o for o, _ in rx], rdirs),
                           depth=list(depth), res=list(res), freqtime=self.freqs, aniso=list(aniso),
                           msrc=True, mrec=True, verb=0, htarg=HTARG)
        v = np.conj(np.asarray(v).reshape(len(self.freqs), len(rx), len(tx_off)))
        R = {(i, k): 2 * i + (0 if k == "T" else 1) for i in range(len(rx_off)) for k in "TB"}
        ns = len(self.spacings)
        out = {k: ([], []) for k in ("avg", "T", "B")}

        def comp(up, dn):
            return (-0.5 * (np.angle(up, deg=True) + np.angle(dn, deg=True)),
                    10 * (np.log10(abs(up)) + np.log10(abs(dn))))

        for ch in self.channels:
            fi = int(np.searchsorted(self.freqs, ch.frequency_hz))
            si = int(np.searchsorted(self.spacings, ch.spacing_in))
            up_t, dn_t = si, ns + si
            V = lambda r, k, t: v[fi, R[(r, k)], t]
            avg = lambda r, t: 0.5 * (V(r, "T", t) + V(r, "B", t))
            for key, (ku, kd) in {"T": ("T", "B"), "B": ("B", "T")}.items():
                p, a = comp(V(0, ku, up_t) / V(1, ku, up_t), V(1, kd, dn_t) / V(0, kd, dn_t))
                out[key][0].append(p); out[key][1].append(a)
            p, a = comp(avg(0, up_t) / avg(1, up_t), avg(1, dn_t) / avg(0, dn_t))
            out["avg"][0].append(p); out["avg"][1].append(a)
        gs = []
        for j, g in enumerate(self.geosignals):
            fi = int(np.searchsorted(self.freqs, g.frequency_hz))
            tj = 2 * ns + j
            vt, vb = v[fi, R[(2, "T")], tj], v[fi, R[(2, "B")], tj]
            gs += [np.angle(vt / vb, deg=True), 20 * np.log10(abs(vb / vt))]
        return {k: (np.array(p), np.array(a)) for k, (p, a) in out.items()}, np.array(gs)

    def _polarity(self):
        """Tilt sense such that the bottom bin of a horizontal tool reads higher above a resistive bed."""
        if self.polarity is None:
            t_f, h_f = np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0])
            out, _ = self._raw_azimuthal([0.3], [5.0, 50.0], [1.0, 1.0], 0.0, t_f, h_f, 1)
            self.polarity = 1 if out["B"][0][0] < out["T"][0][0] else -1   # lower phase lag = more resistive
        return self.polarity

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

    def predict(self, model: LayerModel, traj: Trajectory):
        """All ``channel_labels()`` at every station, in inversion units (log10 ohm-m, deg, dB)."""
        if not self.azimuthal:
            rp, ra = self.simulate(model, traj)
            return np.log10(np.column_stack([rp, ra]))
        if traj.high is None:
            raise ValueError("azimuthal channels need the trajectory high-side direction")
        pol = self._polarity()
        n = model.normal()
        depth = np.column_stack([np.zeros_like(model.boundaries_m), np.zeros_like(model.boundaries_m),
                                 model.boundaries_m]) @ n
        aniso = np.sqrt(model.rv / model.rh)
        nc = len(self.channels)
        ph = {k: np.empty((len(traj), nc)) for k in ("avg", "T", "B")}
        at = {k: np.empty((len(traj), nc)) for k in ("avg", "T", "B")}
        gs = np.empty((len(traj), 2 * len(self.geosignals)))
        for i in range(len(traj)):
            t, h = traj.axis[i], traj.high[i]
            x = t - (t @ n) * n
            if np.linalg.norm(x) < 1e-9:
                x = h - (h @ n) * n
            x /= np.linalg.norm(x)
            y = np.cross(n, x)
            basis = np.vstack([x, y, n])
            out, gs[i] = self._raw_azimuthal(depth, model.rh, aniso, traj.ned[i] @ n, basis @ t, basis @ h, pol)
            for k in ph:
                ph[k][i], at[k][i] = out[k]
        res = {k: self.apparent(ph[k], at[k]) for k in ph}
        cols = [np.log10(res["avg"][0]), np.log10(res["avg"][1])]
        for m in (0, 1):
            zr = np.empty((len(traj), 2 * nc))
            zr[:, 0::2], zr[:, 1::2] = res["T"][m], res["B"][m]
            cols.append(np.log10(zr))
        cols.append(gs)
        return np.column_stack(cols)
