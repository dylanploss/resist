# resist

Resistivity QC and inversion platform for the Ekofisk well data.

- **Backend:** Python, FastAPI (`backend/`). Health, run list, curve inventory, curve data, and QC selection endpoints on the real Ekofisk data.
- **Frontend:** JavaScript, Vite, React, Material UI (`frontend/`). Pages: Overview (backend health, runs), Data (curve inventory and curves vs depth), QC selection, and Modelling (UDAR), which runs the UDAR_Bench 1D forward model and inversion in the browser.
- **Data:** Ekofisk DLIS files in `data/`, with the reference notebook `view_resistivity_data_ekofisk.ipynb`.
- **UDAR_Bench:** David's standalone browser example for 1D and 2.5D forward modeling and inversion (`UDAR_Bench/`). The single-file `UDAR_Bench.html` is not in the repo; build it with `node build/build.js` in `UDAR_Bench/source/` and open `UDAR_Bench/source/build/udar.html` in Chrome. The frontend uses an unchanged copy of its compute core (`frontend/src/compute/udar/`).

## Quick start

Follow [SETUP.md](SETUP.md) for Mac and Windows commands. In short:

1. Create the root `.venv`, install `backend/requirements.txt`, then start the backend from the repo root: `python -m backend.app` (port 5000).
2. Start the frontend in a second terminal: `cd frontend` then `npm install` and `npm run dev` (port 5173).
3. Open http://localhost:5173. The Overview page shows the backend status and the run count.

## Data analysis

The [Ekofisk analysis CLI](docs/data/ekofisk-format.md) inventories all ten wells
(eleven runs), plots measurements, and flags sustained transition candidates.
Geological labels remain unknown until calibrated interpretation rules are supplied.

## Documentation

- [SETUP.md](SETUP.md): developer setup and run commands.
- [docs/api/contract.md](docs/api/contract.md): curve table, QC JSON, and endpoints.
- [docs/data/ekofisk-format.md](docs/data/ekofisk-format.md): Ekofisk data format and analysis CLI.
- [docs/plans/resist-platform-dev-plan.md](docs/plans/resist-platform-dev-plan.md): work plan and workstream owners.
- [competitor UDAR inversion background](background/competitor-udar-inversion.md): summary of a related SPWLA paper and its relationship to the Ekofisk data release.
