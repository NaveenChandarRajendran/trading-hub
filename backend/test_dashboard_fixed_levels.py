"""Dashboard "Fix zones" (dashboard_levels_api.py + store): fix / unfix, one active set per index + expiry, kept across
a reload and a backend restart. The Postgres part runs with TEST_DATABASE_URL (a throwaway database)."""
import os
import tempfile
from datetime import datetime

import psycopg2
import pytest
from fastapi.testclient import TestClient

from main import create_app
from store import IST, PgStore
from test_api import FakeClient
from tracker import Tracker

DSN = os.getenv("TEST_DATABASE_URL")
LV = {"R1": 22700.0, "R2": 22800.0, "R3": 23000.0, "S1": 22500.0, "S2": 22400.0, "S3": 22200.0}


class Clock:
    now = datetime(2026, 10, 26, 10, 15, 4, tzinfo=IST)

    def __call__(self):
        return self.now


def client(store=None):
    clock = Clock()
    tmp = tempfile.mkdtemp()
    tr = Tracker(FakeClient(), store=store, data_dir=tmp, clock=clock) if store else Tracker(FakeClient(), data_dir=tmp, clock=clock)
    return TestClient(create_app(tr)), clock


def test_fix_unfix_and_one_set_per_index_and_expiry():
    c, clock = client()
    q = "index=NIFTY&expiry=2026-10-27"
    assert c.get(f"/api/dashboard/fixed-levels?{q}").json() == {"fixed": None}
    r = c.put("/api/dashboard/fixed-levels", json={"index": "nifty", "expiry": "2026-10-27", "levels": {**LV, "R3": None}})
    assert r.json() == {"fixed": {"fixedAt": "2026-10-26T10:15:04+05:30", "levels": {k: v for k, v in LV.items() if k != "R3"}}}
    # another expiry and the other index are separate
    assert c.get("/api/dashboard/fixed-levels?index=NIFTY&expiry=2026-11-03").json() == {"fixed": None}
    assert c.get("/api/dashboard/fixed-levels?index=BANKNIFTY&expiry=2026-10-27").json() == {"fixed": None}
    # fixing again replaces the active set
    clock.now = datetime(2026, 10, 26, 11, 0, tzinfo=IST)
    c.put("/api/dashboard/fixed-levels", json={"index": "NIFTY", "expiry": "2026-10-27", "levels": {"S1": 22400.0}})
    assert c.get(f"/api/dashboard/fixed-levels?{q}").json()["fixed"] == {"fixedAt": "2026-10-26T11:00:00+05:30", "levels": {"S1": 22400.0}}
    assert c.delete(f"/api/dashboard/fixed-levels?{q}").json() == {"fixed": None}
    assert c.get(f"/api/dashboard/fixed-levels?{q}").json() == {"fixed": None}


def test_bad_requests():
    c, _ = client()
    assert c.get("/api/dashboard/fixed-levels?index=FINNIFTY&expiry=2026-10-27").status_code == 400
    assert c.get("/api/dashboard/fixed-levels?index=NIFTY&expiry=27-10-2026").status_code == 400
    assert c.put("/api/dashboard/fixed-levels", json={"index": "NIFTY", "expiry": "2026-10-27", "levels": {"R4": 1}}).status_code == 400
    assert c.put("/api/dashboard/fixed-levels", json={"index": "NIFTY", "expiry": "2026-10-27", "levels": {}}).status_code == 400


@pytest.fixture
def pg():
    if not DSN:
        pytest.skip("set TEST_DATABASE_URL to run the Postgres Fix zones tests")
    store = PgStore(DSN)
    with store._cursor() as cur:
        cur.execute("TRUNCATE dashboard_fixed_levels")
    yield store
    store.close()


def test_postgres_keeps_the_fixed_set_across_a_restart_and_one_active_per_key(pg):
    c, clock = client(pg)
    c.put("/api/dashboard/fixed-levels", json={"index": "NIFTY", "expiry": "2026-10-27", "levels": LV})
    c.put("/api/dashboard/fixed-levels", json={"index": "BANKNIFTY", "expiry": "2026-10-27", "levels": {"S1": 54700.0}})
    clock.now = datetime(2026, 10, 26, 10, 30, tzinfo=IST)
    c.put("/api/dashboard/fixed-levels", json={"index": "NIFTY", "expiry": "2026-10-27", "levels": {**LV, "S1": 22400.0}})
    restarted = PgStore(DSN)  # a new process: only what is in Postgres
    try:
        got = restarted.fixed_levels("NIFTY", "2026-10-27")
        assert got == {"fixedAt": "2026-10-26T10:30:00+05:30", "levels": {**LV, "S1": 22400.0}}
        assert restarted.fixed_levels("BANKNIFTY", "2026-10-27")["levels"] == {"S1": 54700.0}
        with restarted._cursor() as cur:
            cur.execute('SELECT "index", count(*) FILTER (WHERE active), count(*) FROM dashboard_fixed_levels GROUP BY 1 ORDER BY 1')
            assert cur.fetchall() == [("BANKNIFTY", 1, 1), ("NIFTY", 1, 2)]  # the replaced set is kept, inactive
            with pytest.raises(psycopg2.errors.UniqueViolation):  # the database itself allows one active set
                cur.execute('INSERT INTO dashboard_fixed_levels ("index", expiry, fixed_at) VALUES (%s, %s, now())',
                            ("NIFTY", "2026-10-27"))
        restarted.unfix_levels("NIFTY", "2026-10-27", clock.now)
        assert restarted.fixed_levels("NIFTY", "2026-10-27") is None
        assert restarted.fixed_levels("BANKNIFTY", "2026-10-27") is not None
    finally:
        restarted.close()
