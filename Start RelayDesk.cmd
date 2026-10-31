@echo off
cd /d "%~dp0"
set "RELAYDESK_NODE=node"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "RELAYDESK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%RELAYDESK_NODE%" -e "if(Number(process.versions.node.split('.')[0])<24){console.error('Please install Node.js 24 from https://nodejs.org/');process.exit(1)}"
if errorlevel 1 (
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  echo Run npm ci and npm run build with Node.js 24 as described in README.md first.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo Run npm run build before opening the dashboard.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4328 in your browser. Keep this window open while using RelayDesk.
"%RELAYDESK_NODE%" src\backend\server.js
if errorlevel 1 pause
