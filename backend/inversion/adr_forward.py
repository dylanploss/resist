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

from backend.data.quadrants import BINS, CENTRE, SECTOR

FT = 0.3048
INCH = 0.0254
HTARG = {"dlf": "key_201_2012"}


def _bipole(src, rec, **kw):
    """``empymod.bipole`` for magnetic dipoles as ``(n_freq, n_rec, n_src)``.

    empymod 2.5 returns NaN when the source lies in a deeper layer than the receiver, which happens whenever the tool
    straddles a bed. Those pairs are recomputed with source and receiver swapped (magnetic-dipole reciprocity).
    """
    nf, nr, ns = len(np.atleast_1d(kw["freqtime"])), len(rec[0]), len(src[0])
    v = np.asarray(empymod.bipole(src, rec, msrc=True, mrec=True, **kw)).reshape(nf, nr, ns)
    bad = np.isnan(v)
    if bad.any():
        w = np.asarray(empymod.bipole(rec, src, msrc=True, mrec=True, **kw)).reshape(nf, ns, nr).transpose(0, 2, 1)
        v = np.where(bad, w, v)
    return v


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
# ADR antenna layout (inches along the tool axis from the R1/R2 midpoint, positive downhole):
# * transmitters T1..T6 at +/-16, +/-32, +/-48; T2, T4, T6 are the uphole ones at -16, -32, -48;
# * R1/R2 at +/- receiver_sep/2 (R1 = +4 in for the default 8 in), compensated pair for the 16/32/48 in channels;
# * R3, a tilted receiver at +64 in. Geosignals: every transmitter fires into R3 alone, spacing s = 64 - T, so
#   s = 16, 32, 48, 80, 96, 112 in. Long spacing: T2/T4/T6 fire into R1 (near) and R3 (far), uncompensated; the
#   spacing is the distance to the R1-R3 midpoint (+34 in), so 50/66/82 in. That pairing is inferred, not published.
R3_IN = 64.0
DEFAULT_GEOSIGNALS = tuple(Channel(f"ZG{FREQ_LETTER[f]}{s}", f, s) for f, spacings in (
    (2e6, (16, 32, 48)), (5e5, (16, 32, 48, 80, 96, 112)), (1.25e5, (48, 80, 96, 112))) for s in spacings)
DEFAULT_LONG_SPACINGS = tuple(Channel(f"ZR{FREQ_LETTER[f]}{s}", f, s)
                              for f in (5e5, 1.25e5) for s in (50, 66, 82))


@dataclass
class ADRForward:
    """Averaged (``AR``) and, with ``azimuthal=True``, directional channels:

    * ``ZR<f><s>{P,A}{T,B}``: compensated top/bottom-bin apparent resistivities of the tilted receiver pair.
    * ``ZR{M,L}{50,66,82}{P,A}{T,B}``: long-spacing quadrants, T2/T4/T6 into R1 (near) and R3 (far), uncompensated
      (see ``R3_IN``; the pairing is inferred), so tool/borehole effects are not cancelled; check their misfit.
    * ``ZG<f><s>{P,A}T``: top-bin geosignal of one transmitter into R3 alone (``s = 64 - T``): each bin minus the
      average of all 32 bins, as phase (deg) and attenuation (dB). Signs follow the delivered data: on Z-19 and Z-20
      the top geosignal rises when the bottom bin reads more resistive (r = +0.52 to +0.66).

    Directional assumptions (not vendor-confirmed): receivers tilted ``tilt_deg`` from the axis; the
    compensated bin at look direction psi pairs the uphole transmitter at psi with the downhole transmitter at
    psi + 180 deg (mirror-symmetric pairing, which keeps the up/down sensitivity); bins are labelled by look direction,
    so the receiver tilt sense (``polarity``) is fixed such that the bottom bin reads a resistive bed below.

    Quadrants match ``backend.data.quadrants``: ``quadrant="sector"`` averages the eight bins of a 90-degree sector
    (conductivity mean for ZR, plain mean for ZG); ``quadrant="bin"`` uses the centre bin only. Bin 8 (``R``) looks
    toward ``rotation * (axis x high-side)``; the sense (``rotation``) is not vendor-confirmed.
    """

    channels: tuple = DEFAULT_CHANNELS
    receiver_sep_in: float = 8.0
    azimuthal: bool = False
    geosignals: tuple = DEFAULT_GEOSIGNALS
    long_spacings: tuple = DEFAULT_LONG_SPACINGS
    ls_receiver_in: float = R3_IN       # R3 position, downhole of the R1/R2 midpoint
    tilt_deg: float = 45.0
    polarity: int | None = None
    quadrant: str = "sector"
    zr_sides: tuple = ("T", "B")
    zg_sides: tuple = ("T",)
    rotation: int = 1
    rho_grid: np.ndarray = field(default_factory=lambda: np.logspace(-1, 3.3, 260))

    def __post_init__(self):
        geo_f = {g.frequency_hz for g in self.geosignals} if self.azimuthal else set()
        self.freqs = np.array(sorted({c.frequency_hz for c in self.channels} | geo_f))
        self.spacings = np.array(sorted({c.spacing_in for c in self.channels}))
        half = 0.5 * self.receiver_sep_in * INCH
        self.rx_offsets = np.array([-half, half])
        self.tx_offsets = np.concatenate([-self.spacings, self.spacings]) * INCH
        self._tables = None
        self._ls_tables = None

    # ------------------------------------------------------------------ labels
    def ar_labels(self):
        return [c.name + "P" for c in self.channels] + [c.name + "A" for c in self.channels]

    def channel_labels(self):
        labels = self.ar_labels()
        if self.azimuthal:
            for m in "PA":
                for c in self.channels:
                    labels += [f"ZR{c.name[2:]}{m}{side}" for side in self.zr_sides]
            for m in "PA":
                for c in self.long_spacings:
                    labels += [f"{c.name}{m}{side}" for side in self.zr_sides]
            for g in self.geosignals:
                labels += [g.name + m + side for side in self.zg_sides for m in "PA"]
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

        h = _bipole(pts(self.tx_offsets), pts(self.rx_offsets), depth=list(depth), res=list(res),
                    freqtime=self.freqs, aniso=list(aniso), verb=0, htarg=HTARG)
        h = np.conj(h)  # e^{-iwt}
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
        """Phase/attenuation of the averaged receiver ``(n_chan,)``, of all 32 compensated bins ``(32, n_chan)`` and of
        all 32 uncompensated long-spacing bins ``(32, n_long)``, plus geosignals ``(32, n_geo, 2)`` at one station.

        ``t_f`` and ``h_f`` are the tool axis and high-side directions in the formation frame (x along the bedding,
        z = bed normal, down). The receivers are evaluated along the tool axis, high side and right side; any bin
        direction is a linear combination of those, so all 32 bins cost one empymod call."""
        c, s = np.cos(np.deg2rad(self.tilt_deg)), np.sin(np.deg2rad(self.tilt_deg))
        r_f = self.rotation * np.cross(t_f, h_f)
        axes = (t_f, h_f, r_f)
        rx_off = list(self.rx_offsets)
        r3 = None
        if self.geosignals or self.long_spacings:
            r3 = len(rx_off); rx_off.append(self.ls_receiver_in * INCH)
        gs_rx = ls_rx = r3
        ns = len(self.spacings)
        extra = []
        base = 2 * ns

        def tx_index(offset_in):
            hit = np.flatnonzero(np.isclose(self.tx_offsets, offset_in * INCH))
            if hit.size:
                return int(hit[0])
            extra.append(offset_in * INCH)
            return base + len(extra) - 1

        # Long spacing: spacing is to the R1-R3 midpoint; geosignal: spacing is to R3.
        ls_mid = 0.5 * (self.rx_offsets[1] / INCH + self.ls_receiver_in)
        ls_tx = [tx_index(ls_mid - ch.spacing_in) for ch in self.long_spacings]
        gs_tx = [tx_index(self.ls_receiver_in - g.spacing_in) for g in self.geosignals]
        tx_off = np.concatenate([self.tx_offsets, extra])

        def points(offsets, dirs):
            offsets = np.asarray(offsets, float)
            pos = offsets[:, None] * t_f[None, :] + np.array([0.0, 0.0, zc])
            az, dip = self._angles(np.asarray(dirs))
            return [pos[:, 0], pos[:, 1], pos[:, 2], az, dip]

        rx = [(o, d) for o in rx_off for d in axes]
        v = _bipole(points(tx_off, [t_f] * len(tx_off)), points([o for o, _ in rx], [d for _, d in rx]),
                    depth=list(depth), res=list(res), freqtime=self.freqs, aniso=list(aniso), verb=0, htarg=HTARG)
        v = np.conj(v.reshape(len(self.freqs), len(rx_off), 3, len(tx_off)))
        # Bin k spans [k, k+1) x 11.25 deg, so a sector is centred on its quadrant; "bin" mode looks exactly at 0/180 deg.
        psi = 2 * np.pi * (np.arange(BINS) + (0.0 if self.quadrant == "bin" else 0.5)) / BINS
        # (32, 3) weights on the (axis, high, right) receiver components for every bin's look direction
        wts = np.column_stack([np.full(BINS, c), s * polarity * np.cos(psi), s * polarity * np.sin(psi)])
        vb = np.einsum("bk,frkt->frbt", wts, v)        # (freq, rx, bin, tx)
        opp = (np.arange(BINS) + BINS // 2) % BINS

        def comp(up, dn):
            return (-0.5 * (np.angle(up, deg=True) + np.angle(dn, deg=True)),
                    10 * (np.log10(abs(up)) + np.log10(abs(dn))))

        avg_p, avg_a, bin_p, bin_a = [], [], [], []
        for ch in self.channels:
            fi = int(np.searchsorted(self.freqs, ch.frequency_hz))
            si = int(np.searchsorted(self.spacings, ch.spacing_in))
            up_t, dn_t = si, ns + si
            # Mirror pairing: uphole transmitter at the bin's look direction, downhole transmitter at the opposite one.
            p, a = comp(vb[fi, 0, :, up_t] / vb[fi, 1, :, up_t], vb[fi, 1, opp, dn_t] / vb[fi, 0, opp, dn_t])
            bin_p.append(p); bin_a.append(a)
            va = c * v[fi, :, 0, :]                      # azimuthal mean of the tilted receiver
            p, a = comp(va[0, up_t] / va[1, up_t], va[1, dn_t] / va[0, dn_t])
            avg_p.append(p); avg_a.append(a)
        ls_p, ls_a = [], []
        for ch, tj in zip(self.long_spacings, ls_tx):
            fi = int(np.searchsorted(self.freqs, ch.frequency_hz))
            ratio = vb[fi, 1, :, tj] / vb[fi, ls_rx, :, tj]            # near main Rx / LS Rx, same look direction
            ls_p.append(-np.angle(ratio, deg=True)); ls_a.append(20 * np.log10(abs(ratio)))
        gs = np.empty((BINS, len(self.geosignals), 2))
        for j, (g, tj) in enumerate(zip(self.geosignals, gs_tx)):
            fi = int(np.searchsorted(self.freqs, g.frequency_hz))
            vg = vb[fi, gs_rx, :, tj]
            phase = np.angle(vg / vg[0], deg=True)       # relative to bin 0, so no wrap across bins
            gs[:, j, 0] = phase - phase.mean()
            att = -20 * np.log10(abs(vg))
            gs[:, j, 1] = att - att.mean()
        empty = np.empty((BINS, 0))
        ls = (np.array(ls_p).T, np.array(ls_a).T) if ls_p else (empty, empty)
        return (np.array(avg_p), np.array(avg_a)), (np.array(bin_p).T, np.array(bin_a).T), ls, gs

    def _polarity(self):
        """Tilt sense such that the bottom bin of a horizontal tool reads higher above a resistive bed."""
        if self.polarity is None:
            t_f, h_f = np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0])
            _, (bp, _), _, _ = self._raw_azimuthal([0.3], [5.0, 50.0], [1.0, 1.0], 0.0, t_f, h_f, 1)
            self.polarity = 1 if bp[CENTRE["B"], 0] < bp[CENTRE["T"], 0] else -1   # lower phase lag = more resistive
        return self.polarity

    def _side_bins(self, side):
        return [CENTRE[side]] if self.quadrant == "bin" else [(CENTRE[side] + j) % BINS for j in SECTOR]

    # ------------------------------------------------------------------ transforms
    def tables(self):
        if self._tables is None:
            ph, at = [], []
            for r in self.rho_grid:
                p, a = self._raw([], [r], [1.0], 0.0, 1.0)
                ph.append(p); at.append(a)
            self._tables = (np.array(ph), np.array(at))   # (n_rho, n_chan), both decrease with rho
        return self._tables

    def apparent(self, phase, atten, tables=None):
        """Phase/attenuation arrays (..., n_chan) to (Rp, Ra) in ohm-m via the whole-space transform."""
        ph_t, at_t = tables if tables is not None else self.tables()
        lr = np.log10(self.rho_grid)
        rp = np.empty_like(phase); ra = np.empty_like(atten)
        for k in range(phase.shape[-1]):
            p = np.maximum.accumulate(ph_t[::-1, k])[::-1]   # enforce monotonic (decreasing with rho)
            rp[..., k] = 10 ** np.interp(-phase[..., k], -p, lr)
            a = np.minimum.accumulate(at_t[:, k])
            ra[..., k] = 10 ** np.interp(-atten[..., k], -a, lr)
        return rp, ra

    def ls_tables(self):
        """Whole-space transform tables for the uncompensated R1/R3 long-spacing pairs."""
        if self._ls_tables is None:
            t_f, h_f = np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0])
            ph, at = [], []
            for r in self.rho_grid:
                _, _, (lp, la), _ = self._raw_azimuthal([], [r], [1.0], 0.0, t_f, h_f, 1)
                ph.append(lp[0]); at.append(la[0])               # homogeneous: every bin reads the same
            self._ls_tables = (np.array(ph), np.array(at))
        return self._ls_tables

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
        nc, nl = len(self.channels), len(self.long_spacings)
        n_st = len(traj)
        avg_p, avg_a = np.empty((n_st, nc)), np.empty((n_st, nc))
        bin_p, bin_a = np.empty((n_st, BINS, nc)), np.empty((n_st, BINS, nc))
        ls_p, ls_a = np.empty((n_st, BINS, nl)), np.empty((n_st, BINS, nl))
        gs = np.empty((n_st, BINS, len(self.geosignals), 2))
        for i in range(n_st):
            t, h = traj.axis[i] / np.linalg.norm(traj.axis[i]), traj.high[i] / np.linalg.norm(traj.high[i])
            x = t - (t @ n) * n
            if np.linalg.norm(x) < 1e-9:
                x = h - (h @ n) * n
            x /= np.linalg.norm(x)
            y = np.cross(n, x)
            basis = np.vstack([x, y, n])
            (avg_p[i], avg_a[i]), (bin_p[i], bin_a[i]), (ls_p[i], ls_a[i]), gs[i] = self._raw_azimuthal(
                depth, model.rh, aniso, traj.ned[i] @ n, basis @ t, basis @ h, pol)
        rp, ra = self.apparent(avg_p, avg_a)
        cols = [np.log10(rp), np.log10(ra)]
        groups = [(self.apparent(bin_p, bin_a), nc)]                   # each (n, 32, n_chan) ohm-m
        if nl:
            groups.append((self.apparent(ls_p, ls_a, self.ls_tables()), nl))
        for bins, count in groups:
            for m in (0, 1):
                # Conductivity mean over the sector, as for delivered images; one bin when quadrant == "bin"
                sides = [1.0 / np.mean(1.0 / bins[m][:, self._side_bins(sd)], axis=1) for sd in self.zr_sides]
                cols.append(np.log10(np.stack(sides, axis=2).reshape(n_st, count * len(self.zr_sides))))
        for j in range(len(self.geosignals)):
            for sd in self.zg_sides:
                cols.append(gs[:, self._side_bins(sd), j, :].mean(axis=1))
        return np.column_stack(cols)
