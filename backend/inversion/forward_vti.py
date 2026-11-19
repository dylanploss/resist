"""
1D VTI forward model for ADR tool responses.

Evaluates 1D layered VTI (vertical transverse isotropic) electromagnetic responses
using point-dipole transmitters and receivers at the actual ADR tool geometry,
accounting for wellbore trajectory and dip orientation.

This module provides the core forward model for the inversion.
"""

from typing import NamedTuple, List, Dict, Tuple
import numpy as np


class Station(NamedTuple):
    """Well station geometry and properties."""
    md: float                      # Measured depth (feet)
    tvd: float                     # True vertical depth (feet)
    inclination_deg: float         # Well inclination (degrees)
    azimuth_deg: float             # Well azimuth (degrees)
    x: float = None               # Easting (feet), computed if not provided
    y: float = None               # Northing (feet), computed if not provided


class DipOrientation(NamedTuple):
    """Dip of a geological boundary in tool frame."""
    dip_deg: float                 # Magnitude of dip (0–90 degrees)
    dip_azimuth_deg: float         # Azimuth of dip direction (0–360 degrees)


class LayerStack(NamedTuple):
    """Layered VTI resistivity model."""
    depths_tvd: List[float]        # TVD of layer boundaries (feet)
    rh_values: List[float]         # Horizontal resistivity per layer (ohm·m)
    rv_values: List[float]         # Vertical resistivity per layer (ohm·m)


def make_station(md: float, tvd: float, inclination_deg: float, azimuth_deg: float) -> Station:
    """
    Create a well station with trajectory information.

    Parameters
    ----------
    md : float
        Measured depth (feet).
    tvd : float
        True vertical depth (feet).
    inclination_deg : float
        Inclination angle (0 = vertical, 90 = horizontal).
    azimuth_deg : float
        Azimuth (0–360 degrees; 0 = North).

    Returns
    -------
    Station
        Station record with geometry.
    """
    return Station(md=md, tvd=tvd, inclination_deg=inclination_deg, azimuth_deg=azimuth_deg)


def dip_to_normal(dip_deg: float, dip_azimuth_deg: float) -> Tuple[float, float, float]:
    """
    Convert dip magnitude and azimuth to bed-normal vector in formation frame.

    Parameters
    ----------
    dip_deg : float
        Dip magnitude (0–90 degrees).
    dip_azimuth_deg : float
        Azimuth of dip direction (0–360 degrees).

    Returns
    -------
    tuple
        Unit bed-normal vector (nx, ny, nz) in formation frame.

    Notes
    -----
    Formation frame: X=North, Y=East, Z=down (TVD).
    For example, a 45° dip to the North gives a normal vector tilted south.
    """
    dip_rad = np.deg2rad(dip_deg)
    azimuth_rad = np.deg2rad(dip_azimuth_deg)

    # Bed normal perpendicular to strike, pointing "downhill"
    nx = np.sin(dip_rad) * np.cos(azimuth_rad)
    ny = np.sin(dip_rad) * np.sin(azimuth_rad)
    nz = np.cos(dip_rad)

    return nx, ny, nz


def rotate_to_tool_frame(
    bed_normal_formation: Tuple[float, float, float],
    station: Station
) -> Tuple[float, float, float]:
    """
    Rotate bed-normal from formation frame to tool frame.

    Parameters
    ----------
    bed_normal_formation : tuple
        Unit bed normal (nx, ny, nz) in formation frame.
    station : Station
        Well station with inclination and azimuth.

    Returns
    -------
    tuple
        Unit bed normal (nx', ny', nz') in tool frame.

    Notes
    -----
    Tool frame: X' = perpendicular to wellbore (high side), Y' = perpendicular to X',
    Z' = along wellbore (down-hole).

    Implementation uses standard rotation matrices for well trajectory.
    """
    # Rotation matrix from formation to tool frame
    # Based on well trajectory: inclination θ, azimuth φ

    inc_rad = np.deg2rad(station.inclination_deg)
    az_rad = np.deg2rad(station.azimuth_deg)

    # Rotation matrices
    cos_inc = np.cos(inc_rad)
    sin_inc = np.sin(inc_rad)
    cos_az = np.cos(az_rad)
    sin_az = np.sin(az_rad)

    # R matrix: rotates from formation (N, E, D) to tool (High, Perp, Axial)
    # This is a simplified rotation; exact geometry depends on tool orientation convention
    R = np.array([
        [cos_az, sin_az, 0],
        [-sin_az * cos_inc, cos_az * cos_inc, sin_inc],
        [sin_az * sin_inc, -cos_az * sin_inc, cos_inc]
    ])

    bed_normal_tool = R @ np.array(bed_normal_formation)
    return tuple(bed_normal_tool)


def forward_vti_1d(
    layer_stack: LayerStack,
    station: Station,
    dip_orientation: DipOrientation,
    transmitter_configs: List[Dict],
    receiver_configs: List[Dict],
    frequency_hz: float,
    temperature_c: float = 25.0
) -> Dict[str, np.ndarray]:
    """
    Compute ADR tool response in 1D layered VTI medium.

    Parameters
    ----------
    layer_stack : LayerStack
        Resistivity model (layer depths, Rh, Rv).
    station : Station
        Well station geometry.
    dip_orientation : DipOrientation
        Geological dip in formation frame.
    transmitter_configs : list
        Transmitter geometries (position, moment magnitude).
    receiver_configs : list
        Receiver geometries (position, orientation, number of bins).
    frequency_hz : float
        Operating frequency (Hz).
    temperature_c : float, optional
        Temperature for conductivity correction (default 25°C).

    Returns
    -------
    dict
        Mapping {receiver_key: 32-bin voltage response} for each receiver.

    Notes
    -----
    This is a stub placeholder. Full implementation requires:
    1. 1D EM tensor evaluation (Hankel digital filters or analytical solutions)
    2. Tool-specific receiver configuration (45° tilt, bin ordering)
    3. Compensation formulas (ADR patent, dossier p.3)
    4. Frequency-dependent conductivity

    For now, returns synthetic data (zero) to allow module integration to proceed.
    Real implementation should interface with UDAR_Bench or empymod.
    """
    # TODO: Implement 1D EM tensor using Hankel digital filters or empymod
    # TODO: Apply tool compensation (attenuation to dB, phase correction)
    # TODO: Rotate tensor to tool frame and bin into 32 azimuthal samples

    responses = {}
    for rx_key, rx_config in receiver_configs.items():
        # Placeholder: return zeros
        responses[rx_key] = np.zeros(32)

    return responses


def forward_window(
    layer_stack: LayerStack,
    trajectory: List[Station],
    dip_orientation: DipOrientation,
    window_start_idx: int,
    window_end_idx: int,
    transmitter_configs: List[Dict],
    receiver_configs: List[Dict],
    frequencies_hz: List[float],
    bin_zero_offset_deg: float = 0.0,
    rotation_sign: int = 1
) -> Dict[Tuple[int, str, float], Dict[str, np.ndarray]]:
    """
    Compute forward responses for a window of stations (single iteration).

    Parameters
    ----------
    layer_stack : LayerStack
        Resistivity model.
    trajectory : list
        Station trajectory over the window and beyond.
    dip_orientation : DipOrientation
        Geological dip (assumed constant over window).
    window_start_idx : int
        First station index in window.
    window_end_idx : int
        Last station index in window (inclusive).
    transmitter_configs : list
        Transmitter geometries.
    receiver_configs : list
        Receiver geometries.
    frequencies_hz : list
        Operating frequencies (Hz).
    bin_zero_offset_deg : float, optional
        Bin-zero azimuth offset (degrees).
    rotation_sign : int, optional
        Rotation direction sign (+1 or -1).

    Returns
    -------
    dict
        Mapping {(station_idx, rx_label, freq_hz): {channel: 32-bin array}}.
    """
    responses = {}

    for station_idx in range(window_start_idx, window_end_idx + 1):
        station = trajectory[station_idx]

        for freq_hz in frequencies_hz:
            # Forward model at this station
            forward_at_station = forward_vti_1d(
                layer_stack, station, dip_orientation,
                transmitter_configs, receiver_configs, freq_hz
            )

            # Store by (station_idx, rx_label, freq)
            for rx_key, bins_32 in forward_at_station.items():
                key = (station_idx, rx_key, freq_hz)
                responses[key] = {
                    'phase': bins_32,       # Placeholder
                    'attenuation': bins_32  # Placeholder
                }

    return responses
