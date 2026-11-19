"""Read a delivered run without modifying its source measurements."""

from dataclasses import dataclass
from pathlib import Path
import re

from dlisio import dlis
import numpy as np
import pandas as pd


NULL_VALUE = -999.25
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
        curves, rows = {}, []
        for channel in frame.channels:
            samples = np.asarray(values[channel.name], dtype=float).copy()
            samples[(samples == NULL_VALUE) | ~np.isfinite(samples)] = np.nan
            if samples.ndim not in (1, 2) or (samples.ndim == 2 and samples.shape[1] != 32):
                raise ValueError(f"{path}: unsupported shape for {channel.name}: {samples.shape}")
            curves[channel.name] = samples
            rows.append({
                "well": well, "run": path.stem, "curve": channel.name,
                "unit": channel.units, "description": str(channel.long_name),
                "depth_ref": "MD_RKB", "null_value": NULL_VALUE,
                "sample_count": len(md_ft), "bins": 1 if samples.ndim == 1 else 32,
                "depth_min_m": float(md_ft[0] * 0.3048),
                "depth_max_m": float(md_ft[-1] * 0.3048),
                "valid_fraction": float(np.isfinite(samples).mean()),
                "nonpositive_count": int(np.sum(samples <= 0)),
                **measurement_metadata(channel.name),
            })
        parameters = {p.name: np.asarray(p.values).tolist() for p in logical.parameters}
    return WellRun(path, well, md_ft * 0.3048, curves, pd.DataFrame(rows), parameters)
