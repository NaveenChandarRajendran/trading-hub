"""
bt_service.py - runs the 5-year backtest (backtest.py) from the app's Backtest page: GET /api/backtest/status,
POST /api/backtest/run, GET /api/backtest/results. READ ONLY market data, no orders.
Uses the backend's own Dhan client (the token the owner gave at the start of the day). Runs only outside market hours,
so the live watcher keeps Dhan's rate limits for itself. Downloads resume where they stopped (bt_data cache).
"""
import json
import logging
import os
import threading
from datetime import datetime

import backtest
import bt_data
from sig_indicators import IST

log = logging.getLogger("bt_service")


class BacktestService:
    def __init__(self, client, market_open, clock=lambda: datetime.now(IST)):
        self.client, self.market_open, self.clock = client, market_open, clock
        self.lock = threading.Lock()
        self.status = {"state": "idle", "done": 0, "total": 0, "message": "", "startedAt": None, "finishedAt": None}
        self._thread = None

    def get_status(self):
        with self.lock:
            st = dict(self.status)
        st["hasResults"] = os.path.exists(os.path.join(bt_data.ROOT, "results.json"))
        return st

    def _set(self, **kw):
        with self.lock:
            self.status.update(kw)

    def start(self):
        if self._thread and self._thread.is_alive():
            raise RuntimeError("A backtest is already running.")
        now = self.clock()
        if self.market_open() and (9, 0) <= (now.hour, now.minute) < (15, 45):
            raise RuntimeError("Run the backtest after market hours (3:45 PM): during the session the live trader needs Dhan's data limits.")
        if not self.client.token:
            raise RuntimeError("No Dhan token yet: start the day with Start_Trading_Day.bat first.")
        self._set(state="downloading", done=0, total=0, message="Downloading past data from Dhan", startedAt=now.isoformat(timespec="seconds"),
                  finishedAt=None)
        self._thread = threading.Thread(target=self._run, name="backtest", daemon=True)
        self._thread.start()

    def _run(self):
        try:
            bt_data.download(self.client, self.clock().date(), log=lambda m: log.info(m),
                             progress=lambda n, total: self._set(done=n, total=total))
            self._set(state="running", message="Running the strategies on 5 years of data")
            backtest.run(log=lambda m: log.info(m))
            self._set(state="done", message="Finished", finishedAt=self.clock().isoformat(timespec="seconds"))
        except Exception as e:
            log.exception("backtest failed")
            self._set(state="error", message=str(e)[:300], finishedAt=self.clock().isoformat(timespec="seconds"))

    def results(self):
        p = os.path.join(bt_data.ROOT, "results.json")
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)


def register(app, svc):
    from fastapi import HTTPException

    @app.get("/api/backtest/status")
    def bt_status():
        return svc.get_status()

    @app.post("/api/backtest/run")
    def bt_run():
        try:
            svc.start()
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return svc.get_status()

    @app.get("/api/backtest/results")
    def bt_results():
        r = svc.results()
        if r is None:
            raise HTTPException(404, "No backtest results yet. Press Run backtest (after market hours).")
        return r
