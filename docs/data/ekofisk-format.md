# Ekofisk data analysis and transition tool

David's data-analysis workstream from the [platform plan](../plans/resist-platform-dev-plan.md).
The CLI inventories all delivered channels and detects candidate changes along measured
depth. It also supports geological labels from explicitly supplied calibration rules.
It does not implement EM forward modeling, inversion, or Dylan's ranked curve-selection QC.

## Run

From the repository root, using the existing requirements:

```powershell
.\.venv\Scripts\python.exe -m backend.data.inventory --data-dir data --output "$env:TEMP\resist-analysis"
.\.venv\Scripts\python.exe -m unittest discover -s backend\tests -p test_data_analysis.py
```

On macOS/Linux, use `.venv/bin/python` and a suitable output directory.
Use `--export-tidy` to additionally write every measurement and image bin to
compressed CSV; this is substantially larger than the default reports.
`--no-plots` skips PNG generation. Sources are opened read-only.

Outputs:

- Combined and per-run `inventory.csv`: every channel, including `DEPT`, with original
  unit, description, null value, sample/bin counts, coverage, nonpositive count,
  depth range in metres, family, frequency and nominal spacing.
- Per-run `report.json`: candidate depths, before/after feature values, supporting
  families, calibration, limitations, and original header parameters.
- Per-run `change_scores.csv`: depth-aligned family scores; blanks mean unavailable.
- Per-run `environments.csv`: contiguous label intervals, including unknown and
  ambiguous intervals. Endpoints are sample centres, not inferred bed interfaces.
- Per-run `overview.png`: averaged resistivity, GR and change scores with candidate
  markers. These are inspection aids, not a validated geological interpretation.
- `summary.json`: well/run counts and candidate counts.

The loader's `WellRun.tidy()` streams DataFrames by curve, with the shared columns
`well, curve, unit, depth_ref, depth_m, value` plus `run` and `bin`.
Scalar curves have `bin=-1`; image bins are preserved as indices 0–31, not absolute
directions. Missing values become NaN internally and blank CSV cells.

## Verified file structure

All eleven files contain one logical file and one frame, with scalar and 32-bin
channels. There are ten distinct wellbores: the two Z-25 files are separate runs
and are never spliced or compared across their intervening gap.
`DEPT` is strictly increasing, stored in feet with 0.5 ft sampling. Conversion is
exactly 0.3048 m/ft. The release notebook describes MD below RKB; the tool records
`depth_ref=MD_RKB` on this basis, not from an inferred elevation datum. Original
parameters such as `DMF`, `LMF`, `PDAT`, `GDAT` and `MAPZ` are preserved in reports.
The release null sentinel is -999.25; other nonfinite samples also become NaN.

The loader rejects unsupported logical-file/frame layouts, unsupported dimensions,
nonmonotonic depth, and unexpected depth units rather than guessing.

## ADR mapping and limits

Source: [supplied ADR dossier](../../Halliburton%20ADR%20%E2%80%94%20tool%20specifics%20for%20EM%20forward%20modeling.pdf),
especially pages 2–7. Its geometry combines published specifications, patent
illustrations and derived assumptions; it is not an acquisition calibration sheet.

| Token | Meaning used by the tool |
|---|---|
| AR / ZR / ZG | Averaged resistivity / azimuthal resistivity / geosignal |
| H / M / L | 2 MHz / 500 kHz / 125 kHz |
| Number | Nominal spacing in inches; not a verified Tx/Rx coordinate mapping |
| P / A | Phase-derived / attenuation-derived measurement |
| C | Corrected; correction unknown |
| T / B / L / R | Delivered quadrant suffix; absolute orientation unconfirmed |

AR and ZR values are already resistivities in `ohmm`, **not** raw phase/amplitude.
ZG phase uses `deg` and attenuation uses `dB`. Do not subtract ZR resistivities to
reconstruct vendor geosignals: the homogeneous transforms and receiver assignments
are not supplied. The detector validates these unit strings before using curves.

The PDF describes six coaxial transmitters and 45-degree tilted receivers, nominal
16/32/48 inch compensated spacings, patent-derived asymmetric spacings, and 32
azimuthal bins. Delivered image mnemonics also include 50/66/82; these remain literal
nominal channel spacings, not forced into the patent geometry. Tool identity/version,
bin zero/direction, bit-to-sensor offset and correction/calibration remain open.
The PDF's nominal detection ranges are not resolution estimates or a conversion
from a change score to metres from a bed boundary.

## Candidate transition algorithm

This is an offline, two-sided sustained-change detector:

1. Use scalar AR, 32-bin ZR, scalar/image ZG and GR where available. Prefer an AR
   corrected channel over its uncorrected duplicate. Exclude nonpositive
   resistivities from log10 analysis, but preserve their original values in tidy export.
2. Reduce ZR log10 resistivity images to mean and first-harmonic magnitude, requiring
   all 32 valid bins. This does not assign a spatial direction. Reduce image ZG to RMS
   rather than a signed mean, so opposite-bin responses do not cancel.
3. Compare medians in adjacent windows, each at least `--window-m` long
   (default 3 m, minimum three samples). Require a complete window per feature;
   never interpolate missing measurements or compare across depth gaps greater
   than 1.5 times the median sample step.
4. Divide absolute change by rolling residual MAD × 1.4826, with heuristic floors:
   0.05 log10 ohmm, 0.5 deg, 0.05 dB, and 3 gAPI. These are explicit analysis
   settings, **not manufacturer noise specifications**.
5. Take the median score within each family, require `--threshold` (default 3)
   in `--min-families` (default 2), collapse contiguous response zones to their
   strongest candidate, and suppress candidates closer than the requested window.

Window size, score threshold and minimum families are CLI parameters. AR and ZR
are correlated; two-family support does not prove a geological boundary. GR is
corroborating context, not a resistivity input. No ZG is available for VB-5 H T5
or VC-2 Y3H, and reports explicitly flag this absence. Signed geosignals, boundary
horns, anisotropy, invasion, tool motion or operational changes can produce
ambiguous responses. The detector does not establish a cause or lateral boundary
distance. It requires samples ahead of the candidate, so it is not a real-time alarm.

## Geological calibration

Without rules, every geological interval is `unknown`; measured candidates still
appear. Resistivity alone cannot establish shale, reservoir chalk or fluid types.
Supply `--rules path-to-rules.json` to apply your calibrated criteria. For example,
the following is **synthetic syntax only, not Ekofisk lithology calibration**:

```json
{
  "reference": "Synthetic example only; replace with reviewed reference picks",
  "rules": [
    {"label": "example_low_GR", "conditions": [
      {"curve": "GR", "unit": "gAPI", "max": 30}
    ]},
    {"label": "example_high_GR", "conditions": [
      {"curve": "GR", "unit": "gAPI", "min": 80}
    ]}
  ]
}
```

Conditions are ANDed, with inclusive finite `min` and/or `max` bounds in stored
units. Rules require a provenance/reference string. No match or missing input
means unknown (missing curves produce warnings); multiple matching rules mean
ambiguous. Wrong units or nonscalar inputs raise an error. Class changes are
reported separately as `geological_events` only where two adjacent known classes
each persist for at least one comparison window, without a depth gap.
Rule-derived labels are not independently validated.

To calibrate, provide reviewed formation/lithology intervals with well/run,
MD reference, units and class, then assess transition depth errors, false alarms
and missed boundaries on held-out wells. No such reference labels are currently
provided, so field accuracy and geological classification performance remain unknown.
