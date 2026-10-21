"""Index candles for the Dashboard: IST buckets from ticks, aggregation, Dhan intraday parsing, GET /api/dashboard/candles
and the live "candle" message on /ws/paper. 2026-10-20 is an NSE holiday, so the session before 2026-10-21 is 2026-10-19."""
import shutil
import tempfile
import time as _time
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient

from candles import CandleBuilder, aggregate, bucket_start, epoch, parse_intraday, recent_sessions
from dhan_client import DhanError, TokenExpired
from main import create_app
from store import IST, PaperJsonStore
from test_paper_api import FakeFeed, FakeInstruments
from paper_api import PaperService
from tracker import Tracker


def ist(s):  # "2026-10-21 09:17:59"
    return datetime.fromisoformat(s).replace(tzinfo=IST)


def hm(epoch_s):
    return datetime.fromtimestamp(epoch_s, IST).strftime("%Y-%m-%d %H:%M")


# ---------- buckets ----------
@pytest.mark.parametrize("t, interval, start", [
    ("2026-10-21 09:15:00", 1, "09:15"), ("2026-10-21 09:15:59", 1, "09:15"), ("2026-10-21 09:16:00", 1, "09:16"),
    ("2026-10-21 09:17:59", 3, "09:15"), ("2026-10-21 09:18:00", 3, "09:18"),
    ("2026-10-21 09:19:59", 5, "09:15"), ("2026-10-21 09:20:00", 5, "09:20"),
    ("2026-10-21 09:29:59", 15, "09:15"), ("2026-10-21 09:30:00", 15, "09:30"),
    ("2026-10-21 15:29:59", 1, "15:29"), ("2026-10-21 15:29:59", 15, "15:15"),
])
def test_bucket_start_in_ist_from_the_open(t, interval, start):
    assert bucket_start(ist(t), interval).strftime("%H:%M") == start


def test_bucket_uses_ist_even_for_a_utc_time():
    utc = datetime.fromisoformat("2026-10-21T03:47:30+00:00")  # 09:17:30 IST
    assert bucket_start(utc, 1) == ist("2026-10-21 09:17:00")


# ---------- live candles from ticks ----------
def test_builder_makes_one_candle_per_ist_minute():
    b, key = CandleBuilder(), ("IDX_I", 13)
    assert b.on_tick(key, 22950, ist("2026-10-21 09:14:59")) is None  # pre-open
    c1 = b.on_tick(key, 22950.0, ist("2026-10-21 09:15:00"))
    assert c1 == {"time": epoch(ist("2026-10-21 09:15:00")), "open": 22950.0, "high": 22950.0, "low": 22950.0, "close": 22950.0}
    b.on_tick(key, 22962.5, ist("2026-10-21 09:15:20"))
    c = b.on_tick(key, 22940.1, ist("2026-10-21 09:15:59.900"))
    assert (c["open"], c["high"], c["low"], c["close"]) == (22950.0, 22962.5, 22940.1, 22940.1)
    nxt = b.on_tick(key, 22941.0, ist("2026-10-21 09:16:00"))  # exactly on the minute edge: a new candle
    assert hm(nxt["time"]) == "2026-10-21 09:16" and nxt["open"] == 22941.0
    assert b.on_tick(("IDX_I", 25), 54800.0, ist("2026-10-21 09:16:01"))["open"] == 54800.0  # separate per index
    last = b.on_tick(key, 22990.0, ist("2026-10-21 15:29:59"))
    assert hm(last["time"]) == "2026-10-21 15:29"
    assert b.on_tick(key, 22991.0, ist("2026-10-21 15:30:00")) is None  # session over
    assert b.on_tick(key, 0, ist("2026-10-21 10:00:00")) is None  # no price


# ---------- aggregation + Dhan parsing ----------
def one_min(day, hhmm_close):
    return [{"time": epoch(ist(f"{day} {t}:00")), "open": c - 1, "high": c + 2, "low": c - 3, "close": c} for t, c in hhmm_close]


def test_aggregate_aligns_to_0915_per_day():
    rows = one_min("2026-10-19", [("15:27", 100), ("15:28", 101), ("15:29", 99)]) + \
           one_min("2026-10-21", [("09:15", 10), ("09:16", 12), ("09:17", 11), ("09:18", 20), ("09:20", 21)])
    three = aggregate(rows, 3)
    assert [hm(c["time"]) for c in three] == ["2026-10-19 15:27", "2026-10-21 09:15", "2026-10-21 09:18"]
    c = three[1]  # 09:15, 09:16, 09:17
    assert (c["open"], c["high"], c["low"], c["close"]) == (9, 14, 7, 11)
    assert three[2]["close"] == 21  # 09:18 + 09:20 (09:19 missing) stay in one 3-min bucket
    five = aggregate(rows, 5)
    assert [hm(c["time"]) for c in five] == ["2026-10-19 15:25", "2026-10-21 09:15", "2026-10-21 09:20"]
    assert aggregate(rows, 1) == rows


def test_parse_intraday_sorts_and_keeps_the_session_only():
    t = lambda s: int(ist(s).timestamp())  # noqa: E731
    payload = {"timestamp": [t("2026-10-21 09:16:00"), t("2026-10-21 09:15:00"), t("2026-10-21 09:08:00"), "bad"],
               "open": [2, 1, 0, 9], "high": [3, 2, 0, 9], "low": [1, 0.5, 0, 9], "close": [2.5, 1.5, 0, 9], "volume": [0, 0, 0, 0]}
    rows = parse_intraday(payload)
    assert [hm(r["time"])[-5:] for r in rows] == ["09:15", "09:16"] and rows[0]["close"] == 1.5
    assert parse_intraday({}) == []


def test_recent_sessions_skip_weekends_and_holidays():
    assert recent_sessions(date(2026, 10, 21)) == [date(2026, 10, 19), date(2026, 10, 21)]  # 20th is a holiday
    assert recent_sessions(date(2026, 10, 24)) == [date(2026, 10, 22), date(2026, 10, 23)]  # Saturday: last two sessions
    assert recent_sessions(date(2026, 10, 19)) == [date(2026, 10, 16), date(2026, 10, 19)]  # Monday


# ---------- GET /api/dashboard/candles ----------
class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False

    def __init__(self):
        self.calls, self.args, self.error = 0, None, None

    def expiries(self, symbol):
        return ["2026-10-27"]

    def intraday(self, symbol, from_dt, to_dt, interval=1):
        self.calls += 1
        self.args = (symbol, from_dt, to_dt, interval)
        if self.error:
            if isinstance(self.error, TokenExpired):
                self.token_expired = True
            raise self.error
        rows = one_min("2026-10-19", [("15:28", 22900), ("15:29", 22910)]) + \
            one_min("2026-10-21", [("09:15", 22950), ("09:16", 22960), ("09:17", 22955), ("09:18", 22970)])
        return {k: [r[k2] for r in rows] for k, k2 in
                (("timestamp", "time"), ("open", "open"), ("high", "high"), ("low", "low"), ("close", "close"))} | {"volume": [0] * len(rows)}


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def candle_app(now="2026-10-21 09:19:10"):
    fake, clock = FakeClient(), Clock(ist(now))
    tr = Tracker(fake, data_dir=tempfile.mkdtemp(), clock=clock)
    return fake, clock, TestClient(create_app(tr))


def test_candles_endpoint_today_and_previous_session():
    fake, clock, c = candle_app()
    body = c.get("/api/dashboard/candles?symbol=nifty&interval=3").json()
    assert fake.args == ("NIFTY", "2026-10-19 09:15:00", "2026-10-21 15:30:00", 1)  # 20th skipped (holiday)
    m = body["meta"]
    assert m["sessions"] == ["2026-10-19", "2026-10-21"] and m["interval"] == 3 and m["marketOpen"] and m["lastError"] == ""
    assert [hm(x["time"]) for x in body["candles"]] == ["2026-10-19 15:27", "2026-10-21 09:15", "2026-10-21 09:18"]
    assert body["candles"][1]["close"] == 22955 and body["candles"][1]["high"] == 22962

    one = c.get("/api/dashboard/candles?symbol=NIFTY&interval=1").json()
    assert len(one["candles"]) == 6 and fake.calls == 1  # every interval comes from the same cached 1-minute data
    clock.t = ist("2026-10-21 09:20:11")  # 61 s later: refetch completed minutes
    c.get("/api/dashboard/candles?symbol=NIFTY&interval=5")
    assert fake.calls == 2


def test_candles_endpoint_errors():
    fake, clock, c = candle_app()
    assert c.get("/api/dashboard/candles?symbol=FINNIFTY").status_code == 400
    assert c.get("/api/dashboard/candles?interval=2").status_code == 400
    fake.error = TokenExpired("Dhan access token expired")
    r = c.get("/api/dashboard/candles?symbol=NIFTY&interval=5")
    assert r.status_code == 401 and "/api/token" in r.json()["detail"]


def test_candles_endpoint_keeps_last_candles_when_a_refresh_fails():
    fake, clock, c = candle_app()
    c.get("/api/dashboard/candles?symbol=NIFTY&interval=1")
    clock.t = ist("2026-10-21 09:25:00")
    fake.error = DhanError("Dhan HTTP 502")
    body = c.get("/api/dashboard/candles?symbol=NIFTY&interval=1").json()
    assert "502" in body["meta"]["lastError"] and len(body["candles"]) == 6


def test_candles_endpoint_market_closed_shows_the_last_two_sessions():
    fake, clock, c = candle_app("2026-10-24 11:00:00")  # Saturday
    body = c.get("/api/dashboard/candles?symbol=NIFTY&interval=5").json()
    assert body["meta"]["marketOpen"] is False and body["meta"]["sessions"] == ["2026-10-22", "2026-10-23"]
    assert fake.args[1:3] == ("2026-10-22 09:15:00", "2026-10-23 15:30:00")


# ---------- live candle over /ws/paper ----------
def test_index_ticks_push_the_live_candle_to_subscribed_clients():
    tmp = tempfile.mkdtemp()
    try:
        clock, feed = Clock(ist("2026-10-21 09:20:05")), FakeFeed()
        svc = PaperService(PaperJsonStore(tmp), feed, FakeInstruments(), clock=clock)
        c = TestClient(create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=svc))
        with c.websocket_connect("/ws/paper") as ws:
            assert ws.receive_json()["type"] == "snapshot"
            ws.send_json({"type": "subscribe", "instruments": [["IDX_I", 13]]})
            end = _time.monotonic() + 2
            while ("IDX_I", 13) not in feed.subs:
                assert _time.monotonic() < end
                _time.sleep(0.005)
            svc.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 13, "ltp": 22957.05})
            assert ws.receive_json()["type"] == "tick"
            msg = ws.receive_json()
            assert msg == {"type": "candle", "data": {"segment": "IDX_I", "securityId": 13, "interval": 1,
                                                      "time": epoch(ist("2026-10-21 09:20:00")), "open": 22957.05,
                                                      "high": 22957.05, "low": 22957.05, "close": 22957.05}}
            svc.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 25, "ltp": 54800})  # not subscribed
            clock.t = ist("2026-10-21 09:20:40")
            svc.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 13, "ltp": 22961.0})
            assert ws.receive_json()["type"] == "tick"
            assert ws.receive_json()["data"]["high"] == 22961.0  # same minute, updated in place
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
