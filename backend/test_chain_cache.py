"""Shared option-chain cache + GET /api/option-chain, against a real captured Dhan chain (capture_chain.py)."""
import json
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from chain_cache import ChainCache
from dhan_client import DhanError, TokenExpired, parse_chain
from authfake import create_app
from tracker import IST, Tracker

# NIFTY 27-Oct-2026 chain captured 21-Oct-2026 after the close.
RAW = json.loads((Path(__file__).parent / "fixtures" / "dhan_chain_NIFTY_2026-10-27.json").read_text(encoding="utf-8"))


class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False

    def __init__(self, delay=0.0):
        self.calls, self.delay, self.fail = 0, delay, None

    def expiries(self, symbol):
        return ["2026-10-27", "2026-11-03"]

    def option_chain(self, symbol, expiry):
        self.calls += 1
        time.sleep(self.delay)
        if self.fail:
            if isinstance(self.fail, TokenExpired):
                self.token_expired = True
            raise self.fail
        return parse_chain(RAW)


class FakeInstruments:
    def chain(self, symbol, expiry):
        return [{"strike": 22800.0, "ce": {"lotSize": 65}, "pe": {"lotSize": 65}}]


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


OPEN = datetime(2026, 10, 21, 11, 5, 3, tzinfo=IST)  # Wednesday, market open


def test_fixture_is_a_real_dhan_chain():
    chain = parse_chain(RAW)
    assert chain["spot"] == 22811.35 and len(chain["oc"]) == 261
    ce = chain["oc"][22800.0]["ce"]  # values read straight from the captured file
    assert ce["oi"] == 7844655 and ce["previous_oi"] == 2397200 and ce["last_price"] == 135.95
    assert ce["oi"] % 65 == 0  # Dhan OI is in units (NIFTY lot 65), not contracts


def test_serves_from_memory_within_ttl_then_refetches():
    fake, clock = FakeClient(), Clock(OPEN)
    cache = ChainCache(fake, clock=clock)
    e1, cached1 = cache.get("NIFTY", "2026-10-27")
    clock.t += timedelta(seconds=9)
    e2, cached2 = cache.get("NIFTY", "2026-10-27")
    assert (cached1, cached2, fake.calls) == (False, True, 1) and e2 is e1
    clock.t += timedelta(seconds=2)  # 11 s old > 10 s TTL
    assert cache.get("NIFTY", "2026-10-27")[1] is False and fake.calls == 2
    cache.get("NIFTY", "2026-11-03")  # another expiry is another key
    assert fake.calls == 3


def test_market_closed_keeps_the_chain_for_five_minutes():
    fake, clock = FakeClient(), Clock(OPEN)
    cache = ChainCache(fake, market_open=lambda: False, clock=clock)
    cache.get("NIFTY", "2026-10-27")
    clock.t += timedelta(seconds=299)
    cache.get("NIFTY", "2026-10-27")
    assert fake.calls == 1


def test_max_age_zero_always_fetches():
    fake = FakeClient()
    cache = ChainCache(fake, clock=Clock(OPEN))
    cache.get("NIFTY", "2026-10-27")
    cache.get("NIFTY", "2026-10-27", max_age=0)
    assert fake.calls == 2


def test_concurrent_requests_share_one_fetch():
    fake = FakeClient(delay=0.3)
    cache = ChainCache(fake, clock=Clock(OPEN))
    out = []
    threads = [threading.Thread(target=lambda: out.append(cache.get("NIFTY", "2026-10-27"))) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert fake.calls == 1 and len(out) == 3
    assert sorted(cached for _, cached in out) == [False, True, True]


def test_failed_refresh_serves_last_good_chain_unless_stale_is_refused():
    fake, clock = FakeClient(), Clock(OPEN)
    cache = ChainCache(fake, clock=clock)
    good, _ = cache.get("NIFTY", "2026-10-27")
    clock.t += timedelta(seconds=30)
    fake.fail = DhanError("Dhan HTTP 502")
    stale, cached = cache.get("NIFTY", "2026-10-27")
    assert cached and stale.chain is good.chain and stale.fetched_at == good.fetched_at and "502" in stale.last_error
    with pytest.raises(DhanError):
        cache.get("NIFTY", "2026-10-27", allow_stale=False)
    fake.fail = None  # failures are not cached: the next request fetches again and clears the error
    fresh, cached = cache.get("NIFTY", "2026-10-27")
    assert not cached and fresh.last_error == ""
    with pytest.raises(DhanError):  # nothing to fall back to
        fake.fail = DhanError("boom")
        cache.get("NIFTY", "2026-11-03")


def make_app(fake, clock=None):
    tr = Tracker(fake, data_dir=tempfile.mkdtemp(), clock=clock or (lambda: OPEN))
    return tr, TestClient(create_app(tr, instruments=FakeInstruments()))


def test_endpoint_returns_the_chain_with_meta():
    fake = FakeClient()
    _, c = make_app(fake)
    r = c.get("/api/option-chain?symbol=nifty&expiry=2026-10-27")
    assert r.status_code == 200
    body = r.json()
    m = body["meta"]
    assert m["symbol"] == "NIFTY" and m["expiry"] == "2026-10-27" and m["spot"] == 22811.35
    assert m["lotSize"] == 65 and m["strikeStep"] == 50 and m["marketOpen"] is True
    assert m["asOf"] == "2026-10-21 11:05:03" and m["cached"] is False and m["stale"] is False and m["message"] == ""
    strikes = [row["strike"] for row in body["rows"]]
    assert len(strikes) == 261 and strikes == sorted(strikes)
    row = next(x for x in body["rows"] if x["strike"] == 22800)
    assert row["ce"]["oi"] == 7844655 and row["pe"]["previous_oi"] == 4289285  # Dhan fields passed through, in units

    assert c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27").json()["meta"]["cached"] is True
    assert c.get("/api/option-chain?symbol=NIFTY").json()["meta"]["expiry"] == "2026-10-27"  # nearest expiry
    assert fake.calls == 1


def test_endpoint_errors():
    fake = FakeClient()
    _, c = make_app(fake)
    assert c.get("/api/option-chain?symbol=FINNIFTY").status_code == 400
    assert c.get("/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026").status_code == 400
    fake.fail = DhanError("Dhan HTTP 500")
    assert c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27").status_code == 502
    fake.fail = TokenExpired("Dhan access token expired")
    r = c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27")
    assert r.status_code == 401 and "/api/token" in r.json()["detail"]


def test_token_expiry_after_a_good_fetch_keeps_serving_the_chain():
    fake, clock = FakeClient(), Clock(OPEN)
    _, c = make_app(fake, clock)
    c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27")
    clock.t += timedelta(seconds=60)
    fake.fail = TokenExpired("Dhan access token expired")
    m = c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27").json()["meta"]
    assert m["tokenExpired"] and m["stale"] and m["ageSeconds"] == 60.0 and "token expired" in m["message"]


def test_market_closed_message():
    fake = FakeClient()
    _, c = make_app(fake, lambda: datetime(2026, 10, 24, 11, 0, tzinfo=IST))  # Saturday
    m = c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27").json()["meta"]
    assert m["marketOpen"] is False and "closed" in m["message"]


def test_tracker_poll_fills_the_shared_cache():
    fake = FakeClient()
    tr, c = make_app(fake)
    key = tr.register("NIFTY", "2026-10-27")
    snap = tr.poll_key(key, OPEN)
    assert snap["spot"] == 22811.35 and fake.calls == 1
    m = c.get("/api/option-chain?symbol=NIFTY&expiry=2026-10-27").json()["meta"]
    assert m["cached"] is True and fake.calls == 1  # the live page reused the tracker's fetch
    tr.poll_key(key, OPEN)  # the tracker itself never takes a cached chain
    assert fake.calls == 2
