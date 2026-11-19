# UDAR Bench: 2.5D forward solver, method and validation

UDAR Bench is a single-file web app. It builds a user-defined synthetic UDAR tool (spacings, frequencies, Tx/Rx axis configurations), a parameterised geology (1D dipping layers, or a 2D section with polyline boundaries and laterally varying Rh/Rv), and a wellbore (minimum-curvature sections, toolface). It forward-models the raw couplings in 1D or 2D and runs a station-by-station 1D inversion with configurable noise and channel selection on a separate tab. Everything runs in the browser, in Web Workers.

These notes describe the 2D (2.5D finite-difference) forward mode and record how it was checked.

## Method

**Decomposition.** At every logging station

  H_2.5D = H_1D(local model, exact) + [ FD(true section) − FD(local model) ]

The local model is the layered earth directly below the tool: boundary depths read from the section at the tool position, the dip of the nearest boundary (±5 m central difference), and the resistivities at the tool position. H_1D is the exact layered-earth solution (Key 2012 Hankel filters, checked against empymod). The bracket is the difference of two finite-difference solutions on the same grid. Discretisation errors close to the antennas, and errors from the outer boundary and grid stretching, largely cancel in that difference.

**Finite differences.**
- Frequency domain, e^(−iωt), quasi-static, μ = μ0, conductivity tensor tilted in the section plane (TTI, symmetry axis normal to bedding).
- Fourier transform along strike (y), so the problem becomes E(x, k_y, z). The y = 0 response is (1/π)∫₀^∞ dk_y (even part); only the xx, yy, zz, xz and zx couplings are non-zero for an in-plane well.
- Staggered (Yee) grid in (x, z), PEC outer box. With E_y scaled by i the matrix is complex symmetric, and it is factorised by a multifrontal LDLᵀ with nested dissection written in JavaScript: about 0.3–1 s per factorisation of 9k–16k grid nodes, and 50–300 MB per solve.
- Conductivity on the grid is edge-based (finite-integration style). Each unknown gets a laminate (Backus-type) average over its own dual cell, with hat weights in the staggered directions. The boundary normal comes from the structure tensor of 8 × 8 samples per cell.
- Sources are point magnetic dipoles (discrete curl of a bilinearly spread moment). Receivers take H as the discrete curl of E.
- k_y quadrature: Gauss–Legendre in u with k = k0·sinh(u), k0 = 0.2/d_hi and k_max = 3/d_lo. Here d_lo = max(antenna-to-feature distance, 2h), d_hi = max(d_lo, L/2), and the node count is n0 + 2.35·ln(d_hi/d_lo).

**Grid per station and frequency.**
1. The solver scans three nested boxes for cells where the section differs from the local model by more than 2% in conductivity. If nothing differs within reach, the station is skipped and the correction is 0.
2. Cell size: h = min(d/res, δ_min/sres, L_min/6, 4 m). Here d is the distance from the antennas to the nearest edge of the differing zone, and δ_min is the smallest skin depth. δ_min includes conductive zones across a lateral boundary.
3. The grid has a uniform core of ±max(12h, 1.5d) around the antennas and stretches by ×1.2 per cell out to 40–250 m (3 skin depths). A node budget per accuracy level coarsens h when needed. Every solve reports its resolution as a fraction of the target.

| Accuracy | res | sres | n0 (k_y) | samples per cell | node budget | refinement rounds |
|---|---|---|---|---|---|---|
| Draft | 6 | 2.5 | 6 | 6 × 6 | 4,500 | 2 |
| Standard | 8 | 3.5 | 8 | 8 × 8 | 9,000 | 4 |
| Fine | 12 | 5 | 10 | 8 × 8 | 16,000 | 4 |

**Along the well.**
- Solver stations are placed every 25 m (user setting), at both ends of every segment, and 2, 4, 8 and 16 m either side of every jump of the local model. Jumps are fault steps, switches of the nearest boundary, and resistivity steps of more than 35% between two stations.
- Bisection rounds follow. At Standard, an interval is bisected when the correction changes across it by more than max(0.004, 5% of its maximum), or when a neighbouring station deviates from the straight line through its own neighbours by more than max(0.002, 1% of the maximum), in units of the free-space coupling. Draft uses looser tolerances and Fine tighter ones.
- The section-frame difference tensors are interpolated with PCHIP inside each segment, never across a jump. They are then rotated to every channel's Tx/Rx axes at every station.

## Validation

### Exact lateral contrasts (23 cases)
The reference is empymod, using a 2-layer medium with a vertical boundary, which is an exact 1D problem with its layering normal along x. The error is max over (xx, yy, zz, xz, zx) of |FD − exact|, divided by the peak |2D − local 1D|. Settings are Standard defaults.

| Set | Cases | Error, % of peak correction |
|---|---|---|
| A: mixed geometry (L 5–40 m, 2–100 kHz, tool parallel, oblique, perpendicular; nearest antenna 1–20 m from the contrast) | 8 | 0.5 0.9 0.7 0.8 0.5 0.8 2.5 0.3 |
| B: L 30 m, 15 m from the contrast, 20 Ω·m against 15, 5, 1, 0.2, 100, 1000 Ω·m at 6 kHz; 20 against 2 Ω·m at 1, 24, 100 kHz | 9 | 0.2 0.3 0.9 1.1 0.4 0.6 0.8 0.8 1.4 |
| C: tool straddling the contrast (one antenna on each side), L 8–30 m, 6–100 kHz | 6 | 0.5 0.3 2.0 0.4 0.4 0.3 |

All 23 cases are within 0.2–2.5%.

### Wrong-dip baseline (thin wedges, TTI)
The true model is 3 planar layers (2/3, 60/80, 2/3 Ω·m Rh/Rv, sand 10 m thick) dipping 4°. The FD baseline uses 7°. The tool is at inclination 86° with toolface 30°, and all nine Tx/Rx couplings are compared with the exact H_1D(4°) − H_1D(7°).
- 24 kHz, 16 m: correction up to 4.2e-3, error 4.6e-4 (11%).
- 6 kHz, 30 m: correction up to 1.3e-2, error 1.2e-3 (9.5%).
- The cross-components (ZX, XZ, XY, YX, YZ, ZY) match in sign and size, which confirms the frame rotations.
- At Draft the errors are 9.1e-4 and 2.8e-3. At Fine they are 4.4e-4 and 8.7e-4.

These are small corrections. An error of 1e-3 of the free-space coupling is about 0.01 dB, but it is 10–20% of a correction this small.

### Along-well interpolation (default 2D presets, Standard)
Dense references solve every station (2 m apart). Each was compared with the default adaptive run:

| Region | Peak correction | Solver stations (adaptive) | Largest interpolation error |
|---|---|---|---|
| Normal fault, 6 m throw (sand 60/80 Ω·m in 2/3 Ω·m shale), MD 100–200 | 0.45 (≈12 dB against the local-1D log) | 40 of 51 | 3.7e-3 |
| Lateral resistivity drop in the sand (60 → 20 Ω·m between x = 260 and 300 m), MD 200–280 | 0.074 (0.77 dB) | 34 of 41 | 1.6e-4 |

How much the solved correction scatters from station to station was measured as the deviation of each station from the mean of its 2-m neighbours, in the dense sand reference. The median is 7.6e-4 of the free-space coupling and the 90th percentile 2.1e-3 (the 90th percentile includes real curvature where the resistivity ramp starts).

## Run time
- One solve covers one station and one frequency with all spacings at that frequency. Measured single-threaded in Node on a 2-core container: Draft about 1.5–3 s, Standard about 2–7 s, Fine about 10–30 s. Solves are skipped in well under a second where nothing differs.
- The browser runs up to 6 solves in parallel, or 4 at Fine, because of memory.
- In the fault region (MD 100–200, 3 frequencies), the adaptive run did 120 solves in 641 s single-threaded, about 5.3 s per solve. A browser with 6 workers would take about 2 minutes for that interval.
- In headless Chrome with one worker, at Draft accuracy, MD 200–280 at 2 frequencies took 58 solves in 2.8 minutes. That run used 4 refinement rounds; Draft now stops after 2.

## Limitations
- The geology is 2D: it is invariant perpendicular to the section, and the well must lie in the section plane.
- Antennas are point dipoles. There is no borehole, mandrel or eccentricity, displacement currents are ignored, and media are non-magnetic.
- Accuracy drops when a 2D feature, or a very conductive zone, is within a few cells of an antenna and the node budget caps the grid. Those solves are flagged (resolution below 70%), with the size of the correction.
- The correction is interpolated between solver stations. Near faults and boundary kinks it changes quickly, and the refinement rounds limit, but do not remove, the interpolation error (see above).
- The inversion is 1D per station. On 2.5D data, the inversion no longer shares the forward engine of the data, so the inverse crime is weaker than in 1D mode.
