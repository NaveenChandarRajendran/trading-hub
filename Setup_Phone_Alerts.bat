@echo off
rem One-time setup of the phone alerts (Telegram). The bot key is typed into a hidden prompt and saved in
rem %USERPROFILE%\TradingHubKeys\telegram.json, outside this folder and outside git. Paper trading only.
cd /d "%~dp0backend"
python setup_phone_alerts.py
echo.
pause
