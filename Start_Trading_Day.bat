@echo off
title Trading Hub - start of the trading day
rem Double-click every trading morning. It asks for today's Dhan details, starts everything and opens the dashboard.
rem Paper trading only. The real work is in scripts\start_trading_day.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_trading_day.ps1"
