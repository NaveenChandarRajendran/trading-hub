"""Postgres tests. They need a real database, so they only run when TEST_DATABASE_URL is set, e.g.
    set TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/some_throwaway_db
They TRUNCATE the toi_, sr_ and option_chain_snapshot tables, so never point this at a database holding data you want to keep."""
import os

import pytest
from fastapi.testclient import TestClient

from main import create_app
from store import PgStore
from test_api import FakeClient, at
from tracker import Tracker

DSN = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="set TEST_DATABASE_URL to run the Postgres tests")

SNAP = dict(spot=55629.35, strikes_used=15, call_chg=1053810.0, put_chg=410340.0,
            call_ltp=8751.6, put_ltp=6669.7, call_ltp_chg=-2201.5, put_ltp_chg=261.25)


@pytest.fixture
def store():
    s = PgStore(DSN)
    with s._cursor() as cur:
        cur.execute("TRUNCATE toi_snapshot, toi_session, sr_levels, sr_settings, option_chain_snapshot")
    yield s
    s.close()


def snap(ts, **over):
    return {"ts": ts, **SNAP, **over}


def test_roundtrip_and_fixed_strikes(store):
    a, b = snap("2026-10-19 09:20"), snap("2026-10-19 09:25", put_chg=500000.0)
    store.save("BANKNIFTY", "2026-10-27", "2026-10-19", [55500, 55600, 55700], [a, b], [a, b])
    strikes, snaps = store.load("BANKNIFTY", "2026-10-27", "2026-10-19")
    assert strikes == [55500.0, 55600.0, 55700.0]
    assert snaps == [a, b]
    # the day's strike set never changes, even if a later write tries
    store.save("BANKNIFTY", "2026-10-27", "2026-10-19", [1, 2, 3], [], [a, b])
    assert store.load("BANKNIFTY", "2026-10-27", "2026-10-19")[0] == [55500.0, 55600.0, 55700.0]


def test_same_minute_is_updated_not_duplicated(store):
    store.save("NIFTY", "2026-10-27", "2026-10-19", [24000], [snap("2026-10-19 10:00")], [])
    store.save("NIFTY", "2026-10-27", "2026-10-19", [24000], [snap("2026-10-19 10:00", put_chg=1.0)], [])
    _, snaps = store.load("NIFTY", "2026-10-27", "2026-10-19")
    assert len(snaps) == 1 and snaps[0]["put_chg"] == 1.0


def test_days_are_separate_in_ist(store):
    store.save("NIFTY", "2026-10-27", "2026-10-19", [24000], [snap("2026-10-19 15:40"), snap("2026-10-20 09:20")], [])
    assert [x["ts"] for x in store.load("NIFTY", "2026-10-27", "2026-10-19")[1]] == ["2026-10-19 15:40"]
    assert [x["ts"] for x in store.load("NIFTY", "2026-10-27", "2026-10-20")[1]] == ["2026-10-20 09:20"]
    assert store.load("NIFTY", "2026-11-03", "2026-10-19") == ([], [])


def test_restart_resumes_the_day_from_the_database(store):
    fake = FakeClient()
    tr = Tracker(fake, store=store, each_side=7, clock=lambda: at("09:27"))
    key = tr.register("BANKNIFTY", "2026-10-27")
    for i, hm in enumerate(["09:20", "09:21", "09:25"]):
        fake.bump = 10 * (i + 1)
        tr.poll_key(key, at(hm))
    before = TestClient(create_app(tr)).get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5").json()

    # "close the app and open it again": a brand new store, tracker and API on the same database
    store2 = PgStore(DSN)
    try:
        tr2 = Tracker(fake, store=store2, each_side=3, clock=lambda: at("09:40"))  # setting must not change today's strikes
        tr2.restore_today()                      # tracking resumes without anyone opening the page
        assert ("BANKNIFTY", "2026-10-27") in tr2._days
        after = TestClient(create_app(tr2)).get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5").json()
        assert after["rows"] == before["rows"] and len(after["rows"]) == 2   # 09:20 and 09:25 (+ live 09:21? no: 09:25 is last)
        assert after["meta"]["strikes"] == before["meta"]["strikes"] and after["meta"]["strikeCount"] == 15

        fake.bump = 40                           # and it carries on with the correct clock time
        tr2.poll_key(("BANKNIFTY", "2026-10-27"), at("09:30"))
        later = TestClient(create_app(tr2)).get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5").json()
        assert [r["time"] for r in later["rows"]] == ["09:30:00", "09:25:00", "09:20:00"]
    finally:
        store2.close()


def test_database_down_gives_503_not_a_crash(store):
    tr = Tracker(FakeClient(), store=store, clock=lambda: at("09:27"))
    store.close()
    r = TestClient(create_app(tr)).get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5")
    assert r.status_code == 503


def test_sr_level_rows_open_close_and_settings(store):
    row = {"slot": "S1", "strike": 22700.0, "oi": 1000.0, "valid_from": "2026-10-22 09:16", "valid_to": None, "reason": "open"}
    store.sr_write("NIFTY", "2026-10-27", "2026-10-22", [], [row])
    store.sr_write("NIFTY", "2026-10-27", "2026-10-22", [], [row])  # same row again: no duplicate
    nxt = {**row, "strike": 22600.0, "valid_from": "2026-10-22 10:47", "reason": "crossed"}
    store.sr_write("NIFTY", "2026-10-27", "2026-10-22", [{**row, "valid_to": "2026-10-22 10:47"}], [nxt])
    assert store.sr_rows("NIFTY", "2026-10-27", "2026-10-22") == [{**row, "valid_to": "2026-10-22 10:47"}, nxt]
    assert store.sr_rows("NIFTY", "2026-10-27", "2026-10-21") == []
    assert store.sr_settings() == {}
    store.save_sr_settings({"leadPct": 5, "confirmRefreshes": 2, "range": 400})
    assert store.sr_settings() == {"leadPct": 5, "confirmRefreshes": 2, "range": 400}


def test_chain_snapshots_roundtrip(store):
    snap = {"ts": "2026-10-23 09:16", "fetchedAt": "2026-10-23T09:16:03+05:30", "spot": 22700.5, "columns": ["strike"],
            "rows": [[22700.0, 1.0]]}
    store.save_chain_snapshot("NIFTY", "2026-10-27", "2026-10-23", snap)
    store.save_chain_snapshot("NIFTY", "2026-10-27", "2026-10-23", {**snap, "spot": 22701.0})  # same minute: replaced
    assert store.chain_snapshots("NIFTY", "2026-10-27", "2026-10-23") == [{**snap, "spot": 22701.0}]
    assert store.chain_snapshot_expiries("NIFTY", "2026-10-23") == ["2026-10-27"]
