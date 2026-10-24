"""
algo_api.py - routes for the OI breakout algo (algo_service.py). PAPER TRADING ONLY.

    GET  /api/algo/status                  mode, Algo account funds, per index: state, locked levels, setup, open trade, trades
    GET  /api/algo/events?date=YYYY-MM-DD  the decision log (newest first) and closed trades of that IST day;
                                           a day missing from the store is read from logs/algo-<day>.log
    POST /api/algo/stop                    kill switch: no new entries (open positions keep their exits)
    POST /api/algo/stop-exit-all           kill switch + exit every open algo position at market
    POST /api/algo/resume                  allow new entries again
"""
import re

from fastapi import HTTPException


def register(app, algo):
    @app.get("/api/algo/status")
    def status():
        return algo.status()

    @app.get("/api/algo/events")
    def events(date: str = ""):
        date = date.strip()
        m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", date)  # 23-10-2026 as shown in the page's date picker
        if m:
            date = f"{m[3]}-{m[2]}-{m[1]}"
        if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise HTTPException(400, "date must look like 2026-10-23 or 23-10-2026")
        try:
            return algo.day_log(date or None)
        except Exception as e:  # database unreachable
            raise HTTPException(503, f"Database unavailable: {e}")

    @app.post("/api/algo/stop")
    def stop():
        algo.stop(exit_all=False)
        return algo.status()

    @app.post("/api/algo/stop-exit-all")
    def stop_exit_all():
        algo.stop(exit_all=True)
        return algo.status()

    @app.post("/api/algo/resume")
    def resume():
        algo.resume()
        return algo.status()
