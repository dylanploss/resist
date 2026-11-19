---
title: Resist QC & Inversion Platform — Work Plan
slug: resist-platform-dev-plan
status: draft
owner: Planner
created: 2026-11-19
traceability: false
---

# Resist QC & Inversion Platform — Work Plan

## Goal

Build a resistivity QC and inversion platform on the Ekofisk data in the `dylanploss/resist` repo. The platform has a Python (FastAPI) backend, a JavaScript frontend built with React and Material UI, and setup documentation that works on both Mac and Windows developer laptops. Three developers work in parallel, each owning one workstream with a defined interface between them. The 1D and 2D inversion algorithms are deferred until the data path and QC selection are working.

---

## Out of Scope

- 1D and 2D inversion algorithm design and implementation (revisited once data and QC are ready)
- Production deployment, cloud infrastructure, containers
- Database persistence (in-memory or file-based only)
- Polished UI, mobile layout, real-time collaboration

---

## Acceptance Criteria

1. The backend runs on Python and exposes a health endpoint (`GET /health` returns 200).
2. The frontend runs on JavaScript and renders a page that calls the backend health endpoint.
3. `SETUP.md` gives working commands for Mac and Windows, and a developer who has not seen the project can start backend and frontend within 30 minutes of cloning.
4. A data-loading path reads the Ekofisk DLIS files in `data/` and produces a tidy curve table with depth, units, and well identifiers.
5. A reverse-engineering tool documents the Ekofisk file structure (curve mnemonics, units, depth reference, null values) well enough to map raw curves to inversion inputs.
6. The QC skill takes about 50 candidate curves and returns a ranked selection of 5 to 10 curves for inversion, with the reason for each keep or drop.
7. The QC output is a stable JSON contract that the backend exposes and the frontend can display.
8. The repo has a `.gitignore` that excludes local venv, `node_modules`, build output, IDE files, and local hackathon artifacts.

---

## Workstreams and Owners

| Owner | Workstream | Main deliverables |
|-------|-----------|-------------------|
| **Ove** | Backend and frontend setup | Python backend skeleton, JavaScript frontend skeleton, health endpoints, `SETUP.md` for Mac and Windows, `.gitignore`, run and test commands |
| **David** | Data analysis and reverse-engineering tool | DLIS loader, curve inventory of the Ekofisk files, mapping from raw curves to inversion inputs, documented data format |
| **Dylan** | QC skill for curve selection | Curve quality scoring, selection of 5 to 10 curves from about 50, selection rationale, QC JSON output |

Each owner works in their own branch and merges to `main` when their step passes its verification.

---

## Interfaces Between Workstreams

Define these first so the three can work in parallel.

1. **Curve table (David → Dylan, Ove):** a pandas DataFrame or CSV with columns `well`, `curve`, `unit`, `depth_ref`, `depth_m`, `value`, plus a per-curve metadata table with `curve`, `unit`, `null_value`, `description`.
2. **QC selection (Dylan → Ove):** JSON with `selected` (list of 5 to 10 curve names), `rejected` (list of `{curve, reason}`), `scores` (map of curve to score and metrics).
3. **Backend endpoints (Ove):**
   - `GET /health` returns `{status: "ok"}`
   - `GET /curves` returns the curve inventory from David's loader
   - `POST /qc/select` takes the curve selection request and returns the QC JSON from Dylan's module
4. **Frontend view (Ove):** calls the backend endpoints and renders the curve inventory and the QC selection table.

---

## Steps

### Step 1: Shared Contract (first hour, all three)

**Files:** `docs/api/contract.md` — **Verify:** all three can explain the interfaces above without looking at the notes.

- Agree on the curve table columns, the QC JSON shape, and the endpoint list above.
- Record the frontend decisions: React for the view layer, Material UI as the layout library (decided by Ove).
- Keep the contract to one page.

### Step 2: Repository Setup and Cross-Platform Docs (Ove)

**Files:** `.gitignore`, `SETUP.md`, `backend/`, `frontend/`, `docs/` — **Verify:** a clean clone on a Mac and a Windows laptop reaches the health check.

- Create `backend/` (Python) and `frontend/` (JavaScript) directories.
- Add a `.gitignore` that covers venv, `__pycache__`, `node_modules`, build output, IDE folders, and the local hackathon artifacts.
- Write `SETUP.md` with Mac and Windows commands side by side: Python version, venv creation and activation, `pip install -r requirements.txt`, Node version, `npm install`, starting each server, and running tests.
- Include a troubleshooting section for port conflicts, venv activation under PowerShell execution policy, and Node version mismatch.

### Step 3: Backend Skeleton (Ove)

**Files:** `backend/app.py`, `backend/requirements.txt`, `backend/tests/test_health.py` — **Verify:** `curl localhost:<port>/health` returns `{"status": "ok"}`.

- Use FastAPI with uvicorn (decided by Ove, recorded in `SETUP.md`).
- Add the three endpoints from the contract, returning stub data until the real modules are wired in.
- Keep the port in an environment variable with a default.

### Step 4: Frontend Skeleton (Ove)

**Files:** `frontend/package.json`, `frontend/src/App.jsx`, `frontend/src/components/` — **Verify:** the dev server starts and the page shows the backend health status.

- Create the app with Vite and React, and add Material UI as the layout library.
- Add one call to `GET /health` and render the result.
- Add placeholder components for the curve inventory and the QC table.

### Step 5: Data Analysis and Reverse-Engineering Tool (David)

**Files:** `backend/data/loader.py`, `backend/data/inventory.py`, `docs/data/ekofisk-format.md` — **Verify:** the loader reads every DLIS file in `data/` and the inventory lists every curve with its unit and null value.

- Read the Ekofisk DLIS files with dlisio (the existing notebook in the repo is the reference).
- Build the curve inventory: mnemonic, unit, depth reference, null value, sample count, depth range.
- Reverse-engineer what each curve measures and which ones carry resistivity information.
- Document findings in `docs/data/ekofisk-format.md`: file structure, curve families, unit quirks, and anything that changes how the inversion reads them.
- Produce the tidy curve table that Step 6 and Step 7 consume.

### Step 6: Curve Selection QC Skill (Dylan)

**Files:** `backend/qc/selection.py`, `backend/qc/metrics.py`, `backend/tests/test_qc_selection.py` — **Verify:** on the Ekofisk inventory the skill returns 5 to 10 curves with a rationale for each keep and drop.

- Start from the about 50 candidate curves in the curve table.
- Score each curve on data quality: coverage (fraction of non-null samples), noise level, gaps, and physical plausibility of the value range.
- Score each curve on relevance to resistivity: exclude curves that do not carry resistivity information, and keep the ones that do.
- Remove redundant curves (highly correlated pairs), keeping the better-scored one.
- Select the top 5 to 10 and return the QC JSON from the contract, with a reason for every rejected curve.
- Unit test the scoring on small synthetic tables with known outcomes.

### Step 7: Connect Backend to Data and QC (Ove, with David and Dylan)

**Files:** `backend/app.py`, `backend/tests/test_api.py` — **Verify:** `GET /curves` and `POST /qc/select` return the contract shapes on the real Ekofisk data.

- Wire David's loader into `GET /curves`.
- Wire Dylan's selection into `POST /qc/select`.
- Add input validation and clear error responses.

### Step 8: Frontend Views (Ove)

**Files:** `frontend/src/components/CurveInventory.jsx`, `frontend/src/components/QcSelection.jsx` — **Verify:** the page shows the inventory and the selected curves with their rejection reasons on the real data.

- Render the curve inventory as a table.
- Render the QC selection: selected curves highlighted, rejected curves with reasons.
- Show loading and error states.

### Step 9: Cross-Platform Test Run (all three)

**Files:** `SETUP.md` (fixes only) — **Verify:** Ove runs the full stack on Mac, a Windows developer runs it on Windows, and each records any setup fix in `SETUP.md`.

- Run `SETUP.md` from a fresh clone on each laptop.
- Fix any OS-specific issues in the docs, not in ad hoc local changes.

### Step 10: Inversion Revisit (deferred, separate plan)

**Files:** to be decided — **Verify:** not in scope for this work plan.

- The 1D forward model and 1D/2D inversion are planned later, once the curve selection output is stable.
- The inversion will take the 5 to 10 selected curves as input.

---

## Validation Strategy

- **Backend unit tests:** `pytest backend/tests` covers the loader, the curve inventory, the QC scoring on synthetic tables, and the API responses.
- **Frontend checks:** the page renders the health status, the inventory, and the QC table on real data. Component tests only if time allows.
- **Manual cross-platform check:** Ove on Mac and a Windows developer on Windows follow `SETUP.md` from a clean clone.
- **Data check:** David's inventory counts and units match the notebook output in the repo.

---

## Integration Touchpoints

| Component | Integrates with | Interface | Owner |
|-----------|-----------------|-----------|-------|
| DLIS loader and inventory | QC selection, `GET /curves` | Curve table (pandas / CSV) | David |
| QC selection | `POST /qc/select`, future inversion | QC JSON | Dylan |
| Backend API | Frontend, loader, QC | JSON over HTTP | Ove |
| Frontend views | Backend API | Fetch to backend | Ove |
| `SETUP.md` | All developers | Written commands | Ove |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Curve mnemonics or units differ between DLIS files | Medium | Loader and QC give wrong results | David documents the format in Step 5 before Dylan starts scoring; unit check in tests |
| QC scoring picks curves with no resistivity information | Medium | Inversion gets unusable input | Relevance scoring is explicit; the selection rationale is reviewed by Ove and David |
| Setup differs between Mac and Windows | Medium | A developer is blocked for a long time | Commands written side by side; cross-platform run in Step 9 |
| Dependency on the frontend library decision | Low | Frontend work stalls | Decide in Step 1; scaffold tool documented in `SETUP.md` |
| Curve table contract changes midway | Medium | Rework across workstreams | Contract agreed in Step 1; changes go through the contract doc |

---

## Rollback

- Each workstream lives on its own branch until its verification passes. A failing branch is not merged.
- If the curve table contract changes, revert to the agreed version in `docs/api/contract.md` and update consumers in one commit.
- All work is in git. Nothing is local-only except the venv and `node_modules`, which are rebuilt from the manifests.

---

## Open Decisions

1. Frontend: React with Material UI as the common layout library. Decided by Ove.
2. Backend framework: FastAPI with uvicorn. Decided by Ove, recorded in `SETUP.md` and `docs/api/contract.md`.
3. Relevance criteria for resistivity curves: David and Dylan agree on the list in Step 5.
4. Inversion approach (1D and 2D): deferred to a later plan.

---

## Notes for Developers

1. Commit in small steps with conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
2. Keep `SETUP.md` current. Fix OS-specific issues there, not in local workarounds.
3. Use the Ekofisk DLIS files in `data/` as the reference dataset.
