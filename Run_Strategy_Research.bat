@echo off
rem Run_Strategy_Research.bat - stop/target + expiry test of the auto rules and the search for new option-buying
rem strategies, on the 5 years of data already saved by Run_Backtest.bat. READ ONLY: no orders, no Dhan login needed.
rem Results: backend\data\backtest\variants.csv, research_results.json, research_trades.csv, research_report.md
cd /d "%~dp0backend"
echo Part 1 of 2: stop / target and expiry-day test (about 1 hour)...
python bt_variants.py
echo.
echo Part 2 of 2: new strategy search (about 15 minutes the first time)...
python strategy_research.py
echo.
echo Finished. Tell Claude "done": Claude reads the results by itself.
pause
