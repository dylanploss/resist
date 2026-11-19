# Setup

Commands for macOS and Windows. Run them from the repo root.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | 3.9 or newer | macOS: `python3 --version` · Windows: `python --version` |
| Node.js | 18 or newer | `node --version` |
| Git | any | `git --version` |

## Backend (Python)

Setup and run steps are added in plan Steps 2 and 3, once the backend skeleton exists.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Create venv | `python3 -m venv backend/.venv` | `python -m venv backend\.venv` |
| Activate venv | `source backend/.venv/bin/activate` | `backend\.venv\Scripts\Activate.ps1` |
| Install | `pip install -r backend/requirements.txt` | `pip install -r backend\requirements.txt` |

## Frontend (JavaScript)

Setup and run steps are added in plan Step 4, once the frontend skeleton exists.

| Action | macOS | Windows (PowerShell) |
|--------|-------|----------------------|
| Install | `cd frontend && npm install` | `cd frontend; npm install` |
| Run dev server | `npm run dev` | `npm run dev` |

## Troubleshooting

- **Activation blocked on Windows:** run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `backend\.venv\Scripts\activate.bat` from cmd.
- **Port in use:** set `RESIST_BACKEND_PORT` to another port.
- **Wrong Python on macOS:** use `python3`, not `python`.
