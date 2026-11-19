# Inversion Strategy & Planning Summary

## Overview

Based on a detailed research study of the Halliburton ADR tool and 1.5D EM inversion approaches for the Ekofisk dataset, we have established a clear technical roadmap for building an efficient inversion system within the Resist platform.

**Key Finding:** A 1D layered VTI forward model evaluated at the actual tool position along the wellbore trajectory is **exact for planar beds** (the 1.5D case), costs only milliseconds per station, and is therefore ideal for processing 11 runs with thousands of depths each.

---

## Recommended Approach

### 1. Forward Model: 1D Layered VTI

**What:** Solve for electromagnetic responses in a 1D stratified medium with vertical transverse isotropy (Rh ≠ Rv), accounting for:
- **Tool trajectory:** Use wellbore inclination and azimuth at each depth to rotate the stratigraphy into the tool frame
- **Dip and dip azimuth:** Parameterize geological dip as a rotation of the bed normal; this automatically adjusts the apparent layer thicknesses and resistivity anisotropy as the well deviates
- **Point-dipole transmitters and receivers:** ADR uses six coaxial transmitters (±16, ±32, ±48 in) and three 45° tilted receivers; model them as point dipoles at their actual positions relative to the wellbore

**Why:** 
- Exact for planar beds at oblique tool positions (the definition of 1.5D)
- Runs at ~0.2–2 seconds per station with Hankel digital filters, suitable for inversion
- 2D/2.5D models cost 10+ minutes per run; 3D is impractical for 11 large runs
- 1D naturally separates dip (tool frame geometry) from anisotropy (formation properties)

**Cost:** ~8–10 seconds per station for all 6 transmitters × 3 receivers × ~16 frequencies (accounting for caching and batching).

### 2. Data Reduction: Harmonic Fitting

**What:** Extract the first-harmonic sinusoid from each 32-bin azimuthal image:
- Fit `a₀ + a₁·cos(ψ) + b₁·sin(ψ)` to the 32 bin phase and attenuation values
- Extract three features: mean (a₀), amplitude √(a₁² + b₁²), and phase atan2(b₁, a₁)
- Reserve the residual of harmonics 2+ as a noise QC channel

**Why:**
- 32 azimuthal samples at 11.25° intervals encode only ~3 DOF given the 45° tilted receiver geometry
- Harmonic extraction reduces data volume, removes high-frequency noise, and aligns naturally with the tool physics
- Geosignals (bin k minus bin k+16) are, up to a constant factor, the first-harmonic amplitude itself

**Cost:** <100 ms per depth; trivial compared to forward model evaluation.

### 3. Inversion: Windowed Levenberg-Marquardt

**What:** Use a gradient-based optimization on sliding windows:
- **Windows:** ~60 ft MD, ~120 samples (at 0.5 ft sampling), overlapped by 50% to tile each run
- **Per-window parameters:** 3–5 layers with Rh and Rv per layer; 2 boundary positions; 2 dip parameters; optional nuisance gains
- **Optimization:** Levenberg-Marquardt with finite-difference Jacobians (2P+1 forward calls per iteration)
- **Multi-start:** Use a pre-computed library of sinusoid mean and amplitude vs. boundary distance and contrast; run 5–10 trials with different initializations
- **Regularization:** Smoothness on boundary positions along MD; continuity ties to adjacent windows; damping on resistivity changes within thick intervals

**Why:**
- Windowed approach allows local adaptation of layer count and geometry without overfitting
- Warm-start across overlapping windows dramatically reduces compute cost
- LM is proven in geophysical inversion; Halliburton's own approach uses LM per station
- Multi-start + regularization mitigates local minima near parallel boundaries
- Handles dip naturally through trajectory-based coordinate transforms

**Cost per window:** ~1–10 seconds (best case with batching and caching); full 11-run inversion in ~1–8 hours single-threaded, ~15–60 minutes on an 8-core workstation.

**Rolling inversion during acquisition:** Feasible with warm starts; each new station (every few feet MD) can be incorporated in seconds, enabling real-time geosteering feedback.

### 4. Dip Accommodation (The 1.5D Trick)

**Key insight:** Dip automatically emerges from the tool trajectory and formation geometry:
- Parameterize the geological dip as a bed-normal vector in the formation frame (North, East, Down)
- Rotate into the tool frame using the well's inclination and azimuth at each station
- The 1D forward model then naturally accounts for oblique dip; layer thicknesses adjust with well deviation
- Result: A single set of dip/azimuth parameters works over the entire window, even as the well deviates

This elegantly handles dip and trajectory together, avoiding the need for 2D or 2.5D models.

---

## Validation Strategy

1. **Synthetic round-trip tests:** Create synthetic resistivity models with known dip and anisotropy; compute synthetic ADR responses; invert the synthetic data; measure parameter recovery error (<2% target).

2. **Non-circular checks:** Use conventional logs (GR, density), core samples, and log-based resistivity estimates as qualitative context only; inversion results are independent and used to explain log variations.

3. **Spot 2D/2.5D validation:** For 1–2 select intervals (e.g., near sharp boundaries), run a 2D FD forward model and compare 1D vs. 2D predictions; flags potential 3D/multi-dip zones.

4. **Noise estimation:** From the residual of the harmonic fit (harmonics 2+), estimate noise floors per channel; use to validate data-fit weights and uncertainty estimates.

---

## Computational Complexity & Feasibility

| Scenario | Time per Window | Windows per Run | Full-Run Time |
|----------|-----------------|-----------------|---------------|
| Single-threaded, synthetic | 1–5 s | 1,000–3,000 | 3–15 hours |
| Single-threaded, with caching | 0.5–2 s | 1,000–3,000 | 1–8 hours |
| 8-core parallelized | 0.2–1 s effective | 1,000–3,000 | 15–60 minutes |
| Rolling inversion (warm start) | <1 s | Per new station | Real-time feasible |

**Acceptable for research:** 1–8 hours per 11-run batch on a laptop is acceptable for comprehensive inversion, QC, and visualization.

**Feasible for real-time:** With warm starts and batching, rolling inversion during acquisition (every new depth) can be achieved in seconds per station, enabling live geosteering feedback.

---

## Implementation Roadmap (6–8 Weeks)

### Workstream 1: Forward Model & Harmonics (Weeks 1–3)
1. Implement harmonic fitting (extract mean, amplitude, phase from 32-bin images)
2. Design and prototype 1D VTI forward model interface
3. Integrate Hankel digital filters or empymod for fast 1D EM tensor evaluation
4. Validate with synthetic round-trip test

### Workstream 2: Levenberg-Marquardt Inversion (Weeks 2–4)
1. Windowed parameterization and Jacobian setup
2. LM solver with trust region and multi-start
3. Windowed joint inversion with continuity ties
4. Synthetic round-trip validation

### Workstream 3: Integration & Backend API (Weeks 3–5)
1. Connect to data pipeline (loader, transition detector)
2. REST API endpoints for inversion control and results retrieval
3. Validation harness (synthetic tests, uncertainty quantification)

### Workstream 4: Frontend UI & Visualization (Weeks 4–6)
1. Inversion control panel (run selection, parameter sliders, progress monitoring)
2. Results visualization (depth logs, error bars, boundary overlays, dip rose plots)
3. QC dashboard and export (CSV, JSON, VTK)

### Workstream 5: Validation & Documentation (Weeks 5–6)
1. Cross-platform testing (Windows, Mac, Linux)
2. Comprehensive user and developer guide

---

## Unconfirmed Tool Parameters (Known Unknowns)

The ADR dossier leaves several tool parameters unspecified. We handle them as nuisance parameters or pre-estimation:

| Parameter | Issue | Strategy |
|-----------|-------|----------|
| **Bin zero offset (ψ₀)** | Unconfirmed azimuth reference | Estimate on thick homogeneous or well-defined boundary interval; hold constant or re-estimate periodically |
| **Rotation sign (s = ±1)** | Spin direction (clockwise vs. CCW in 32-bin array) | Same as bin zero; estimate on a training interval |
| **TX/RX frequency mapping** | Dossier does not publish which pair runs at which frequency | Assume all S/F combinations present (conservative); adjust when Halliburton clarifies |
| **Borehole correction (C channels)** | Unknown correction formula | Add nuisance per-channel gains; validate against 2D/2.5D on 1–2 spots |
| **Tool noise & accuracy** | Not published | Estimate from harmonic residuals; refine after initial inversion runs |

---

## Risks & Mitigation

| Risk | Mitigation |
|------|-----------|
| 1D EM solver performance exceeds budget | Use UDAR_Bench (C++ wrapper) if empymod is too slow; custom Hankel filters as fallback |
| Multi-start fails on difficult zones (near-parallel boundaries) | Use stochastic search (simulated annealing) as coarse initializer for flagged windows |
| Unconfirmed tool parameters bias results | Estimate nuisance offsets on training intervals; cross-validate with UDAR_Bench |
| 1D model inadequate near high-contrast boundaries | Add nuisance per-channel gains; validate with 2D/2.5D; flag zones as "uncertain" in results |

---

## Success Criteria

1. ✓ **Harmonic features** extracted from all 11 runs with <5% residual noise
2. ✓ **Full-run inversion** completes in <60 minutes on a modern workstation
3. ✓ **Synthetic round-trip** recovers true resistivity to <2% error
4. ✓ **Results interpretable:** Boundary positions smooth across windows; trends match transitions
5. ✓ **Robust handling:** Missing data, null values, edge cases handled gracefully
6. ✓ **Well documented:** New developer can extend code after reading guide for one day

---

## References

- **ADR Dossier:** Halliburton tool specifications and physics (supplied)
- **UDAR_Bench:** Point-dipole 1D EM forward model and LM inversion (Halliburton-affiliated, in repo)
- **empymod:** Python 1D layered EM with anisotropy (open-source, Werthmüller)
- **SimPEG:** Geophysical inversion framework (open-source, Cockett et al.)
- **Bittar et al., 2009:** ADR tool design; SPE REE 12(2)
- **US 9,239,403:** Quality gating and library-based inversion (Halliburton patent)

---

## Deliverables from Research Phase

✓ **docs/inversion/ADR_1D5_strategy.md** – 9 KB comprehensive strategy document  
✓ **docs/inversion/IMPLEMENTATION_PLAN.md** – 15 KB implementation roadmap with workstreams, risks, success criteria  
✓ **backend/inversion/harmonics.py** – Harmonic fitting module (ready for unit tests)  
✓ **backend/inversion/forward_vti.py** – 1D VTI forward model interface and coordinate transforms  

---

## Next Immediate Actions

1. **Week 1:** Implement and test harmonic fitting on real DLIS data
2. **Week 1–2:** Choose 1D EM solver (empymod vs. UDAR_Bench); prototype forward model
3. **Week 2:** Coordinate with Dylan on curve QC to understand data quality drivers
4. **Week 3:** Begin LM solver implementation in parallel
5. **Ongoing:** Keep UDAR_Bench repository in view for validation reference

---

**Prepared by:** Research study on 1.5D EM inversion for ADR data  
**Date:** November 2026  
**Status:** Ready for implementation planning and team assignment
