@echo off
rem Run_Backtest.bat - 5-year backtest of the auto rules on Dhan's past data. READ ONLY: no orders.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_backtest.ps1"
echo.
pause
