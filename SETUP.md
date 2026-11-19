# Setup

Commands for macOS and Windows. Run every command from the repo root unless a step says otherwise.

Verified on Windows 11 with Python 3.13. The macOS commands follow the same steps but have not been verified on a Mac yet.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | 3.11 or newer (3.13 verified) | macOS: `python3 --version` · Windows: `python --version` |
| Node.js | 18 or newer | `node --version` |
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

Run the frontend in a second terminal while the backend runs.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Install | `cd frontend && npm install` | `cd frontend; npm install` |
| Run dev server | `npm run dev` | `npm run dev` |
| Build | `npm run build` | `npm run build` |

Open http://localhost:5173. The page shows the backend status. To point at another backend, set `VITE_API_URL` before `npm run dev`.

## Troubleshooting

- **`dlisio` fails to install on macOS:** wheels exist for Apple Silicon (arm64) with Python 3.11 to 3.15. On an Intel Mac, or with an older Python, pip builds from source and needs Xcode command line tools and CMake. Use a Python 3.11+ arm64 build, for example from python.org or `brew install python@3.13`. Check with `python3 -c "import platform; print(platform.machine())"`; it should print `arm64`.
- **Activation blocked on Windows:** run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or skip activation and call `.\.venv\Scripts\python.exe` directly.
- **`ModuleNotFoundError: No module named 'backend'`:** run commands from the repo root, not from inside `backend/`.
- **Port in use:** set `RESIST_BACKEND_PORT` to another port, then set `VITE_API_URL` to match for the frontend. On macOS, port 5000 is often taken by AirPlay Receiver; use 5001 or turn off AirPlay Receiver in System Settings.
- **`/runs` returns 503:** the data folder is missing or empty. Check that `data/` holds the `.dlis` files, or set `DATA_DIR` to the folder that does.
- **Frontend says backend not reachable:** confirm the backend is running and `/health` responds. The backend allows only the origins `http://localhost:5173` and `http://127.0.0.1:5173`, so a frontend on another port is blocked by CORS.
- **Wrong Python on macOS:** use `python3`, not `python`, when creating the venv. After activation, `python` points to the venv.
- **Node version too old:** Vite needs Node 18 or newer. Check with `node --version`.
