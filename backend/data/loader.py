"""Read a delivered run. Nulls and ADR tool-clip values are set to NaN; nothing else is changed.

The ADR processing writes 2000 or 5000 ohm-m where a resistivity is out of the tool's range (AR curves and ZR image
bins alike), and the vendor-corrected ``C`` twins carry a transformed copy of those samples (2442.3, 9675.3,
14466.8 ohm-m, ...). They are not measurements, so every AR/ZR sample at or above ``CLIP_OHMM``, and every ``C``
sample whose uncorrected twin is clipped, is treated as missing. ``WellRun.clipped`` keeps the masks, so QC can tell
clipped samples from missing ones.
"""

from dataclasses import dataclass, field
from pathlib import Path
import re

from dlisio import dlis
import numpy as np
import pandas as pd


NULL_VALUE = -999.25
# The tool writes 2000 or 5000 ohm-m at its clip limit; real readings in these runs stay below ~1900 ohm-m.
CLIP_OHMM = 1999.0
CLIPPED_FAMILIES = ("AR", "ZR")
FREQUENCIES = {"H": 2_000_000, "M": 500_000, "L": 125_000}
MNEMONIC = re.compile(r"^(AR|ZR|ZG)([HML])(\d+)([PA])([CTBLR]?)$")


def measurement_metadata(name: str) -> dict:
    match = MNEMONIC.fullmatch(name)
    if not match:
        return {"family": "conventional"}
    family, frequency, spacing, kind, suffix = match.groups()
    return {
        "family": family,
        "frequency_hz": FREQUENCIES[frequency],
        "spacing_in": int(spacing),
        "measurement": {"P": "phase", "A": "attenuation"}[kind],
        "suffix": suffix,
        "geometry_status": "nominal mnemonic spacing; antenna mapping unconfirmed",
    }


@dataclass
class WellRun:
    path: Path
    well: str
    depth_m: np.ndarray
    curves: dict[str, np.ndarray]
    metadata: pd.DataFrame
    parameters: dict
    clipped: dict[str, np.ndarray] = field(default_factory=dict)   # curve -> True where the tool clipped

    def display_values(self, name: str) -> np.ndarray:
        """A curve for display: clipped samples read ``CLIP_OHMM`` (the most resistive colour) instead of missing."""
        values = self.curves[name]
        clip = self.clipped.get(name)
        return values if clip is None or not clip.any() else np.where(clip, CLIP_OHMM, values)

    def clipped_fraction(self, name: str, mask=None) -> float:
        """Fraction of the delivered (non-null) samples of a curve that were clip values, optionally within a
        depth mask; 0 for curves that cannot clip."""
        clip = self.clipped.get(name)
        if clip is None:
            return 0.0
        values = self.curves[name]
        if mask is not None:
            clip, values = clip[mask], values[mask]
        delivered = clip | np.isfinite(values)
        return float(clip.sum() / delivered.sum()) if delivered.any() else 0.0

    def tidy(self):
        """Yield one channel at a time; images retain their zero-based bin index."""
        for row in self.metadata.to_dict("records"):
            name = row["curve"]
            values = self.curves[name].reshape(len(self.depth_m), -1)
            bins = values.shape[1]
            yield pd.DataFrame({
                "well": self.well,
                "run": self.path.stem,
                "curve": name,
                "unit": row["unit"],
                "depth_ref": row["depth_ref"],
                "depth_m": np.repeat(self.depth_m, bins),
                "bin": np.tile(np.arange(bins), len(self.depth_m)) if bins > 1 else -1,
                "value": values.ravel(),
            })


def clip_mask(values) -> np.ndarray:
    """True where a resistivity sample is an ADR clip value (at or above ``CLIP_OHMM``)."""
    x = np.asarray(values, dtype=float)
    with np.errstate(invalid="ignore"):
        return np.isfinite(x) & (x >= CLIP_OHMM)


def mask_clipped(values) -> np.ndarray:
    """Copy of a resistivity array (curve or image) with clip values set to NaN."""
    x = np.array(values, dtype=float)
    x[clip_mask(x)] = np.nan
    return x


def _mask_clips(curves: dict) -> dict:
    """Set AR/ZR clip values, and C samples whose uncorrected twin is clipped, to NaN in place; return the masks."""
    masks = {}
    for name, samples in curves.items():
        meta = measurement_metadata(name)
        if meta["family"] in CLIPPED_FAMILIES:
            masks[name] = clip_mask(samples)
    for name in list(masks):
        twin = name[:-1] if name.endswith("C") else None
        if twin in masks and masks[twin].shape == masks[name].shape:
            masks[name] = masks[name] | (masks[twin] & np.isfinite(curves[name]))
    for name, mask in masks.items():
        curves[name][mask] = np.nan
    return masks


def load_run(path: str | Path) -> WellRun:
    path = Path(path)
    with dlis.load(str(path)) as files:
        if len(files) != 1 or len(files[0].frames) != 1:
            raise ValueError(f"{path}: expected one logical file and one frame")
        logical = files[0]
        frame = logical.frames[0]
        values = frame.curves()
        depth_channels = [c for c in frame.channels if c.name == "DEPT"]
        if len(depth_channels) != 1 or depth_channels[0].units != "ft":
            raise ValueError(f"{path}: expected DEPT in feet")
        md_ft = np.asarray(values["DEPT"], dtype=float)
        if (md_ft.ndim != 1 or len(md_ft) < 2 or
                not np.isfinite(md_ft).all() or np.any(md_ft == NULL_VALUE) or
                np.any(np.diff(md_ft) <= 0)):
            raise ValueError(f"{path}: depth must be finite and strictly increasing")
        well = logical.origins[0].well_name
        curves, units, descriptions = {}, {}, {}
        for channel in frame.channels:
            samples = np.asarray(values[channel.name], dtype=float).copy()
            samples[(samples == NULL_VALUE) | ~np.isfinite(samples)] = np.nan
            if samples.ndim not in (1, 2) or (samples.ndim == 2 and samples.shape[1] != 32):
                raise ValueError(f"{path}: unsupported shape for {channel.name}: {samples.shape}")
            curves[channel.name] = samples
            units[channel.name], descriptions[channel.name] = channel.units, str(channel.long_name)
        clipped = _mask_clips(curves)
        rows = []
        for name, samples in curves.items():
            clip = clipped.get(name)
            n_clip = int(clip.sum()) if clip is not None else 0
            rows.append({
                "well": well, "run": path.stem, "curve": name,
                "unit": units[name], "description": descriptions[name],
                "depth_ref": "MD_RKB", "null_value": NULL_VALUE,
                "sample_count": len(md_ft), "bins": 1 if samples.ndim == 1 else 32,
                "depth_min_m": float(md_ft[0] * 0.3048),
                "depth_max_m": float(md_ft[-1] * 0.3048),
                "valid_fraction": float(np.isfinite(samples).mean()),
                "nonpositive_count": int(np.sum(samples <= 0)),
                "clipped_count": n_clip,
                "clipped_fraction": float(n_clip / max(1, n_clip + np.isfinite(samples).sum())),
                **measurement_metadata(name),
            })
        parameters = {p.name: np.asarray(p.values).tolist() for p in logical.parameters}
    return WellRun(path, well, md_ft * 0.3048, curves, pd.DataFrame(rows), parameters, clipped)
