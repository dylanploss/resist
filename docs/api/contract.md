# Resist Platform Interface Contract

Status: draft v0.1. Changes go through this file, and consumers update in the same commit.

## Decisions

| Topic | Decision | Status |
|-------|----------|--------|
| Backend framework | Flask | Assumed; Ove confirms |
| Frontend | Vite + React (JavaScript) | Assumed; Ove confirms |
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

Returned by `POST /qc/select`.

```json
{
  "selected": ["RT", "RXO", "..."],
  "rejected": [{"curve": "GR", "reason": "no resistivity information"}],
  "scores": {"RT": {"score": 0.92, "coverage": 0.98, "noise": 0.03, "range_ok": true}}
}
```

Rules:
- `selected` has 5 to 6 entries.
- Every curve in the inventory appears in exactly one of `selected` or `rejected`.
- `scores` covers every curve in the inventory.

## Endpoints (Ove)

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{"status": "ok"}` |
| GET | `/curves` | `{"curves": [<curve metadata rows>]}` |
| POST | `/qc/select` | QC selection JSON above |

Errors use `{"error": "<message>"}` with HTTP 4xx or 5xx.
