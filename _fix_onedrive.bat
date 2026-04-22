@echo off
setlocal enableextensions
title Flujo-Senda: Rescate de OneDrive

echo ============================================================
echo   RESCATE DE FLUJO-SENDA DE ONEDRIVE
echo ============================================================
echo.

echo [1/5] Cerrando OneDrive...
taskkill /f /im OneDrive.exe >nul 2>&1
timeout /t 3 /nobreak >nul

echo [2/5] Preparando C:\dev\flujo-senda...
if not exist "C:\dev" mkdir "C:\dev"

echo     copiando proyecto con robocopy...
robocopy "C:\Users\sanny\OneDrive\Escritorio\flujo-senda" "C:\dev\flujo-senda" /E /XD node_modules dist dist2 .git\worktrees /XF *.timestamp-*.mjs /R:2 /W:1 /NFL /NDL /NJH /NJS /NP >nul
set ROBO=%errorlevel%
if %ROBO% GEQ 8 (
    echo     ERROR: robocopy fallo con codigo %ROBO%
    timeout /t 10
    exit /b 1
)

echo [3/5] Restaurando archivos desde git...
cd /d "C:\dev\flujo-senda"
if exist ".git\index.lock" del /f ".git\index.lock" >nul 2>&1
if exist ".git\config.lock" del /f ".git\config.lock" >nul 2>&1
git reset --hard HEAD >_reset.log 2>&1
if errorlevel 1 (
    echo     ERROR: git reset fallo - ver C:\dev\flujo-senda\_reset.log
    type _reset.log
    timeout /t 15
    exit /b 1
)

echo [4/5] Verificando node_modules...
if not exist "C:\dev\flujo-senda\node_modules" (
    echo     corriendo npm install ^(~30s^)...
    call npm install >_install.log 2>&1
    if errorlevel 1 (
        echo     ERROR: npm install fallo - ver _install.log
        timeout /t 15
        exit /b 1
    )
) else (
    echo     node_modules existe, saltando npm install
)

echo [5/5] Arrancando servidor de desarrollo...
start "flujo-senda dev" cmd /k "cd /d C:\dev\flujo-senda && echo === DEV SERVER === && npm run dev"
echo.
echo ============================================================
echo   LISTO - http://localhost:5173
echo   Proyecto movido a: C:\dev\flujo-senda
echo ============================================================
timeout /t 8 /nobreak >nul
exit /b 0
