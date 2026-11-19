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

## Endpoints (Ove)

Implemented in `backend/app.py`. A run id is the DLIS file name without `.dlis`, for example `2_4-Z-6_16954-20950ft_RES_GEOSIGNAL`. Runs are read from `DATA_DIR` (default `<repo>/data`). A run is parsed on first use and cached for the life of the process.

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/health` | none | `{"status": "ok"}` |
| GET | `/runs` | none | `{"runs": [{"run", "file", "well", "depth_min_m", "depth_max_m"}]}` |
| GET | `/curves` | query `run` (required) | `{"run", "well", "curves": [<curve metadata rows>]}` |
| GET | `/curves/{run}/data` | query `curves=A,B` (required) | `{"run", "well", "depth_m": [..], "curves": {"A": {"unit", "bins", "values": [..]}}}` |
| POST | `/qc/select` | `{"run": "<id>", "n_select": 8}` | QC selection JSON above |

Details:
- `/runs` reads only DLIS headers. `well` and the depth range are null if the header is unreadable, and the entry then has an `error` field.
- `/curves` rows contain the four metadata columns above plus the loader columns `well`, `run`, `depth_ref`, `sample_count`, `bins`, `depth_min_m`, `depth_max_m`, `valid_fraction`, `nonpositive_count`, and the mnemonic fields from `measurement_metadata`: `family` (`AR`, `ZR`, `ZG` or `conventional`), `frequency_hz`, `spacing_in`, `measurement`, `suffix`, `geometry_status`. Mnemonic fields are null for conventional curves.
- `/curves/{run}/data` returns one value per depth for scalar curves (`bins` 1) and a list of 32 bin values per depth for image curves (`bins` 32). Null-sentinel and non-finite samples are `null`.
- `/qc/select`: `n_select` defaults to 8 and must be within 5 to 10.

Errors use `{"error": "<message>"}`:

| Status | When |
|--------|------|
| 400 | Missing `run` or `curves` parameter, unknown curve name, invalid body, `n_select` outside 5 to 10 |
| 404 | Unknown run id |
| 500 | A DLIS file fails to load or QC fails unexpectedly |
| 503 | `DATA_DIR` missing or holding no `.dlis` files |
