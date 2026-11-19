# Setup

Commands for macOS and Windows. Run every command from the repo root unless a step says otherwise.

Verified on Windows 11 with Python 3.13. The macOS commands follow the same steps but have not been verified on a Mac yet.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | 3.11 or newer (3.13 verified) | macOS: `python3 --version` · Windows: `python --version` |
| Node.js | 20.19+ or 22.12+ (Vite 7 requirement; 22.23 verified) | `node --version` |
| Git | any | `git --version` |

Python 3.11 is the minimum because `dlisio` 1.0.5 publishes wheels only for 3.11 and newer.

## Backend (Python, FastAPI)

The project uses one virtual environment, `.venv`, at the repo root. The backend, tests, and the data CLI all run from it.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Create venv | `python3 -m venv .venv` | `python -m venv .venv` |
| Activate venv | `source .venv/bin/activate` | `.\.venv\Scripts\Activate.ps1` |
| Install | `python -m pip install -r backend/requirements.txt` | `python -m pip install -r backend\requirements.txt` |
| Run server | `python -m backend.app` | `python -m backend.app` |
| Check health | `curl http://localhost:5000/health` | `Invoke-RestMethod http://localhost:5000/health` |
| List runs | `curl http://localhost:5000/runs` | `Invoke-RestMethod http://localhost:5000/runs` |

Expected health response: `{"status":"ok"}`. Stop the server with Ctrl+C.

Without activating the venv, call its interpreter directly: `.venv/bin/python` on macOS, `.\.venv\Scripts\python.exe` on Windows.

The first request for a run parses its DLIS file, which took under 1 second for the largest run on the verified Windows laptop. Later requests for that run are served from memory.

To view one run's curves:

```powershell
$run = (Invoke-RestMethod http://localhost:5000/runs).runs[0].run
Invoke-RestMethod "http://localhost:5000/curves?run=$run"
```

```bash
curl "http://localhost:5000/curves?run=2_4-Z-6_16954-20950ft_RES_GEOSIGNAL"
```

Endpoints and response shapes are in [docs/api/contract.md](docs/api/contract.md).

### Tests

| Suite | Command (venv active, either OS) |
|-------|---------------------------------|
| All backend tests | `python -m pytest backend/tests` |
| Data analysis tests only | `python -m unittest discover -s backend/tests -p test_data_analysis.py` |

The API tests read one real run from `data/` and finish in a few seconds.

### Environment variables

| Variable | Default | Used by | Meaning |
|----------|---------|---------|---------|
| `RESIST_BACKEND_PORT` | `5000` | backend | Port the backend listens on |
| `DATA_DIR` | `<repo>/data` | backend | Folder with the `.dlis` files |
| `VITE_API_URL` | `http://localhost:5000` | frontend | Backend URL the frontend calls |

Set them for one terminal session:

| macOS | Windows (PowerShell) |
|-------|----------------------|
| `export RESIST_BACKEND_PORT=5001` | `$env:RESIST_BACKEND_PORT = "5001"` |

## Frontend (JavaScript, Vite + React + Material UI)

Run the frontend in a second terminal while the backend runs. All commands run inside `frontend/`.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Install | `cd frontend && npm install` | `cd frontend; npm install` |
| Run dev server | `npm run dev` | `npm run dev` |
| Build | `npm run build` | `npm run build` |
| Lint | `npm run lint` | `npm run lint` |
| Check the UDAR core copy | `npm run check:udar` | `npm run check:udar` |
| Check 3D colours match Plotly | `npm run check:colormap` | `npm run check:colormap` |
| Recopy the UDAR core | `npm run sync:udar` | `npm run sync:udar` |

Open http://localhost:5173. The pages are:

| Page | Shows | Needs the backend |
|------|-------|-------------------|
| Overview | Backend health and the list of runs | Yes |
| Data | Run picker, curve inventory (family, frequency, spacing), curves vs depth for up to 8 curves | Yes |
| QC selection | `GET /runs/{run}/qc` result as a ranked table with status and reasons, DOI-vs-noise scatter, curves vs measured depth (Plotly), and an editable selection saved with `POST /runs/{run}/selection` | Yes |
| Modelling (UDAR) | UDAR_Bench 1D tabs: Tool, Geology & well, Forward, Inversion | No; runs in the browser |

Verified on Windows 11 with Node 22.23 and Chrome. The Modelling page keeps its settings in the browser's local storage; **Reset all settings** restores the defaults.

### Backend URL

The frontend calls `VITE_API_URL`, default `http://localhost:5000`. To change it, copy `frontend/.env.example` to `frontend/.env.local` and edit the value, or set the variable for one terminal session before `npm run dev`:

| macOS | Windows (PowerShell) |
|-------|----------------------|
| `VITE_API_URL=http://localhost:5001 npm run dev` | `$env:VITE_API_URL = "http://localhost:5001"; npm run dev` |

Backend errors appear on the page with the backend's `error` message and HTTP status.

### 3D well colours

The 3D well tab (three.js, React Three Fiber, drei; loaded only when the tab opens) colours curves with the Plotly Jet and RdBu scales copied into `frontend/src/components/well3d/colormap.js`. After upgrading `plotly.js-dist-min`, run `npm run check:colormap`; it exits with an error when the copied scales or their sampling differ from the installed Plotly bundle. The tab needs WebGL and shows a message when the browser has none.

### UDAR compute core

`frontend/src/compute/udar/` holds byte-identical copies of `UDAR_Bench/source/src/*.js`. Do not edit them there. Edit the originals in `UDAR_Bench/source/src/`, then run `npm run sync:udar` and `npm run check:udar`. `check:udar` exits with an error when a copy differs from the original.

To run the UDAR_Bench core tests (from `UDAR_Bench/source/`, each takes a few seconds):

    node tests/test_engine1d.js
    node tests/test_model.js
    node tests/test_invert.js

### UDAR_Bench standalone

The original app is a single HTML file. It is not stored in the repo, so build it first, from `UDAR_Bench/source/`:

    node build/build.js

Then open `UDAR_Bench/source/build/udar.html` in Chrome. It runs offline and includes the 2D and 2.5D modes that the frontend does not have yet.

## Troubleshooting

- **`dlisio` fails to install on macOS:** wheels exist for Apple Silicon (arm64) with Python 3.11 to 3.15. On an Intel Mac, or with an older Python, pip builds from source and needs Xcode command line tools and CMake. Use a Python 3.11+ arm64 build, for example from python.org or `brew install python@3.13`. Check with `python3 -c "import platform; print(platform.machine())"`; it should print `arm64`.
- **Activation blocked on Windows:** run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or skip activation and call `.\.venv\Scripts\python.exe` directly.
- **`ModuleNotFoundError: No module named 'backend'`:** run commands from the repo root, not from inside `backend/`.
- **Port in use:** set `RESIST_BACKEND_PORT` to another port, then set `VITE_API_URL` to match for the frontend. On macOS, port 5000 is often taken by AirPlay Receiver; use 5001 or turn off AirPlay Receiver in System Settings.
- **`/runs` returns 503:** the data folder is missing or empty. Check that `data/` holds the `.dlis` files, or set `DATA_DIR` to the folder that does.
- **Frontend says backend not reachable:** confirm the backend is running and `/health` responds. The backend allows only the origins `http://localhost:5173` and `http://127.0.0.1:5173`, so a frontend on another port is blocked by CORS.
- **Wrong Python on macOS:** use `python3`, not `python`, when creating the venv. After activation, `python` points to the venv.
- **Node version too old:** Vite 7 needs Node 20.19+ or 22.12+. Check with `node --version`.
- **Modelling (UDAR) page shows old settings:** settings are kept in local storage. Press **Reset all settings** on that page.
