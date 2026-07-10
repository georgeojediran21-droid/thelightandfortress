@echo off
setlocal

cd /d "%~dp0"

if not exist "C:\Program Files\nodejs\node.exe" (
    echo Node.js was not found at C:\Program Files\nodejs\node.exe
    echo Reinstall Node.js LTS and make sure Node.js is installed for all users.
    pause
    exit /b 1
)

set /p GMAIL_USER=Enter your Gmail address: 
set /p GMAIL_APP_PASSWORD=Enter your Gmail App Password: 

echo.
echo Starting The Light and Fortress backend...
echo Open http://localhost:3000 in your browser.
echo Keep this window open while using the website.
echo.

"C:\Program Files\nodejs\node.exe" server.js

pause
