"""
Harmonic fitting module: Extract mean, amplitude, and phase from 32-bin azimuthal images.

For each depth and each data channel (phase or attenuation), fit a first-harmonic sinusoid
to the 32-bin azimuthal samples and extract the mean, first-harmonic amplitude, and phase.
This reduces 32 DOF to 3 per channel, aligning with the tool's 45° tilted receiver geometry.
"""

import numpy as np
from typing import NamedTuple, Dict, Tuple


class HarmonicFeatures(NamedTuple):
    """Extracted features from 32-bin harmonic fit."""
    mean: float          # a₀
    amplitude: float     # √(a₁² + b₁²)
    phase_deg: float     # atan2(b₁, a₁) in degrees
    residual_rms: float  # RMS of harmonics 2+


def fit_harmonic(bins_32: np.ndarray, azimuths_deg: np.ndarray = None) -> HarmonicFeatures:
    """
    Fit first-harmonic sinusoid to 32-bin azimuthal data.

    Parameters
    ----------
    bins_32 : np.ndarray
        Array of 32 bin values (one per 11.25° azimuth segment).
        Bin ordering: bin 1 at 0°, bin 17 at 180° (up/down).
    azimuths_deg : np.ndarray, optional
        Azimuth angles in degrees for each bin (default: 0°, 11.25°, ..., 348.75°).

    Returns
    -------
    HarmonicFeatures
        Named tuple with mean, amplitude, phase_deg, and residual_rms.

    Notes
    -----
    Assumes 32 bins evenly spaced over 360°, with potential bin-zero offset.
    Null values (-999.25) are treated as NaN and excluded from the fit.
    """
    if azimuths_deg is None:
        azimuths_deg = np.arange(32) * 11.25

    # Convert to radians
    psi = np.deg2rad(azimuths_deg)

    # Replace null sentinel with NaN
    data = np.asarray(bins_32, dtype=float)
    data[data == -999.25] = np.nan

    # Fit a₀ + a₁·cos(ψ) + b₁·sin(ψ)
    valid = ~np.isnan(data)
    if np.sum(valid) < 3:
        # Not enough data to fit
        return HarmonicFeatures(
            mean=np.nan,
            amplitude=np.nan,
            phase_deg=np.nan,
            residual_rms=np.nan
        )

    # Design matrix for first harmonic
    A = np.column_stack([
        np.ones(len(psi)),       # constant (a₀)
        np.cos(psi),             # a₁
        np.sin(psi)              # b₁
    ])

    # Least-squares fit
    coeffs, residuals, rank, s = np.linalg.lstsq(A[valid], data[valid], rcond=None)
    a0, a1, b1 = coeffs

    # Extract amplitude and phase
    amplitude = np.sqrt(a1**2 + b1**2)
    phase_rad = np.arctan2(b1, a1)
    phase_deg = np.rad2deg(phase_rad)

    # Compute residual (harmonics 2+)
    # Fit all harmonics and extract 2+
    A_full = np.column_stack([np.cos(k * psi) if k % 2 == 0 else np.sin(k * psi)
                               for k in range(1, 17)])  # harmonics 1-16
    coeffs_full, _, _, _ = np.linalg.lstsq(A_full[valid], data[valid], rcond=None)
    fitted_full = A_full @ coeffs_full
    residual_full = data[valid] - fitted_full
    residual_rms = np.sqrt(np.mean(residual_full**2))

    return HarmonicFeatures(
        mean=float(a0),
        amplitude=float(amplitude),
        phase_deg=float(phase_deg),
        residual_rms=float(residual_rms)
    )


def extract_harmonic_features_per_depth(
    phase_bins: Dict[int, np.ndarray],
    atten_bins: Dict[int, np.ndarray],
    spacings: list,
    frequencies: list
) -> Dict[Tuple[int, int, str], HarmonicFeatures]:
    """
    Extract harmonic features for all depths and all S/F combinations.

    Parameters
    ----------
    phase_bins : dict
        Mapping {depth_index: 32-bin phase array}.
    atten_bins : dict
        Mapping {depth_index: 32-bin attenuation array}.
    spacings : list
        Transmitter spacings (e.g., [16, 32, 48] in inches).
    frequencies : list
        Frequencies (e.g., ['H', 'M', 'L']).

    Returns
    -------
    dict
        Mapping {(depth_idx, spacing, freq): HarmonicFeatures} for phase and atten.

    Notes
    -----
    Keys are (depth_index, spacing, freq_label, channel) where channel is 'phase' or 'atten'.
    """
    features = {}

    for depth_idx in phase_bins.keys():
        for spacing in spacings:
            for freq in frequencies:
                # Phase harmonic
                key_phase = (depth_idx, spacing, freq, 'phase')
                features[key_phase] = fit_harmonic(phase_bins[depth_idx])

                # Attenuation harmonic
                key_atten = (depth_idx, spacing, freq, 'atten')
                features[key_atten] = fit_harmonic(atten_bins[depth_idx])

    return features
