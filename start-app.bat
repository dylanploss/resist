@echo off
rem Double-click to start the Resist app on Windows: backend on :5001, frontend on :5173, then open the browser.
rem A server that is already running is left alone. Each server runs in its own minimised window titled
rem "Resist backend" / "Resist frontend"; close that window to stop it. Logs: out\logs\backend.log, frontend.log.
setlocal
cd /d "%~dp0"
set "ROOT=%CD%"
if not defined BACKEND_PORT set "BACKEND_PORT=5001"
if not defined FRONTEND_PORT set "FRONTEND_PORT=5173"
set "LOGS=%ROOT%\out\logs"
if not exist "%LOGS%" mkdir "%LOGS%"

echo Resist app
echo.

rem --- Python: the repo-root .venv (SETUP.md), else backend\.venv ------------------------------------------
set "PY="
if exist "%ROOT%\.venv\Scripts\python.exe" set "PY=%ROOT%\.venv\Scripts\python.exe"
if not defined PY if exist "%ROOT%\backend\.venv\Scripts\python.exe" set "PY=%ROOT%\backend\.venv\Scripts\python.exe"

rem --- backend -------------------------------------------------------------------------------------------
netstat -ano | findstr "LISTENING" | findstr /c:":%BACKEND_PORT% " >nul
if not errorlevel 1 (
  echo Backend:  already running on port %BACKEND_PORT% ^(left as it is^)
  goto frontend
)
if not defined PY (
  echo Backend:  no Python environment found. Create .venv as described in SETUP.md first.
  pause
  exit /b 1
)
echo Backend:  starting on port %BACKEND_PORT% ...
set "RESIST_BACKEND_PORT=%BACKEND_PORT%"
start "Resist backend" /min cmd /c ""%PY%" -m backend.app > "%LOGS%\backend.log" 2>&1"
set /a TRIES=0
:wait_backend
curl.exe -s -m 2 -o NUL "http://localhost:%BACKEND_PORT%/health" && goto backend_ready
set /a TRIES+=1
if %TRIES% geq 60 (
  echo           did not answer within 60 s; see out\logs\backend.log
  goto frontend
)
timeout /t 1 /nobreak >nul
goto wait_backend
:backend_ready
echo           ready

rem --- frontend ------------------------------------------------------------------------------------------
:frontend
netstat -ano | findstr "LISTENING" | findstr /c:":%FRONTEND_PORT% " >nul
if not errorlevel 1 (
  echo Frontend: already running on port %FRONTEND_PORT% ^(left as it is^)
  goto status
)
if not exist "%ROOT%\frontend\node_modules" (
  echo Frontend: installing packages ^(first run only^) ...
  pushd "%ROOT%\frontend"
  call npm install > "%LOGS%\npm-install.log" 2>&1
  if errorlevel 1 (
    popd
    echo           npm install failed; see out\logs\npm-install.log
    pause
    exit /b 1
  )
  popd
)
echo Frontend: starting on port %FRONTEND_PORT% ...
set "VITE_API_URL=http://localhost:%BACKEND_PORT%"
start "Resist frontend" /min /d "%ROOT%\frontend" cmd /c "npx vite --port %FRONTEND_PORT% --strictPort > "%LOGS%\frontend.log" 2>&1"
set /a TRIES=0
:wait_frontend
curl.exe -s -m 2 -o NUL "http://localhost:%FRONTEND_PORT%" && goto frontend_ready
set /a TRIES+=1
if %TRIES% geq 60 (
  echo           did not answer within 60 s; see out\logs\frontend.log
  goto status
)
timeout /t 1 /nobreak >nul
goto wait_frontend
:frontend_ready
echo           ready

rem --- status --------------------------------------------------------------------------------------------
:status
echo.
if defined PY "%PY%" -c "import json, urllib.request as u; d = json.load(u.urlopen('http://localhost:%BACKEND_PORT%/health', timeout=5)); print('Inversion store:', d.get('store'), '-', d.get('cosmos'))" 2>nul
if not "%OPEN_BROWSER%"=="0" start "" "http://localhost:%FRONTEND_PORT%"
echo.
echo App: http://localhost:%FRONTEND_PORT%
echo The servers run in the minimised "Resist backend" and "Resist frontend" windows; close those to stop them.
echo.
pause
endlocal
