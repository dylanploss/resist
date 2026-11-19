---
title: 3D well view of one QC curve
slug: well-3d-view
status: implemented and merged to main (PR #6, 74b3f70, 2026-11-19); steps 1-11, criteria 12-13 and ideas A-G done
owner: Ove
created: 2026-11-19
traceability: false
branch: feature/well-3d-view (from main 7fbc8ca)
---

# 3D well view of one QC curve

## Goal

Add a new **3D well** tab that shows one curve picked from the QC selection tab. The curve is drawn
along the real well path in 3D, using the same colours as the QC tab. The tube radius shows the
curve's depth of investigation (DOI) from the QC tab, so a deep-reading curve draws a thicker tube
than a shallow one and the view shows the volume around the well that the curve actually senses.
You can travel down the well, step forward and back, and zoom in and out.

## What the data gives us (checked on the running backend)

Every DLIS run has a full well path per depth sample, so no trajectory has to be invented:

| Channel | Unit | Use |
|---------|------|-----|
| `DEPT` | ft | Measured depth (MD), the travel axis |
| `TVD` / `TVDSS` | ft | Vertical position |
| `INC`, `AZI` | deg | Inclination and azimuth (fallback path by minimum curvature) |
| `UTMX`, `UTMY` | m | Easting and northing (ED50 / UTM 31N) |

The QC tab colours the curves as follows, from `CurveTrackPlot.jsx` and `api.js`. The 3D view reuses
these rules:

| Curve type | QC tab colour | 3D view colour |
|------------|---------------|----------------|
| Resistivity (`ohmm`) | Plotly **Jet** on log10(value), range clipped to the 2nd–98th percentile | Same Jet scale and clip, along the well |
| Geosignal (signed) | Plotly **RdBu**, reversed, symmetric ±98th percentile of the absolute value | Same |
| Curve status | `STATUS` colours (auto-pick, candidate, duplicate, rejected) | Curve name label and legend border |
| Azimuthal image (32 bins) | Jet or RdBu heatmap | Phase 2: wrapped around the tube, one bin per 11.25° |

## 3D tool research (summary)

| Option | Fit | Notes |
|--------|-----|-------|
| **three.js + React Three Fiber v9 + drei** (recommended) | Good | R3F v9 is built for React 19, which we run. A `TubeGeometry` along a `CatmullRomCurve3` with per-vertex colours draws the coloured well. drei's `CameraControls` gives smooth dolly (zoom) and `setLookAt` transitions for travelling down the well. Full control over the fly-through. Adds about 200 kB gzipped (three, fiber, drei), loaded only when the tab is opened. |
| Plotly `scatter3d` (already installed) | Fallback or MVP | No new dependencies. A `line.color` array with `colorscale: 'Jet'` gives identical colours. But travelling down the well means changing `scene.camera.eye` step by step, which is jumpy. It draws a line, not a tube, and can't do the image wrap. |
| Equinor **videx-3d** | Later | Built for subsurface work on R3F (well paths, casings, formations, horizons), but it needs a data store, a generator registry and Comlink worker wiring. That is overkill for one curve; consider it when we show several wells or horizons. |
| vtk.js | No | Scientific and powerful, but heavy and imperative, with a poor React fit. |
| deck.gl | No | Map-oriented. `PathLayer` works, but a first-person fly-through is awkward. |
| CesiumJS | No | A globe engine, which is the wrong scale for a well interval. |

Sources: [equinor/videx-3d](https://github.com/equinor/videx-3d),
[React Three Fiber v9 (React 19)](https://github.com/pmndrs/react-three-fiber),
[R3F v9 migration guide](https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide).

**Decision requested:** three.js + R3F v9 + drei. It is the only option that gives a smooth
travel-down-the-well camera and a coloured tube, and that can later wrap the 32-bin image.

## Out of scope

- Several curves at once, several wells, horizons or formations (videx-3d territory, later).
- Inversion results in 3D (waits for the 1D/2D inversion work).
- Changing QC logic or colours. The 3D view only reads them.

## Acceptance criteria

1. A new **3D well** tab appears after QC selection. It loads only when opened, so the main bundle
   does not grow.
2. Each row of the QC selection table has a **View in 3D** action. It opens the 3D tab with that run
   and curve. The 3D tab also has its own run and curve pickers, defaulting to the QC-selected curves.
3. The well is drawn along its real path from `UTMX`, `UTMY` and `TVD`, relative to the first
   sample. If `UTMX` or `UTMY` are missing, the path is computed from `INC` and `AZI` by minimum
   curvature.
4. The curve colour along the well uses the same colour scale, log transform and percentile clip as
   the QC tab, and a matching colour bar is shown.
5. Travel controls:
   - **Forward** and **Back** buttons move the camera along the well by a step (default 50 ft; step
     size selectable).
   - An **MD slider** jumps to any depth.
   - **Play** and **Pause** travel at an adjustable speed.
   - The current MD, TVD and curve value are shown.
6. Zoom controls: **Zoom in** and **Zoom out** buttons and the mouse wheel change the camera distance.
   **Reset view** fits the whole well. **Follow** keeps the camera behind the travel point, looking
   down the well; **Free** allows orbiting.
7. Keyboard: ↑/↓ move forward/back, +/− zoom, space play/pause.
8. Vertical exaggeration can be adjusted (default 1×) so thin or flat sections stay visible.
   The tube radius comes from the curve's QC DOI (see criterion 11), not a fixed 3 m default.
9. Null values are shown as grey gaps, not as zero.
10. `npm run lint`, `npm run build` and `npm run check:udar` pass, and `pytest backend/tests` passes,
    including the new endpoint tests.
11. **DOI-scaled tube (change request, 2026-11-19).**
    - The tube radius uses the same DOI that the QC tab shows for the curve: `doi_index` and
      `doi_tier` from `backend/qc/metrics.doi_index`, for the same spacing, frequency and
      measurement.
    - A deeper-reading curve draws a proportionally thicker tube. Switching the curve changes the
      radius.
    - The panel shows the DOI index, its tier (shallow, medium, deep) and the radius in metres.
    - **Constraint:** `doi_index` is a relative ordering heuristic, where 1.0 is the 16 in 2 MHz
      phase curve. `metrics.py` says it is *"not a reach in inches"*. The conversion from index to
      metres must be one named constant, and the UI must label the radius as an estimate. Do not
      present it as a measured reach. Where the constant comes from must be recorded in the
      implementation notes.
    - Curves without a DOI (non-ADR channels) fall back to a fixed radius, and the UI says so.
12. **Irregular DOI tube (change request, 2026-11-19 13:06).** The tube radius varies sample by
    sample with the actual depth of investigation, which depends on the local formation
    resistivity, so the tube swells in resistive zones and narrows in conductive ones. It replaces
    the constant radius per curve from criterion 11. The panel shows the DOI at the travel point,
    labelled as an estimate.
13. **Directional DOI tube (change request, 2026-11-19 13:18).** The tube must not get wider all
    the way round. It grows only on the side where the colour turns red (more resistive). For
    azimuthal images each of the 32 bins gets its own reach from its own resistivity, so the ring
    bulges toward the resistive bins and stays narrow toward the conductive ones. A redder bin
    never gets a smaller radius than a bluer bin in the same ring.

## Approach

- **Backend:** one new endpoint, `GET /runs/{run}/well3d?curve=<name>&max_points=4000`. It returns
  aligned arrays: `md_ft`, `tvd_ft`, `x_m`, `y_m`, `z_m`, `inc_deg`, `azi_deg`, and `values`. Image
  curves also return `bins`. The response also carries the `unit`, the `color` spec (scale name,
  log flag, zmin and zmax, computed exactly as the QC tab does), and `status`. It reuses the shared
  run cache in `backend/services/runs.py` and the down-sampling used by the existing curve endpoint.
- **Frontend:**
  - A new lazy-loaded `pages/Well3dPage.jsx` holds the controls.
  - `components/well3d/WellScene.jsx` holds the R3F `<Canvas>`, the tube mesh with per-vertex
    colours, a marker ring at the travel point, a depth-tick axis and a north arrow.
  - `components/well3d/colormap.js` builds the Jet and RdBu lookups from Plotly's own colorscale
    stops, so the colours match.
  - `components/well3d/useTravel.js` holds the camera state machine (follow or free; step, play and
    zoom), built on drei `CameraControls`.
  - The selected run and curve are shared between QC and 3D through a small `SelectionContext` in
    `App.jsx`, plus a `?tab=3d&run=&curve=` query so a view can be bookmarked.
- **Phase 2 (if time allows):** wrap 32-bin azimuthal images around the tube with a `DataTexture`,
  so the borehole image reads directly in 3D.

## Steps

1. **Backend: well path and endpoint.**
   - Files: `backend/services/well3d.py` (new), `backend/qc/api.py` or `backend/app.py` (route),
     `backend/tests/test_well3d.py` (new), `docs/api/contract.md`.
   - Verify: `pytest backend/tests -q`. Tests cover the response shape, the colour spec matching
     the QC percentile clip, the minimum-curvature fallback against `UTMX`/`UTMY` (within a few
     metres), a 404 for an unknown run or curve, and 422 for bad `max_points`.
2. **Frontend dependencies.**
   - Add `three`, `@react-three/fiber@^9` and `@react-three/drei` to `frontend/package.json`.
   - Verify: `npm install` and `npm run build`. Three.js must land only in the 3D chunk.
3. **Colour map parity.**
   - Files: `components/well3d/colormap.js`.
   - Verify: a small Node check (`frontend/scripts/check-colormap.mjs`, `npm run check:colormap`)
     compares sampled colours with Plotly's Jet and RdBu stops.
4. **Scene.**
   - Build `WellScene.jsx` (tube, colours, marker, axes, colour bar overlay).
   - Verify: the tab renders the VC-2 run (the smallest) with no console errors.
5. **Travel and zoom controls.**
   - Build `useTravel.js` and the control bar on `Well3dPage.jsx` (Forward/Back, step size, MD
     slider, Play/Pause and speed, Zoom in/out, Reset, Follow/Free, exaggeration, radius,
     keyboard).
   - Verify: a manual check in the browser.
6. **Hook up the QC tab.**
   - Add the **View in 3D** action in `QcTable.jsx` and `SelectionSummary.jsx`, the
     `SelectionContext`, and the new tab in `App.jsx`.
   - Verify: clicking a QC row opens the 3D tab on the same run and curve.
7. **Docs.**
   - `SETUP.md` (no new setup beyond `npm install`), `README.md` (the tab list), and
     `docs/api/contract.md`.
8. **Verification pass.**
   - Run lint, build, `check:udar`, `check:colormap` and `pytest backend/tests`.
   - Do a headless-Chrome smoke test: open the 3D tab, step forward, zoom and play, and check the
     console has no errors.
9. **Phase 2 (optional): image wrap.**
   - `DataTexture` from the 32 bins. Verify that the Top/Bottom bins sit where the QC heatmap puts
     them.
10. **DOI-scaled tube (change request).**
    - Return `doi_index` and `doi_tier` in the `well3d` response, reusing `metrics.doi_index`.
    - Derive the radius in `Well3dPage.jsx` from the DOI, and keep the depth ticks, the marker
      ring and the follow distance proportional to it.
    - Update `docs/api/contract.md` and the implementation notes.
    - Verify: `pytest backend/tests` includes a test that a deeper curve returns a larger
      `doi_index`. A browser check confirms that a deep ZG curve draws a visibly thicker tube than
      a shallow AR curve.
11. **Ship.**
    - Commit per step (conventional messages and the Co-authored-by trailer).
    - Push `feature/well-3d-view` as `OveQ` and open a draft PR. Merge after your review.

## Validation strategy

- **Unit (backend):**
  - Shape of the `well3d` response.
  - Path accuracy: the minimum-curvature result against `UTMX`/`UTMY`.
  - Colour spec matches `CurveTrackPlot` (2nd/98th percentiles).
  - Errors (404, 422).
- **Unit (frontend):** the `check:colormap` script compares colours with Plotly.
- **Manual:**
  - Open from QC; check the colours match the QC track; travel forward and back.
  - Zoom in and out; reset; play and pause.
  - Check the nulls render as grey.
  - Check a long run (Z-19, about 1,770 m) stays smooth (target 60 fps at about 4,000 points).
- **Not run locally:** the full UDAR `test_fd_pipeline` (unrelated, over 10 minutes).

## Integration touchpoints

- **Dylan's QC components:** `QcTable.jsx` and `SelectionSummary.jsx` get one extra action. No logic
  changes. The colour rules live in `CurveTrackPlot.jsx`; I'll extract them into a shared helper so
  both views use one source.
- **Backend run cache:** shared with `/curves` and QC. The `well3d` endpoint reads `DEPT`, `TVD`,
  `INC`, `AZI`, `UTMX`, `UTMY` and one curve.
- **`docs/api/contract.md`:** new endpoint row.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Colours drift from the QC tab | Medium | Confusing comparison | Shared colour helper plus the `check:colormap` script |
| `UTMX`/`UTMY` per-sample values are null or constant in some runs | Medium | Flat or broken path | Minimum-curvature fallback from `INC`/`AZI`, plus a test |
| Horizontal sections look flat at 1× | High | Hard to see | Exaggeration slider; follow-camera travels along the well |
| Bundle size (three, fiber, drei) | Low | Slower first load | Lazy tab chunk; nothing added to the main bundle |
| Editing Dylan's QC components causes conflicts | Medium | Merge pain | Minimal additive change (one action), and merge `main` before the PR |
| R3F v9 or drei API changes | Low | Build breaks | Pin versions in `package.json` and `package-lock.json` |
| GPU or WebGL missing on a laptop | Low | Blank tab | WebGL check with a clear message |

## Rollback

Every step is a separate commit on `feature/well-3d-view`. Revert the PR, or drop the tab and the
endpoint. Nothing else depends on them.

## Decisions needed from you

1. **3D library:**
   - **A. three.js + R3F v9 + drei** (recommended).
   - **B. Plotly 3D only** (no new dependencies, less smooth).
   - **C. Equinor videx-3d** (more setup; better for many wells later).
2. **Forward/back meaning:** I read it as two control sets. Forward/Back steps along the well
   (travel), and Zoom in/out changes camera distance. Say if you meant only one of them.
3. **Phase 2 image wrap:** include it now, or after the MVP?
4. **Approval:** approve this plan to start implementation with subagents on `feature/well-3d-view`.

## Implementation notes (deviations from the plan)

- **Inversion layers (ideas A + B):** done on `feature/well3d-inversion-layers`.
  - Backend: `GET /inversion/jobs?run=` lists the run's finished jobs (newest first, no result payload). `GET /inversion/jobs/{id}/layers` returns the boundary geometry (`backend/inversion/layers.py`): the plane normal in NED (`LayerModel.normal`), and per boundary and station the TVD, `above`, and the perpendicular distance `|TVD_well − TVD_boundary| · cos(dip)`, plus the nearest boundary per station. Tests: `backend/tests/test_inversion_layers.py`.
  - Frontend (`components/well3d/inversionLayers.js`, `InversionLayers.jsx`, `LayersControl.jsx`): the 3D tab refreshes the job list when it becomes active and shows the newest job (an **Inversion** picker switches; an **Inversion layers** switch hides them). With no job: *Inversion layers: run an inversion on the Inversion tab*. The Inversion page is unchanged.
  - Each boundary is a semi-transparent ribbon over the inverted interval: at each station it sits vertically above/below the well at the boundary TVD, and extends ±2 × the tube radius (max DOI × tube scale) sideways, horizontal and perpendicular to the well, tilted into the dipping plane. Vertical exaggeration applies. Colour = Rh of the layer below, on the tube's Jet log scale when the curve is a resistivity (else Jet over the layer Rh range); swatches next to the picker.
  - B: a station is *seen* when the nearest boundary is closer than the shown curve's DOI there (per-bin DOI: high-side bin for a boundary above, low-side bin for one below). Seen sections get a magenta glow around the tube; a line joins the travel point to the nearest boundary; the panel reads *Nearest boundary ≈ X m above/below (boundary k) · seen/not seen (DOI Y m)*.
  - Assumptions: the boundary is placed vertically from the well at each station (the inversion's own convention); the DOI is an estimate (see criterion 12), so *seen* is indicative. Jobs live in memory, so a backend restart empties the list. Screenshot: `docs/screenshots/well3d-layers.png` (VC-2, 17202–17322 ft, 3 layers, 5× exaggeration).
  - Also fixed: `WellScene` returned `false` from a `useEffect` in Follow mode when the path changed (React console error).

- **Colour helper:** the backend computes the colour spec (scale, reverse, log10, zmin, zmax) and the frontend only maps values with `components/well3d/colormap.js`. `CurveTrackPlot.jsx` is unchanged, so the QC tab output cannot drift; `npm run check:colormap` guards the copied Plotly stops.
- **Colouring:** scalar and image curves both use a `DataTexture` (one row per sample, nearest filtering), so colours change per sample like the QC heatmap instead of blending between samples.
- **Nulls:** dark grey `rgb(80,80,80)`, because the RdBu midpoint is already a light grey (190) and a null must not read as a zero geosignal.
- **Image wrap (step 9):** done. Assumption: bin 1 is centred on the high side (top of hole) and bins run clockwise looking down-hole, 11.25° each. On vertical sections the high side falls back to north. Not yet checked against a known feature in the data.
- **Camera:** the tab opens in **Free** with the whole well fitted (looking across the well from 30° above). **Reset view** fits the whole well and switches to Free. **Follow** starts at 25 × tube radius behind the travel point.
- **Labels:** depth ticks and the north arrow label are screen-sized sprites, not drei `Html`, which logged React root unmount errors.
- **QC action:** a **3D** link next to each curve name in the QC table, and a click on a chip in the selection summary.
- **Known console warning:** `THREE.Clock: This module has been deprecated` comes from R3F 9.8 with three 0.187; it is a warning, not an error.
- **Compare with + directional ZG (ideas C + F):** done on `feature/well3d-dual-tube`.
  - **C:** a **Compare with** picker (default None; the first entry is the QC auto-pick with the opposite DOI tier) fetches a second `/well3d` response with the same `max_points`, so the samples line up (checked; a warning shows if they do not). The curve with the lower QC `doi_index` (then median `doi_m`) is the solid inner tube; the other is a transparent shell (opacity 0.35, `depthWrite` false, drawn after the inner tube), each with its own colours, radii and colour bar. The panel adds one line per curve with value, DOI here and tier. Ticks, marker and camera use the larger radius. Code: `components/well3d/{compare.js,useCompare.js,Compare.jsx,ShellTube.jsx}`; `WellScene` takes an optional `shell`. Without a comparison the tab behaves as before.
  - **F:** a ZG image takes its per-bin DOI shape from a ZR image (`well3d._geosignal_image_source`): same frequency, closest spacing, then same measurement (ZGL112A → ZRL82A, ZGL112P → ZRL82P); else the deepest ZR image; else the old round ring from the deepest AR curve. The reach uses the geosignal's own frequency and spacing; `doi_source` names the ZR image. Assumption: the resistivity image at the nearest spacing is a fair proxy for where the geosignal reads deeper. On Z-19 ZGL112A reaches 2.8–6.2 m.
- **Directional DOI tube (criterion 13):** done on `feature/well3d-directional-doi`.
  - For 32-bin ZR images, `doi_m` holds one value per bin (`well3d.doi_profile`). Ring vertex k sits on the centre of bin k, where the texture also centres it, so each bulge lines up with its colour.
  - The resistivity uses the same 2nd–98th percentile clip as the colour scale, and the saturation mask was dropped. It had refilled tool-limit bins (the reddest) with the ring mean, which made red bins narrower. A test checks that a redder bin never has a smaller radius in the same ring.
  - On Z-19 ZRL48A the radius varies by 0.5–1 m around each ring (10th–90th percentile), on a reach of about 2.6–4.3 m.
  - Single-value curves (AR, ZR quadrants) are one colour all round, so their rings stay round and only change size along the well. ZG geosignals have no resistivity per bin, so they keep a round ring sized from the run's deep AR curve.
- **Irregular DOI tube (criterion 12):** done; this replaces the constant `METRES_PER_DOI` radius from step 10.
  - The backend returns `doi_m`, with one value per sample (`well3d.doi_metres`): skin depth `δ = 503.3·√(ρ/f)` in the local resistivity, softly capped at `DOI_CAP_SPACINGS = 3` transmitter–receiver spacings (`1/doi² = 1/δ² + 1/cap²`), and × 1.5 for attenuation, the same factor the QC index uses.
  - `ρ` is the curve itself for AR/ZR (the mean of the bins for images). For ZG it is the run's deepest AR resistivity (`doi_source`). Saturated samples are masked, the rest are clipped to the 2nd–98th percentile, and gaps are interpolated.
  - **Assumptions:** skin depth as the reach and the 3-spacing cap are physics-based approximations, not vendor DOI figures or an inversion result. The soft cap was chosen over `min(δ, cap)` because the hard cap flattened deep curves in resistive chalk.
  - Example ranges: Z-19 ARL48A 2.5–4.1 m, ARH16P 0.45–0.82 m. On VC-2 the 125 kHz curves sit near their 5.5 m limit through most of the run, because the chalk there is very resistive.
  - The tube has one ring per sample at that sample's radius (`buildTube` takes a number or one radius per sample). The ticks, marker ring and camera use the largest radius. The panel shows `DOI here ≈ … m (estimate, from <curve>)`, the run's min–max and the QC index. **Tube scale** multiplies every radius.
- **DOI-scaled tube (step 10, superseded by criterion 12):** done. The backend returns the QC `doi_index`/`doi_tier` (reusing `metrics.doi_index` and `selection.doi_tier`); the frontend sets tube radius = `doi_index × METRES_PER_DOI` (`Well3dPage.jsx`). Ticks, marker ring, follow distance and min zoom distance stay proportional (`WellScene.jsx`, unchanged).
  - **`METRES_PER_DOI = 0.5` is an assumption, not a calibration.** `doi_index` is a relative ordering heuristic (*"not a reach in inches"*), and the dossier gives no absolute reach. 0.5 m per unit was chosen so the 1.0 reference (16 in 2 MHz phase) draws a 0.5 m radius and the deepest index in the data (112 in 125 kHz attenuation, 42) draws 21 m, keeping the range at the tens-of-metres scale of deep directional resistivity while preserving the QC ordering linearly. Replace it with tool-specific DOI figures if the vendor provides them.
  - The panel labels the radius as an estimate (`DOI index … (tier) · tube radius ≈ … m (estimate)`). Non-ADR curves (`doi_index` null) draw a fixed 3 m radius (`FALLBACK_RADIUS_M`, the old default) and the panel says *No DOI (non-ADR curve)*.
  - The fixed **Tube radius** picker is replaced by a **Tube scale** multiplier (1, 2, 5, 10×, default 1×) so a thin shallow tube can be enlarged for visibility on long wells without losing the DOI proportions between curves; the panel shows the scale when it is above 1×.
- **Field view (idea D):** done on `feature/well3d-field-view`.
  - A **Single well / Field** toggle on the 3D well tab. Field draws every run from `GET /field` (`backend/services/field.py`, 300 points per run) at its UTM position, relative to the centre of the field, coloured by the run's deepest AR resistivity on one log10 Jet scale for all runs.
  - Hover highlights a well (thicker tube, red label, others fade) and shows its MD range; a click without dragging selects that run in the shared selection and switches to Single well. Vertical exaggeration (default 5×), north arrow and scale bar; the camera looks across the field's long axis from 36° off vertical.
  - Wells logged in two runs (Z-25) are labelled with their MD range. Labels of nearby wells can overlap; hover shows the name.
  - Screenshot: `docs/screenshots/well3d-field.png`.

- **Demo fly-through and PNG export (ideas E + G):** done on `feature/well3d-demo-mode`.
  - **★ Demo** (`useDemo.js`, `demoScript.js`, `DemoCaption.jsx`) fits the whole well, switches to Follow, travels down at about well length / 25 s (50–1000 ft/s) and pauses 2.5 s at each stop with a caption, then returns to the overview.
  - Stops are computed from the data: the most resistive and most conductive zone (log10 values clipped to the colour range, 2 % moving mean, first and last 3 % skipped), the largest DOI spread around the ring for image curves, and TD. Stops closer than 3 % of the well are merged. Non-resistivity curves say "Highest/Lowest value".
  - **Stop demo**, Escape, a run/curve change, leaving the tab or any manual travel (space, arrows, slider) ends the demo and hands control back. While it runs, the demo overrides only the travel speed and end MD.
  - **Save PNG** (`useSnapshot.js`) downloads `<run>_<curve>_<md>ft.png`: the WebGL canvas plus a run · curve · MD label. HTML overlays (readout, colour bar, caption) are not in the PNG. `window.__well3dSnapshot()` returns the same PNG as a data URL while the tab is active. The canvas now uses `preserveDrawingBuffer: true`.
  - Screenshot: `docs/screenshots/well3d-demo.png` (Z-19 ZRL48A, conductive-zone stop).
