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

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{"status": "ok"}` |
| GET | `/curves` | `{"curves": [<curve metadata rows>]}` |
| POST | `/qc/select` | QC selection JSON above |

Errors use `{"error": "<message>"}` with HTTP 4xx or 5xx.
