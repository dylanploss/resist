"""Per-curve depth-of-investigation and noise metrics for ADR channels."""

import numpy as np

BINS = 32
REFERENCE_FREQUENCY_HZ = 2_000_000
REFERENCE_SPACING_IN = 16
ATTENUATION_DEPTH_FACTOR = 1.5
PLAUSIBLE_OHMM = (0.01, 10_000.0)


def doi_index(spacing_in: float, frequency_hz: float, measurement: str) -> float:
    """Relative depth of investigation; 1.0 is the 16 in 2 MHz phase curve.

    Ordering heuristic from the ADR dossier (longer spacing, lower frequency and
    attenuation read deeper); it is not a reach in inches.
    """
    skin = np.sqrt(REFERENCE_FREQUENCY_HZ / frequency_hz)
    factor = ATTENUATION_DEPTH_FACTOR if measurement == "attenuation" else 1.0
    return float(spacing_in / REFERENCE_SPACING_IN * skin * factor)


def _mad(x: np.ndarray) -> float:
    x = x[np.isfinite(x)]
    if x.size == 0:
        return np.nan
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def jaggedness(series) -> float:
    """Roughness on a fixed scale: smooth logs < 0.5, white noise 1, alternating static > 1.

    Robust ratio var(2nd difference) / (3 var(1st difference)); white noise gives
    6σ² / (3 · 2σ²) = 1, so it is independent of units and signal level.
    """
    x = np.asarray(series, dtype=float)
    s1, s2 = _mad(np.diff(x)), _mad(np.diff(x, 2))
    if not np.isfinite(s1) or not np.isfinite(s2) or s1 == 0:
        return np.nan
    return float((s2 / s1) ** 2 / 3)


def spike_fraction(series, threshold: float = 10.0) -> float:
    """Fraction of samples that jump away from two neighbours that agree with each other.

    The agreement test keeps bed-boundary steps from counting as spikes.
    """
    x = np.asarray(series, dtype=float)
    if x.size < 3:
        return np.nan
    residual = x[1:-1] - (x[:-2] + x[2:]) / 2
    neighbour_gap = np.abs(x[:-2] - x[2:])
    scale = _mad(residual)
    finite = np.isfinite(residual)
    if not finite.any() or not np.isfinite(scale) or scale == 0:
        return 0.0
    spike = (np.abs(residual) > threshold * scale) & (neighbour_gap < 0.5 * np.abs(residual))
    return float(np.mean(spike[finite]))


def log_positive(values) -> np.ndarray:
    x = np.asarray(values, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(x > 0, np.log10(x), np.nan)


def mask_saturation(values, min_repeats: int = 3) -> tuple[np.ndarray, float]:
    """Set samples stuck at the curve's max or min (tool clip limits) to NaN.

    Returns the masked copy and the fraction of valid samples that were clipped.
    """
    x = np.asarray(values, dtype=float).copy()
    finite = np.isfinite(x)
    if not finite.any():
        return x, np.nan
    clipped = np.zeros_like(finite)
    for limit in (np.nanmax(x), np.nanmin(x)):
        at_limit = x == limit
        if at_limit.sum() >= max(min_repeats, 0.001 * finite.sum()):
            clipped |= at_limit
    x[clipped] = np.nan
    return x, float(clipped.sum() / finite.sum())


def range_ok(values, low: float = PLAUSIBLE_OHMM[0], high: float = PLAUSIBLE_OHMM[1],
             min_fraction: float = 0.95) -> bool:
    x = np.asarray(values, dtype=float)
    x = x[np.isfinite(x)]
    return bool(x.size and np.mean((x >= low) & (x <= high)) >= min_fraction)


def harmonics(image) -> dict:
    """Per-depth bin mean and first-harmonic amplitude, plus image-wide harmonic purity.

    ADR bins should follow a constant plus one sinusoid in tool-face angle, so purity is
    first-harmonic power over all non-constant power. Random bins give about 2/31.
    Purity uses amplitudes only, so the unconfirmed bin zero and rotation do not matter.
    """
    x = np.asarray(image, dtype=float)
    if x.ndim != 2 or x.shape[1] != BINS:
        raise ValueError(f"expected an image with {BINS} bins, got shape {x.shape}")
    mean = np.full(len(x), np.nan)
    amplitude = np.full(len(x), np.nan)
    ok = np.isfinite(x).all(axis=1)
    purity = np.nan
    if ok.any():
        spectrum = np.fft.rfft(x[ok], axis=1) / BINS
        power = np.abs(spectrum) ** 2
        power[:, 1:-1] *= 2
        mean[ok] = spectrum[:, 0].real
        amplitude[ok] = 2 * np.abs(spectrum[:, 1])
        varying = power[:, 1:].sum()
        if varying > 0:
            purity = float(power[:, 1].sum() / varying)
    return {"mean": mean, "amplitude": amplitude, "purity": purity}


def antisymmetry(image) -> float:
    """0 when every bin is the negative of the bin 180° away, as a geosignal should be."""
    x = np.asarray(image, dtype=float)
    half = BINS // 2
    mirror = np.abs(x[:, :half] + x[:, half:])
    scale = np.nanmedian(np.abs(x)) if np.isfinite(x).any() else np.nan
    if not np.isfinite(scale) or scale == 0:
        return np.nan
    return float(np.nanmedian(mirror) / scale)
