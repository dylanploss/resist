# Inversion hackathon plan (2 days) and Z-20 misfit result

This replaces the six-week schedule in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the hackathon.
The physics choices in [ADR_1D5_strategy.md](ADR_1D5_strategy.md) still hold. The change is that we
**calibrate the algorithm to the tool** instead of trusting textbook EM theory for every curve.

## Using it from the app

1. **QC selection** tab: pick the run and tick the curves. `AR` curves give averaged data. A `ZR` image at 16/32/48 in
   contributes its **top and bottom bins**, and a `ZG` geosignal its **top bin**. These directional channels tell the
   inversion whether a boundary is above or below the well. `ZR` 50/66/82 in long-spacing images are not modelled yet,
   because their antenna layout is unconfirmed.
2. Press **Invert this selection →** (or open the **Inversion** tab). The tab uses the live QC selection, falling back
   to the saved selection and then the QC auto-pick. It shows each curve's weight and whether the Z-20 correction applies.
3. Set the MD interval (Z-20 defaults to 20100–20500 ft), station step, layer count, and calibration, then **Run inversion**.
   A 400 ft interval at 4 ft steps takes about 3 minutes. Results show the layer table, a curtain section, measured vs
   modelled tracks, and misfit per curve.

## Directional data (ZR top/bottom, ZG top)

The forward model (`ADRForward(azimuthal=True)`) evaluates the 45° tilted receivers at tool-face 0 (top) and
180° (bottom):

- **`ZR<f><s>{P,A}{T,B}`.** Compensated top/bottom-bin apparent resistivity. The uphole transmitter at the top bin is
  paired with the downhole transmitter at the bottom bin (mirror pairing), which keeps the up/down sensitivity.
- **`ZG<f>112{P,A}T`.** Top-bin geosignal: phase(top) − phase(bottom) in degrees and 20·log10|V_bottom/V_top| in dB,
  for a transmitter 112 in uphole of a tilted receiver at the tool midpoint.

Conventions checked against the delivered data:

| Check | Evidence |
|---|---|
| Top = image bin 0, bottom = bin 16 | The delivered `ZR..T/R/B/L` curves equal the 90° sectors of bins 28–3, 4–11, 12–19 and 20–27 (conductivity mean): median 0.8–1.1 % on Z-19/Z-20, better than one bin (1.4–1.7 %). Quadrants are now always extracted from the image this way, and the forward model predicts the same sector |
| Bottom bin reads a resistive bed below | Z-20 at 20350 ft: ZRH16P top 7.4, bottom 52.7 Ω·m as the well approaches the resistive layer below |
| ZG sign | ZG top phase/attenuation correlate +0.52 to +0.66 with log(ZR bottom/top) on Z-19 and Z-20. ZGL112A correlates < 0.16, so its weight is 0.25 |

Physics checks (tests): a homogeneous medium gives equal bins and zero geosignal, and a mirrored model swaps top/bottom
and flips the geosignal sign exactly. Synthetic test on the real Z-20 trajectory, using only stations *above* a
boundary 6 ft below the well:

- AR-only inversion put the boundary on the wrong side, with dip at its bound.
- With ZR top/bottom and ZG top, the multi-start inversion recovered it at +5.9 ft, with Rh 8/35 (true 8/40) and dip
  0.41° (true 0.5°).

Single bins and geosignals are weighted by their own noise. That noise is estimated in each window from
sample-to-sample differences, with floors of 2%, 0.5° and 0.05 dB. The Z-20 2 MHz attenuation correction is also
applied to the top/bottom attenuation bins.

**Cost:** the directional forward is about 13 ms per station. A 400 ft window at 4 ft steps took about 10 min in
Quick mode with 8 channels, so use 8 ft steps for quick looks.

## What exists now

| Module | Purpose |
|---|---|
| `backend/inversion/adr_forward.py` | 1.5D forward model: planar dipping TIV layers, real trajectory (TVD/INC/AZI/UTM), compensated phase and attenuation per spacing/frequency, whole-space transform to apparent resistivity. Uses empymod. |
| `backend/inversion/invert.py` | Windowed trust-region Levenberg–Marquardt. Parallel finite-difference Jacobian. Per-curve weights, free or fixed constant biases, and a resistivity-dependent `LevelCorrection`. |
| `backend/inversion/misfit_study.py` | CLI that measures theory-vs-tool misfit and tests correction factors with hold-out. |
| `backend/tests/test_inversion.py` | Transform, anisotropy, synthetic round trip (boundary + channel bias recovery), and correction tests. |

Synthetic round trip on the real Z-20 trajectory (101 stations, 3 layers, dip 1°, seven attenuation biases, 1% noise):
boundaries within 0.2 ft, Rh/Rv within 3%, dip 0.99°, and all biases within 0.4%. Fit time is about 1 min on 16 cores.

Run the study:

```
python -m backend.inversion.misfit_study --well Z-20 --md-min 20100 --md-max 20500 --split 20300 --output out/z20
python -m backend.inversion.misfit_study --experiments E5 --step-ft 4 --output out/z20   # phase-only check, ~8 min
```

## Z-20, 20100–20500 ft MD: misfit and correction factor

Interval: chalk with GR 5–14 API and caliper ≈ bit size. Inclination is 84→89° and TVD is 10609→10634 ft.
Resistivity is about 9 Ω·m above 20330 ft and 25–60 Ω·m below. Raw and vendor "C" curves are nearly identical here.
Results are in [results/z20_20100-20500ft](results/z20_20100-20500ft/report.json).

| Experiment | Result |
|---|---|
| E1: 3-layer fit to all 14 curves, no correction | RMS 18.4%. Rv/Rh is driven to 1 (lower bound), because attenuation reading *above* phase cannot be produced by any TIV anisotropy. |
| E2: + constant per-curve factor | RMS 16.2%. Phase factors are 0.96–1.01; 2 MHz attenuation factors are 1.10–1.20. |
| E3: constant factor, hold-out across halves | Does not transfer as a whole: upper→lower 23.1→21.8%, lower→upper 10.0→12.1% (worse). |
| E5: earth model from **phase only**, then attenuation vs that model | Phase fits with mean residuals within ±2.3%, and Rv/Rh ≈ 1.8 appears once attenuation is removed. 2 MHz attenuation reads +15 to +25% high in both halves. |

E5 hold-out (attenuation RMS on the half *not* used for calibration):

| Curve | none | constant | gain (cal. on lower, wide resistivity range) |
|---|---|---|---|
| ARH16A | 21.6% | 13.6% | **11.3%** |
| ARH32A | 13.0% | 11.6% | **6.2%** |
| ARH48A | 11.1% | 12.4% | **9.4%** |
| ARM16A / ARM32A / ARM48A | 22.1 / 7.6 / 8.1% | 21.7 / 13.9 / 9.1% | 14.3 / 15.0 / 16.5% |
| ARL48A | 9.5% | 24.8% | 14.6% |

Calibrating the gain on the upper half alone fails: it covers only 8–10 Ω·m, so the gain is unconstrained.
Calibrate on intervals that span a wide resistivity range.

### Recommendation

1. **Phase curves: no correction.** Use them as the primary inversion data with weight 1.
2. **2 MHz attenuation: apply a resistivity-dependent correction**, not a constant:
   `log10 Ra_measured = log10 Ra_theory + a + g·(log10 Ra_theory − 1)`.
   Z-20 values (`Z20_ATTENUATION_CORRECTION` in `invert.py`):

   | Curve | factor at 10 Ω·m | factor at 40 Ω·m | a | g |
   |---|---|---|---|---|
   | ARH16A | 1.21 | 1.44 | 0.082 | 0.125 |
   | ARH32A | 1.14 | 1.29 | 0.057 | 0.087 |
   | ARH48A | 1.13 | 1.25 | 0.053 | 0.076 |

   The bias is largest at the shortest spacing and grows with resistivity. That is the expected signature of
   mandrel, borehole or vendor-transform effects that a point-dipole whole-space transform does not include.
   Use weight 0.5 until the correction is confirmed on a second well.
3. **500 kHz and 125 kHz attenuation: QC only (weight 0).** No correction transfers between halves.
   ARL48A has little sensitivity above ~20 Ω·m, and ARM16A is spiky. `HACKATHON_WEIGHTS` encodes items 1–3.
4. **The remaining ~12–20% phase misfit is structural.** One planar 3-layer model over 400 ft cannot fit the
   20400–20430 ft resistive bulge. Shorter windows will fix more misfit than any correction factor.

Caveats: the correction depends on unconfirmed geometry (8 in receiver separation, spacing measured to the receiver
midpoint, ZZ-equivalence of averaged tilted receivers). It comes from one well, so treat it as a hypothesis until it
reproduces on Z-19 or Z-6.

## Two-day schedule

| When | Owner | Task | Done when |
|---|---|---|---|
| Day 1 AM | David | Windowed driver: 60–100 ft windows, 50% overlap, warm start; use `HACKATHON_WEIGHTS` + `Z20_ATTENUATION_CORRECTION` | Z-20 20100–20500 phase RMS < 8% |
| Day 1 AM | Dylan | Feed QC selection into curve weights (drop flagged curves per interval) | `curve_weights` built from QC JSON |
| Day 1 PM | David | Repeat the E5 check on one interval of Z-19 or Z-6 with a wide resistivity range | Gain values within ±0.05 of Z-20 → adopt globally; else per-run nuisance |
| Day 1 PM | Ove | `POST /invert/run` (run, MD range) returning boundaries, Rh/Rv, dip, per-curve misfit; run in a background thread | **Done:** `POST /inversion/jobs` + `GET /inversion/jobs/{id}` |
| Day 2 AM | David | Add geosignal/ZR first-harmonic amplitude as data to resolve up/down and dip; test receiver-separation sensitivity (6/8/10 in) | Dip sign stable across windows |
| Day 2 AM | Ove | Frontend inversion tab: data vs model curves, curtain of boundaries along TVD, misfit track | **Done:** *Inversion* tab, fed by the QC selection |
| Day 2 PM | All | Run 2–3 wells, freeze correction table, demo | Demo-ready results and short write-up |

Performance: 200 stations cost about 3.4 s per forward on one core. One LM iteration costs about one forward when
Jacobian columns run in parallel. Memory is about 130 MB per worker, so keep `workers` ≤ 8 on 16 GB machines that
also run the dev servers.
