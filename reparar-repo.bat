@echo off
REM ============================================================
REM  Reparador automático: restaura los archivos corruptos
REM  desde el último commit en git. No borra nada nuevo
REM  (ScenariosWorkspace.tsx se conserva porque no está trackeado).
REM ============================================================

cd /d "%~dp0"

echo.
echo ==========================================
echo   Reparando repo flujo-senda...
echo ==========================================
echo.

echo [1/3] git status
git status --short
echo.

echo [2/3] Restaurando archivos trackeados a HEAD (main)
git restore .
echo.

echo [3/3] Validando TypeScript
call npx tsc --noEmit
echo.

echo ==========================================
echo   Listo. Puedes cerrar esta ventana.
echo ==========================================
pause
