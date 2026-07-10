@echo off
setlocal
cd /d "%~dp0"

set "LOCAL_NODE=%~dp0.tools\node-v24.18.0-win-x64\node.exe"

if exist "%LOCAL_NODE%" (
    "%LOCAL_NODE%" server.js
    goto :eof
)

where node >nul 2>nul
if %errorlevel% equ 0 (
    node server.js
    goto :eof
)

echo Node.js was not found.
echo Install Node.js, or add portable Node.js under:
echo %~dp0.tools\node-v24.18.0-win-x64
echo.
pause
