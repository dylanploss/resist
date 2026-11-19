# Setup

Commands for macOS and Windows. Run them from the repo root.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | 3.9 or newer | macOS: `python3 --version` · Windows: `python --version` |
| Node.js | 18 or newer | `node --version` |
| Git | any | `git --version` |

## Backend (Python, FastAPI)

Start the backend first. It listens on port 5000 unless `RESIST_BACKEND_PORT` is set.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Create venv | `python3 -m venv backend/.venv` | `python -m venv backend\.venv` |
| Activate venv | `source backend/.venv/bin/activate` | `backend\.venv\Scripts\Activate.ps1` |
| Install | `pip install -r backend/requirements.txt` | `pip install -r backend\requirements.txt` |
| Run server | `cd backend && python app.py` | `cd backend; python app.py` |
| Run tests | `cd backend && python -m pytest tests` | `cd backend; python -m pytest tests` |
| Check health | `curl http://localhost:5000/health` | `Invoke-RestMethod http://localhost:5000/health` |

Expected health response: `{"status":"ok"}`.

## Frontend (JavaScript, Vite + React + Material UI)

Run the frontend in a second terminal while the backend runs.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Install | `cd frontend && npm install` | `cd frontend; npm install` |
| Run dev server | `npm run dev` | `npm run dev` |
| Build | `npm run build` | `npm run build` |

Open http://localhost:5173. The page shows the backend status. To point at another backend, set `VITE_API_URL` before `npm run dev`.

## Troubleshooting

- **Activation blocked on Windows:** run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `backend\.venv\Scripts\activate.bat` from cmd.
- **Port in use:** set `RESIST_BACKEND_PORT` to another port, then set `VITE_API_URL` to match for the frontend.
- **Frontend says backend not reachable:** confirm the backend is running and `/health` responds. The backend allows only the Vite origins on port 5173.
- **Wrong Python on macOS:** use `python3`, not `python`, when creating the venv.
- **Node version too old:** Vite needs Node 18 or newer. Check with `node --version`.
