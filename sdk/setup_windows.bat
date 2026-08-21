@echo off
setlocal
cd /d "%~dp0"
py -3 -m venv .venv
if errorlevel 1 goto :error
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -e .
if errorlevel 1 goto :error
echo.
echo Flex SDK instalado correctamente.
echo Usa flex --help para comenzar.
pause
exit /b 0
:error
echo.
echo No se pudo instalar. Verifica que Python 3.10 o superior este instalado.
pause
exit /b 1
