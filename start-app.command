#!/bin/zsh
# Double-click in Finder to start the Resist app: backend on :5001, frontend on :5173, then open the browser.
# A server that is already running is left alone (so a running inversion batch is never interrupted).
# Logs: out/logs/backend.log and out/logs/frontend.log. Closing this window does not stop the servers.

cd "$(dirname "$0")" || exit 1
ROOT="$PWD"
BACKEND_PORT="${BACKEND_PORT:-5001}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
LOGS="$ROOT/out/logs"
mkdir -p "$LOGS"

# Python: the repo-root .venv (SETUP.md), else backend/.venv
PY="$ROOT/.venv/bin/python"
[[ -x "$PY" ]] || PY="$ROOT/backend/.venv/bin/python"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

wait_for() {   # url, name, seconds
  for _ in $(seq 1 $(( $3 * 2 ))); do
    curl -s -m 2 -o /dev/null "$1" && return 0
    sleep 0.5
  done
  echo "  $2 did not answer within $3 s; see its log in out/logs/"
  return 1
}

echo "Resist app"
echo

# --- backend ------------------------------------------------------------------------------------------------
if listening "$BACKEND_PORT"; then
  echo "Backend:  already running on port $BACKEND_PORT (left as it is)"
else
  if [[ ! -x "$PY" ]]; then
    echo "Backend:  no Python environment found (.venv or backend/.venv). Set it up first (see SETUP.md)."
    read -k 1 "?Press any key to close."
    exit 1
  fi
  echo "Backend:  starting on port $BACKEND_PORT ..."
  RESIST_BACKEND_PORT="$BACKEND_PORT" nohup "$PY" -m backend.app \
    > "$LOGS/backend.log" 2>&1 &
  disown
  wait_for "http://localhost:$BACKEND_PORT/health" "Backend" 60 && echo "          ready"
fi

# --- frontend -----------------------------------------------------------------------------------------------
if listening "$FRONTEND_PORT"; then
  echo "Frontend: already running on port $FRONTEND_PORT (left as it is)"
else
  cd "$ROOT/frontend" || exit 1
  if [[ ! -d node_modules ]]; then
    echo "Frontend: installing packages (first run only) ..."
    npm install > "$LOGS/npm-install.log" 2>&1 || { echo "  npm install failed; see out/logs/npm-install.log"; read -k 1 "?Press any key to close."; exit 1; }
  fi
  echo "Frontend: starting on port $FRONTEND_PORT ..."
  VITE_API_URL="http://localhost:$BACKEND_PORT" nohup npx vite --port "$FRONTEND_PORT" --strictPort \
    > "$LOGS/frontend.log" 2>&1 &
  disown
  cd "$ROOT"
  wait_for "http://localhost:$FRONTEND_PORT" "Frontend" 60 && echo "          ready"
fi

# --- status -------------------------------------------------------------------------------------------------
echo
STORE=$(curl -s -m 5 "http://localhost:$BACKEND_PORT/health" \
  | "$PY" -c "import sys, json; d = json.load(sys.stdin); print(d.get('store'), '-', d.get('cosmos'))" 2>/dev/null)
[[ -n "$STORE" ]] && echo "Inversion store: $STORE"
if [[ -f "$ROOT/out/full_runs/status.py" ]]; then
  echo
  echo "Whole-well inversions:"
  "$PY" "$ROOT/out/full_runs/status.py" 2>/dev/null | tail -1 | sed 's/^/  /'
fi

[[ "${OPEN_BROWSER:-1}" == "1" ]] && open "http://localhost:$FRONTEND_PORT"
echo
echo "App: http://localhost:$FRONTEND_PORT   (you can close this window; the servers keep running)"
