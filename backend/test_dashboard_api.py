"""GET /api/dashboard/summary with a fake Dhan client: every card OK, one card failing, token expired, market closed."""
import json
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from dhan_client import DhanError, TokenExpired, parse_chain
from main import create_app
from tracker import IST, Tracker

# Real NIFTY 27-Oct-2026 chain captured 21-Oct-2026 (capture_chain.py).
RAW = json.loads((Path(__file__).parent / "fixtures" / "dhan_chain_NIFTY_2026-10-27.json").read_text(encoding="utf-8"))
OPEN = datetime(2026, 10, 21, 11, 5, 3, tzinfo=IST)  # Wednesday, market open
SATURDAY = datetime(2026, 10, 24, 11, 0, tzinfo=IST)
STOCKS = "HDFCBANK,ICICIBANK,NOSUCH"


class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False

    def __init__(self):
        self.chain_error = self.quote_error = self.history_error = None
        self.chain_calls = self.history_calls = 0

    def expiries(self, symbol):
        if isinstance(self.chain_error, TokenExpired):
            self.token_expired = True
            raise self.chain_error
        return ["2026-10-27", "2026-11-03"]

    def option_chain(self, symbol, expiry):
        self.chain_calls += 1
        if self.chain_error:
            if isinstance(self.chain_error, TokenExpired):
                self.token_expired = True
            raise self.chain_error
        return parse_chain(RAW)

    def ohlc(self, ids):
        if self.quote_error:
            raise self.quote_error
        return {"1333": {"ltp": 1712.4}, "4963": {"ltp": 1401.9}}

    def historical(self, security_id, from_date, to_date):
        self.history_calls += 1
        if self.history_error:
            raise self.history_error
        return {"timestamp": [1760985000, 1761071400], "close": [1700.0 + security_id % 7, 1705.0]}


class FakeIds:
    def resolve(self, symbols):
        known = {"HDFCBANK": 1333, "ICICIBANK": 4963}
        return {s: known[s] for s in symbols if s in known}, [s for s in symbols if s not in known]


class FakeInstruments:
    def chain(self, symbol, expiry):
        return [{"strike": 22800.0, "ce": {"lotSize": 65}, "pe": {"lotSize": 65}}]


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def make(clock=OPEN):
    fake, clk = FakeClient(), Clock(clock)
    tr = Tracker(fake, data_dir=tempfile.mkdtemp(), clock=clk)
    app = create_app(tr, security_ids=FakeIds(), instruments=FakeInstruments())
    return fake, tr, app, TestClient(app), clk


def summary(c, **q):
    params = {"symbol": "NIFTY", "expiry": "2026-10-27", "stocks": STOCKS, **q}
    return c.get("/api/dashboard/summary", params=params)


def test_all_cards_ok_after_the_previous_closes_warm_up():
    fake, tr, app, c, _ = make()
    tr.register("NIFTY", "2026-10-27")
    tr.poll_key(("NIFTY", "2026-10-27"), OPEN)  # one Trending OI snapshot (fills the chain cache too)

    first = summary(c).json()
    assert first["meta"] == {"symbol": "NIFTY", "expiry": "2026-10-27", "asOf": "2026-10-21 11:05:03",
                             "marketOpen": True, "tokenExpired": False, "message": ""}
    ch = first["chain"]
    assert ch["status"] == "ok" and ch["error"] == "" and ch["asOf"] == "2026-10-21 11:05:03"
    assert ch["data"]["meta"]["spot"] == 22811.35 and ch["data"]["meta"]["lotSize"] == 65 and len(ch["data"]["rows"]) == 261
    assert fake.chain_calls == 1  # the dashboard reused the tracker's fetch from the shared cache

    t = first["trendingOi"]
    assert t["status"] == "ok" and len(t["data"]["rows"]) == 1
    row = t["data"]["rows"][0]
    assert row["time"] == "11:05:00" and row["sentiment"] in ("Bullish", "Bearish") and "diffOi" in row and "netPcr" in row

    comp = first["components"]  # first call of the day: daily candles are fetched in the background
    assert comp["status"] == "warming" and comp["data"]["quotes"] == {"HDFCBANK": {"ltp": 1712.4}, "ICICIBANK": {"ltp": 1401.9}}
    assert comp["data"]["unknown"] == ["NOSUCH"] and comp["data"]["pending"] == ["HDFCBANK", "ICICIBANK"]

    app.state.dashboard_warmer.join(5)
    comp = summary(c).json()["components"]
    assert comp["status"] == "ok" and comp["data"]["pending"] == []
    assert comp["data"]["history"]["HDFCBANK"]["close"] == [1700.0 + 1333 % 7, 1705.0]
    assert fake.history_calls == 2  # once per stock per day
    summary(c)
    assert fake.history_calls == 2 and fake.chain_calls == 1


def test_a_failing_card_does_not_break_the_others():
    fake, tr, app, c, _ = make()
    fake.quote_error = DhanError("Dhan HTTP 500")
    r = summary(c)
    assert r.status_code == 200
    body = r.json()
    assert body["components"]["status"] == "error" and "500" in body["components"]["error"]
    assert body["chain"]["status"] == "ok" and len(body["chain"]["data"]["rows"]) == 261
    assert body["trendingOi"]["status"] == "empty"  # tracked now, first snapshot within a minute
    assert body["trendingOi"]["data"]["meta"]["message"].startswith("Waiting for the first snapshot")


def test_chain_failure_leaves_components_working():
    fake, tr, app, c, _ = make()
    fake.chain_error = DhanError("Dhan HTTP 502")
    body = summary(c).json()
    assert body["chain"]["status"] == "error" and "502" in body["chain"]["error"] and body["chain"]["data"] is None
    assert body["components"]["status"] in ("warming", "ok")


def test_stale_chain_is_served_with_its_error():
    fake, tr, app, c, clk = make()
    summary(c)
    clk.t += timedelta(seconds=30)  # past the 10 s cache
    fake.chain_error = DhanError("Dhan HTTP 502")
    ch = summary(c).json()["chain"]
    assert ch["status"] == "stale" and ch["data"]["meta"]["stale"] and ch["data"]["meta"]["ageSeconds"] == 30.0


def test_token_expired():
    fake, tr, app, c, _ = make()
    fake.chain_error = TokenExpired("Dhan access token expired")
    fake.quote_error = TokenExpired("Dhan access token expired")
    body = summary(c).json()
    assert body["meta"]["tokenExpired"] and "/api/token" in body["meta"]["message"]
    assert body["chain"]["status"] == "token" and "/api/token" in body["chain"]["error"]
    assert body["trendingOi"]["status"] == "token"
    assert body["components"]["status"] == "token"


def test_token_expired_while_finding_the_nearest_expiry():
    fake, tr, app, c, _ = make()
    fake.chain_error = TokenExpired("Dhan access token expired")
    body = summary(c, expiry="").json()
    assert body["meta"]["expiry"] == "" and body["chain"]["status"] == "token" and body["trendingOi"]["status"] == "token"


def test_market_closed():
    fake, tr, app, c, _ = make(SATURDAY)
    body = summary(c).json()
    assert body["meta"]["marketOpen"] is False
    assert body["chain"]["status"] == "ok" and "closed" in body["chain"]["data"]["meta"]["message"]
    t = body["trendingOi"]
    assert t["status"] == "empty" and t["data"]["meta"]["message"] == "Market is closed and nothing was recorded today."


def test_nearest_expiry_and_bad_input():
    fake, tr, app, c, _ = make()
    assert summary(c, expiry="").json()["meta"]["expiry"] == "2026-10-27"
    assert summary(c, symbol="FINNIFTY").status_code == 400
    assert summary(c, expiry="27-Oct-2026").status_code == 400
    assert summary(c, stocks=",".join(f"S{i}" for i in range(101))).status_code == 400
    empty = summary(c, stocks="").json()["components"]
    assert empty["status"] == "empty"
