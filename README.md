# resist

Resistivity QC and inversion platform for the Ekofisk well data.

- **Backend:** Python, FastAPI (`backend/`). Health, curve inventory, and QC selection endpoints.
- **Frontend:** JavaScript, Vite, React, Material UI (`frontend/`).
- **Data:** Ekofisk DLIS files in `data/`, with the reference notebook `view_resistivity_data_ekofisk.ipynb`.

## Quick start

Follow [SETUP.md](SETUP.md) for Mac and Windows commands. In short:

1. Start the backend: `cd backend` then `python app.py` (port 5000).
2. Start the frontend in a second terminal: `cd frontend` then `npm install` and `npm run dev` (port 5173).
3. Open http://localhost:5173 and check the backend status.

## Documentation

- [SETUP.md](SETUP.md): developer setup and run commands.
- [docs/api/contract.md](docs/api/contract.md): curve table, QC JSON, and endpoints.
- [docs/plans/resist-platform-dev-plan.md](docs/plans/resist-platform-dev-plan.md): work plan and workstream owners.
- [competitor UDAR inversion background](background/competitor-udar-inversion.md): summary of a related SPWLA paper and its relationship to the Ekofisk data release.
