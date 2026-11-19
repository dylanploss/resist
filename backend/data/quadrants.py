"""Top, right, bottom and left quadrant curves from 32-bin ADR azimuthal images.

Bin 0 is the top (high side) bin; the delivered quadrant curves place right at bin 8, bottom at bin 16 and left at
bin 24. Whether bin 8 is physically to the right looking downhole is not confirmed by the vendor. A quadrant is the
90-degree sector ``[centre-4, centre+3]``; resistivities are averaged as conductivity. On Z-19 and Z-20 this reproduces
every delivered ``ZR..T/R/B/L`` curve to a median 0.8-1.1 %, better than any single bin (1.4-1.7 %) or a sector
symmetric about the centre bin (1.3-1.5 %), so bin k spans [k, k+1) x 11.25 deg and each quadrant is an exact
90-degree sector centred on 0, 90, 180 or 270 deg. The four sectors tile the 32 bins.
"""

from __future__ import annotations

import numpy as np

BINS = 32
SIDES = ("T", "R", "B", "L")
CENTRE = {"T": 0, "R": 8, "B": 16, "L": 24}
SECTOR = tuple(range(-4, 4))


def sector_bins(side: str) -> list[int]:
    return [(CENTRE[side] + j) % BINS for j in SECTOR]


def quadrant(image, side: str, resistivity: bool = True, method: str = "sector") -> np.ndarray:
    """One quadrant curve (n_depth,) from an image (n_depth, 32).

    ``method="bin"`` takes the centre bin only. Missing or non-positive bins are skipped in the sector average.
    """
    img = np.asarray(image, float)
    if img.ndim != 2 or img.shape[1] != BINS:
        raise ValueError(f"expected an image with {BINS} bins, got shape {img.shape}")
    if side not in CENTRE:
        raise ValueError(f"unknown quadrant {side!r}; use one of {SIDES}")
    if method == "bin":
        return img[:, CENTRE[side]].copy()
    if method != "sector":
        raise ValueError(f"unknown method {method!r}")
    x = img[:, sector_bins(side)]
    with np.errstate(divide="ignore", invalid="ignore"):
        if resistivity:
            return 1.0 / np.nanmean(np.where(x > 0, 1.0 / x, np.nan), axis=1)
        return np.nanmean(x, axis=1)


def quadrant_curves(run, method: str = "sector") -> dict[str, np.ndarray]:
    """``{image + side: curve}`` for every 32-bin ZR (resistivity) and ZG (geosignal) image in a WellRun."""
    out = {}
    for name, values in run.curves.items():
        if np.ndim(values) == 2 and np.shape(values)[1] == BINS and name[:2] in ("ZR", "ZG"):
            for side in SIDES:
                out[name + side] = quadrant(values, side, resistivity=name.startswith("ZR"), method=method)
    return out
