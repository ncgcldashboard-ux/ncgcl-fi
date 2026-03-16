@echo off
title NCGCL Fixed Income System — Windows Setup
color 1F
echo.
echo  =====================================================
echo   NCGCL Fixed Income Portfolio System
echo   Windows Setup Script
echo  =====================================================
echo.

:: Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js is NOT installed.
    echo.
    echo  Please install it first:
    echo  1. Open your browser
    echo  2. Go to: https://nodejs.org
    echo  3. Click the big "LTS" download button
    echo  4. Run the installer ^(click Next through everything^)
    echo  5. Come back and double-click this script again
    echo.
    pause
    exit /b 1
)

echo  [OK] Node.js found: 
node --version
echo.

:: Create project folder on Desktop
set PROJECT_DIR=%USERPROFILE%\Desktop\ncgcl-fi
echo  [..] Creating project at: %PROJECT_DIR%
mkdir "%PROJECT_DIR%" 2>nul
mkdir "%PROJECT_DIR%\backend" 2>nul
mkdir "%PROJECT_DIR%\frontend" 2>nul
mkdir "%PROJECT_DIR%\.github\workflows" 2>nul

echo  [OK] Folders created
echo.

:: Install backend dependencies
echo  [..] Installing backend dependencies...
cd /d "%PROJECT_DIR%\backend"
call npm install --save express pg cors dayjs >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo  [OK] Dependencies installed
echo.

:: Test the backend can start (quick syntax check)
echo  [..] Checking backend file...
if not exist "%PROJECT_DIR%\backend\server.js" (
    echo  [!] server.js not found in backend folder.
    echo      Make sure you copied all files into the right folders.
    echo      See DEPLOY_GUIDE.md for the folder structure.
) else (
    echo  [OK] server.js found
)

echo.
echo  =====================================================
echo   Setup complete!
echo  =====================================================
echo.
echo  Next steps:
echo  1. Open DEPLOY_GUIDE.md for full instructions
echo  2. Upload the project folder to GitHub
echo  3. Connect Railway to your GitHub repo
echo.
echo  Your project is at:
echo  %PROJECT_DIR%
echo.
pause
