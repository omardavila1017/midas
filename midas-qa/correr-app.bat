@echo off
REM ============================================================
REM  Arranca el servidor de desarrollo de midas.
REM  Abre automáticamente http://localhost:5173 en tu navegador.
REM ============================================================

cd /d "%~dp0"

echo.
echo ==========================================
echo   Arrancando midas en localhost...
echo ==========================================
echo.

REM Instala dependencias si no existe node_modules
if not exist "node_modules" (
    echo Instalando dependencias por primera vez...
    call npm install
    echo.
)

REM Arranca el dev server (Vite abre el navegador solo con --open)
call npx vite --open

pause
