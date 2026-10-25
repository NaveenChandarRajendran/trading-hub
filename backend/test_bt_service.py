"""The Backtest page's service: refuses to run during market hours or without a token, then downloads and runs."""
import time
from datetime import datetime

import bt_data
from bt_service import BacktestService
from sig_indicators import IST


class Client:
    token = "t"

    def _post(self, path, body, gap=0):
        return {}  # no data: the run finishes with zero trades


def at(hm):
    h, m = map(int, hm.split(":"))
    return datetime(2026, 10, 26, h, m, tzinfo=IST)


def test_refuses_in_market_hours_and_without_token():
    svc = BacktestService(Client(), lambda: True, clock=lambda: at("11:00"))
    try:
        svc.start()
        assert False
    except RuntimeError as e:
        assert "after market hours" in str(e)
    c = Client()
    c.token = ""
    try:
        BacktestService(c, lambda: False, clock=lambda: at("18:00")).start()
        assert False
    except RuntimeError as e:
        assert "token" in str(e)


def test_runs_after_hours_and_writes_results(tmp_path):
    old, old_start = bt_data.ROOT, bt_data.START
    bt_data.ROOT, bt_data.START = str(tmp_path), datetime(2026, 10, 1).date()
    try:
        svc = BacktestService(Client(), lambda: False, clock=lambda: at("18:00"))
        svc.start()
        for _ in range(200):
            if svc.get_status()["state"] in ("done", "error"):
                break
            time.sleep(0.05)
        st = svc.get_status()
        assert st["state"] == "done", st
        assert st["total"] > 0 and st["hasResults"]
        assert svc.results()["trades"] == []
    finally:
        bt_data.ROOT, bt_data.START = old, old_start
