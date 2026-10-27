"""GET /api/journal/*: days, one day's orders, trades over a range (auto + manual paper fills)."""
import tempfile
from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

import journal as jr
from sig_indicators import IST
from test_journal import NOW, trade


class FakePaper:
    def clock(self):
        return datetime(2026, 10, 26, 16, 0, tzinfo=IST)

    def pnl(self, a, b):
        return [{"day": "2026-10-26"}]

    def orders(self, day):
        return [{"id": "PT1", "side": "BUY", "order_type": "MARKET", "qty": 65, "avg_price": 100.0, "status": "FILLED",
                 "created_at": "2026-10-26T09:40:00+05:30", "name": "NIFTY 27 OCT 25800 PUT", "symbol": "NIFTY"}]

    def trades(self, day):
        return [{"security_id": 7, "side": "BUY", "qty": 65, "price": 100.0, "time": "2026-10-26T09:40:00+05:30",
                 "charges": {"total": 20.0}, "name": "NIFTY 27 OCT 25800 PUT", "symbol": "NIFTY", "optionType": "PE"}]


def test_journal_endpoints():
    j = jr.Journal(tempfile.mkdtemp())
    j.record(trade(), "entry", NOW)
    app = FastAPI()
    jr.register(app, j, FakePaper())
    c = TestClient(app)
    assert c.get("/api/journal/days").json()["days"] == ["2026-10-26"]
    rows = c.get("/api/journal/orders", params={"date": "2026-10-26"}).json()["rows"]
    assert [(r["strategy"], r["time"]) for r in rows] == [("Manual", "09:40:00"), ("4 Pillar Rules", "10:05:35")]
    tr = c.get("/api/journal/trades", params={"from": "2026-10-01", "to": "2026-10-31"}).json()["rows"]
    assert {t["strategy"] for t in tr} == {"Manual", "4 Pillar Rules"}
    assert c.get("/api/journal/orders", params={"date": "26-10-2026"}).status_code == 400


def test_journal_days_always_lists_today_on_a_trading_day():
    class OpenOnly(FakePaper):  # 27-Oct: manual trades still open, nothing closed yet
        def clock(self):
            return datetime(2026, 10, 27, 11, 0, tzinfo=IST)

    app = FastAPI()
    jr.register(app, jr.Journal(tempfile.mkdtemp()), OpenOnly())
    assert TestClient(app).get("/api/journal/days").json()["days"][0] == "2026-10-27"
