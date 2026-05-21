@echo off
setlocal enableextensions
title Flujo-Senda: Fix GitHub push v2
cd /d "C:\dev\flujo-senda"

echo ============================================================
echo   FIX GITHUB v2 - reconstruyendo index corrupto
echo ============================================================
echo.

echo [1/7] Matando procesos git colgados...
taskkill /f /im git.exe >nul 2>&1
taskkill /f /im "git-remote-https.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/7] Borrando .git/index (esta corrupto)...
if exist ".git\index" del /f ".git\index"
if exist ".git\index.lock" del /f ".git\index.lock"
echo     OK

echo [3/7] Reconstruyendo working tree desde HEAD (LF endings)...
git config --local core.autocrlf false
git config --local core.safecrlf false
git reset --hard HEAD >_reset.log 2>&1
if errorlevel 1 (
    echo     ERROR en git reset - ver _reset.log
    type _reset.log
    pause
    exit /b 1
)
echo     OK

echo [4/7] Verificando estado limpio...
git status --short

echo.
echo [5/7] Agregando archivos nuevos (rebuild leftovers)...
if exist "src\components\ProjectionWorkspace.tsx" (
    echo     ERROR: reset --hard deberia haber borrado los untracked...
    echo     los mantengo por si tienen valor
)
git add -A 2>nul

echo.
echo [6/7] Commit...
git commit -m "chore: CRLF normalize + working tree cleanup" >_commit.log 2>&1
type _commit.log

echo.
echo [7/7] Estado final:
git status
echo.
echo Remote:
git remote -v
echo.
echo Branch:
git branch --show-current
echo.
echo ============================================================
echo   LISTO. Para pushear:
echo.
echo     git push origin feat/scenarios-workspace
echo.
echo   (si pide credenciales, las metes tu)
echo ============================================================
echo.
pause
exit /b 0
