# Resist Platform Interface Contract

Status: draft v0.1. Changes go through this file, and consumers update in the same commit.

## Decisions

| Topic | Decision | Status |
|-------|----------|--------|
| Backend framework | FastAPI (Python), uvicorn server | Decided |
| Frontend | Vite + React (JavaScript) | Decided |
| Frontend layout library | Material UI (`@mui/material`, with `@emotion/react` and `@emotion/styled`) | Decided |
| CORS | Backend allows `http://localhost:5173` and `http://127.0.0.1:5173` | Decided |
| Default backend port | 5000, set by `RESIST_BACKEND_PORT` | Fixed |
| Default frontend port | 5173 (Vite default) | Fixed |

## Curve table (David → Dylan, Ove)

One row per depth sample per curve. Produced by the loader in `backend/data/loader.py`.

| Column | Type | Meaning |
|--------|------|---------|
| `well` | string | Well identifier from the DLIS file name |
| `curve` | string | Curve mnemonic as stored in the DLIS file |
| `unit` | string | Unit as stored in the DLIS file |
| `depth_ref` | string | Depth reference (for example `MD`) |
| `depth_m` | float | Depth in metres |
| `value` | float or null | Curve value; null where the file null value is found |

Curve metadata table, one row per curve:

| Column | Type | Meaning |
|--------|------|---------|
| `curve` | string | Mnemonic |
| `unit` | string | Unit |
| `null_value` | float | Null sentinel from the file |
| `description` | string | Long name from the file, or empty |

## QC selection JSON (Dylan → Ove)

Returned by `POST /qc/select`, one result per run. Produced by `backend/qc/selection.py`.

```json
{
  "well": "2/4-Z-6",
  "run": "2_4-Z-6_16954-20950ft_RES_GEOSIGNAL",
  "selected": ["ARM66P", "ZGM80P", "..."],
  "selected_reasons": {"ARM66P": "best clean deep AR curve"},
  "rejected": [{"curve": "GR", "reason": "no resistivity or geosignal information"}],
  "scores": {"ARM66P": {"score": 0.31, "coverage": 1.0, "noise": 0.52, "range_ok": true,
                        "quality": 0.48, "doi_index": 8.25, "doi_tier": "deep", "...": "..."}},
  "warnings": ["no usable deep ZG curve in this run"]
}
```

Rules:
- `selected` has 5 to 10 entries (default 8); fewer only with a warning.
- Every curve in the inventory appears in exactly one of `selected` or `rejected`.
- `scores` covers every curve in the inventory. `noise` is jaggedness: below 0.5 smooth, 1 white noise.
- `warnings` lists noisy curves kept as deep fallbacks and depth tiers with no usable curve.

## Endpoints

Implemented in `backend/app.py` (data and QC), `backend/qc/api.py` (QC visualization router) and `backend/inversion/api.py` (inversion router), both included by `app.py`. A run id is the DLIS file name without `.dlis`, for example `2_4-Z-6_16954-20950ft_RES_GEOSIGNAL`. Runs are read from `DATA_DIR` (default `<repo>/data`). A run is parsed on first use and cached for the life of the process; both modules share that cache.

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/health` | none | `{"status": "ok"}` |
| GET | `/runs` | none | `{"runs": [{"run", "label", "file", "well", "depth_min_m", "depth_max_m"}]}` |
| GET | `/curves` | query `run` (required) | `{"run", "well", "curves": [<curve metadata rows>]}` |
| GET | `/curves/{run}/data` | query `curves=A,B` (required) | `{"run", "well", "depth_m": [..], "curves": {"A": {"unit", "bins", "values": [..]}}}` |
| POST | `/qc/select` | `{"run": "<id>", "n_select": 8}` | QC selection JSON above |
| GET | `/runs/{run}/qc` | query `n_select` (default 8) | QC selection JSON above for that run |
| GET | `/runs/{run}/curves/{name}` | query `start_ft`, `end_ft`, `max_points` (default 1500, 50 to 20000) | `{"run", "curve", "unit", "family", "image", "stride", "md_ft", "values"}` |
| GET | `/runs/{run}/well3d` | query `curve` (required), `start_ft`, `end_ft`, `max_points` (default 4000, 100 to 20000) | `{"run", "well", "curve", "unit", "image", "bins", "stride", "path_source", "origin", "color", "doi_index", "doi_tier", "doi_m", "doi_source", "md_ft", "tvd_ft", "inc_deg", "azi_deg", "x_m", "y_m", "z_m", "values"}` |
| POST | `/runs/{run}/selection` | `{"curves": [..], "n_select": 8}` | Saved selection record |
| GET | `/runs/{run}/selection` | none | Saved selection record (404 if none saved) |
| GET | `/inversion/defaults` | query `run` | `{"run", "md_min_ft", "md_max_ft", "reason", "channels", "max_stations", "max_interval_ft"}` |
| POST | `/inversion/plan` | inversion request (below) | `{"used": [..], "ignored": [{"curve", "reason"}], "calibration", "warnings", "estimated_stations"}` |
| POST | `/inversion/jobs` | inversion request (below) | Job: `{"id", "run", "status", "progress", "message", "request", "plan", "error", "elapsed_s", "result"}` |
| GET | `/inversion/jobs/{id}` | none | Job; `result` is set when `status` is `done` |

Details:
- `/runs` reads only DLIS headers. `label` is the run id without `_RES_GEOSIGNAL`. `well` and the depth range are null if the header is unreadable, and the entry then has an `error` field.
- `/curves` rows contain the four metadata columns above plus the loader columns `well`, `run`, `depth_ref`, `sample_count`, `bins`, `depth_min_m`, `depth_max_m`, `valid_fraction`, `nonpositive_count`, and the mnemonic fields from `measurement_metadata`: `family` (`AR`, `ZR`, `ZG` or `conventional`), `frequency_hz`, `spacing_in`, `measurement`, `suffix`, `geometry_status`. Mnemonic fields are null for conventional curves.
- `/curves/{run}/data` returns one value per depth for scalar curves (`bins` 1) and a list of 32 bin values per depth for image curves (`bins` 32). Null-sentinel and non-finite samples are `null`.
- `/qc/select` and `/runs/{run}/qc`: `n_select` defaults to 8 and must be within 5 to 10.
- `/runs/{run}/curves/{name}` returns every `stride`th sample (thinned, not averaged) between `start_ft` and `end_ft`; images are returned as 32 bins x depth.
- `/runs/{run}/well3d` returns one curve along the well path for the 3D view. All per-sample arrays have the same length and are thinned like `/runs/{run}/curves/{name}`.
  - `x_m`, `y_m`, `z_m` are east, north and up in metres, relative to the first returned sample. `origin` holds that sample's absolute `utmx`, `utmy` (m, ED50 UTM 31N) and `tvd_m` (below RKB); a field is null when its channel is missing.
  - `path_source` is `utm` when the path comes from `UTMX`, `UTMY` and `TVD`, and `min_curvature` when `UTMX`/`UTMY` are missing, all null or constant, so the path is integrated from `INC` and `AZI` over MD. Trajectory nulls are filled linearly between valid samples; samples outside the valid trajectory span are dropped.
  - `values` has one value per sample, or for image curves (`image` true, `bins` 32) one row of 32 bin values per sample (depth x bins, unlike `/curves/{name}`). Nulls are `null`.
  - `color` is the QC tab heatmap scale, computed over the full curve (not the window or the thinned samples): `{"scale", "reverse", "log10", "zmin", "zmax"}`. Unit `ohmm`: `Jet`, `log10` true, `zmin`/`zmax` the 2nd/98th percentile of log10 of positive values. Other units: `RdBu`, `reverse` true, `zmin`/`zmax` = -/+ the 98th percentile of absolute values (1 if that is 0). Percentile p is the sorted finite value at index floor(p x (n - 1)). `zmin`/`zmax` are in log10 units when `log10` is true.
  - `doi_index` and `doi_tier` are the QC tab depth of investigation for the curve (`backend/qc/metrics.doi_index` on its spacing, frequency and measurement; tier shallow <= 2, medium <= 8, else deep). `doi_index` is relative (1.0 = 16 in 2 MHz phase), not a reach. Both are null for non-ADR channels (not AR, ZR or ZG).
  - `doi_m` is an estimated radial reach in metres, aligned with `md_ft`: one value per sample, or for azimuthal resistivity images (`image` true, ZR) a row of one value per bin, computed from that bin's resistivity so the reach grows only on the resistive (red) side. Each value is the skin depth `503.3·sqrt(rho/f)` in the local resistivity, softly capped at 3 transmitter-receiver spacings (`1/doi² = 1/skin² + 1/cap²`), times 1.5 for attenuation. `rho` is the curve itself for AR/ZR, else the run's deepest AR resistivity with at least 50 % valid samples. Values are clipped to the same 2nd–98th percentile as the colour scale (so a redder bin never reads shallower); missing samples are interpolated and missing bins take their ring's mean. `doi_source` names that resistivity curve. Both are null for non-ADR channels. An approximation for display, not an inversion result.
- `/runs/{run}/selection` saves `backend/output/selections/{run}.json` (override with `RESIST_SELECTION_DIR`) with `curves`, `auto_selected`, `added`, `removed` and `overridden_rejections`.
- Inversion request: `{"run", "curves": [QC-selected names], "md_min_ft", "md_max_ft", "step_ft": 4, "layers": 3, "calibration": true, "quick": false}`. The interval is at most 1500 ft and 250 stations.
- The inversion plan maps the QC selection onto the 1.5D forward model (`backend/inversion/service.py`). Each `used` entry has `curve`, `label`, `kind` (`avg`, `top`, `bottom`, `geosignal`), `source`, `measurement`, `weight` and `correction`.
  - `AR` curves are used as averages; a `C` curve uses the vendor-corrected data.
  - A `ZR` image at 16/32/48 in contributes its top and bottom quadrants, extracted from the image as 90° sectors (`backend/data/quadrants.py`) in every run. Selecting `ZR..T`/`ZR..B` directly uses the image sector, or the delivered curve when the run lacks the image.
  - A `ZG` image contributes its top quadrant sector.
  - Phase has weight 1. With `calibration` on, 2 MHz attenuation (averaged and top/bottom) has weight 0.5 and the Z-20 resistivity-dependent correction, and 500/125 kHz attenuation has weight 0.25.
  - Left/right bins, `ZR` 50/66/82 in images and conventional curves are listed under `ignored` with a reason.
  - `azimuthal` is true when directional channels are used.
- Jobs run one at a time in a background thread (status `queued` → `running` → `done` or `error`). Jobs are kept in memory only. `result` holds:
  - `md_ft`, `tvd_ft` and `inclination_deg`.
  - `curves`: one entry per channel with `label`, `group`, `kind`, `unit` (`ohm.m`, `deg`, `dB`), `source`, `obs`, `pred`, `used`, `weight`, `sigma`, `rms`, `rms_percent` (resistivities), `rms_normalised` and `mean_residual_percent`.
  - `model`: `layers` with `rh`, `rv`, `top_tvd_ft` and `bottom_tvd_ft`; `dip_deg`; `dip_azimuth_deg`; and `boundary_tvd_ft` per station.
  - `rms_percent_used` and `misfit_normalised` (RMS of residual/σ over the used channels).

Errors use `{"error": "<message>"}`:

| Status | When |
|--------|------|
| 400 | Missing `run` or `curves` parameter, unknown curve name in `/curves/{run}/data`, `n_select` outside 5 to 10 in `/qc/select` |
| 404 | Unknown run id, unknown curve in `/runs/{run}/curves/{name}` or `/runs/{run}/well3d` |
| 422 | Invalid request body or query value; selection with unknown or duplicate curves; `/well3d` run with no usable trajectory |
| 500 | A DLIS file fails to load or QC fails unexpectedly |
| 503 | `DATA_DIR` missing or holding no `.dlis` files |
