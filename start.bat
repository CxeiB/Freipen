@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Please install Node.js 20 or newer from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "dist\index.html" (
    echo [INFO] dist not found. Installing dependencies and building the frontend...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Frontend build failed.
        pause
        exit /b 1
    )
)

echo.
echo   Freipen is starting...
echo   Open http://localhost:4100 in your browser.
echo   Press Ctrl+C to stop the server.
echo.
node server.js
pause
endlocal
