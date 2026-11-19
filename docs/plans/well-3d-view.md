---
title: 3D well view of one QC curve
slug: well-3d-view
status: implemented on branch (2026-11-19: option A three.js + R3F v9 + drei; steps 1-9 done, step 10 ship pending)
owner: Ove
created: 2026-11-19
traceability: false
branch: feature/well-3d-view (from main 7fbc8ca)
---

# 3D well view of one QC curve

## Goal

Add a new **3D well** tab that shows one curve picked from the QC selection tab. The curve is drawn
along the real well path in 3D, using the same colours as the QC tab. You can travel down the well,
step forward and back, and zoom in and out.

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
8. Vertical exaggeration and tube radius can be adjusted (defaults 1× and 3 m) so thin or flat
   sections stay visible.
9. Null values are shown as grey gaps, not as zero.
10. `npm run lint`, `npm run build` and `npm run check:udar` pass, and `pytest backend/tests` passes,
    including the new endpoint tests.

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
10. **Ship.**
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

- **Colour helper:** the backend computes the colour spec (scale, reverse, log10, zmin, zmax) and the frontend only maps values with `components/well3d/colormap.js`. `CurveTrackPlot.jsx` is unchanged, so the QC tab output cannot drift; `npm run check:colormap` guards the copied Plotly stops.
- **Colouring:** scalar and image curves both use a `DataTexture` (one row per sample, nearest filtering), so colours change per sample like the QC heatmap instead of blending between samples.
- **Nulls:** dark grey `rgb(80,80,80)`, because the RdBu midpoint is already a light grey (190) and a null must not read as a zero geosignal.
- **Image wrap (step 9):** done. Assumption: bin 1 is centred on the high side (top of hole) and bins run clockwise looking down-hole, 11.25° each. On vertical sections the high side falls back to north. Not yet checked against a known feature in the data.
- **Camera:** the tab opens in **Free** with the whole well fitted (looking across the well from 30° above). **Reset view** fits the whole well and switches to Free. **Follow** starts at 25 × tube radius behind the travel point.
- **Labels:** depth ticks and the north arrow label are screen-sized sprites, not drei `Html`, which logged React root unmount errors.
- **QC action:** a **3D** link next to each curve name in the QC table, and a click on a chip in the selection summary.
- **Known console warning:** `THREE.Clock: This module has been deprecated` comes from R3F 9.8 with three 0.187; it is a warning, not an error.
