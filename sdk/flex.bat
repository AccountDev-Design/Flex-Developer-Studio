@echo off
setlocal
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Primero ejecuta setup_windows.bat
  exit /b 1
)
.venv\Scripts\python.exe -m flexsdk %*
