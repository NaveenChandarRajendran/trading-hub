"""Strategies (strategies.py, strategies_api.py): the rules, and isolation - user B can't read, list, edit,
re-capitalise, reset, archive or unarchive user A's strategies through any endpoint (all 404, A's data unchanged).
Real login (auth.Auth + AuthMiddleware) with two users; runs on the JSON store and, with TEST_DATABASE_URL, on
Postgres (it TRUNCATEs th_users and, by cascade, th_strategies and the pt_ tables: use a throwaway database)."""
import os
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

from auth import Auth, MemoryAuthStore
from main import create_app
from paper_api import PaperService
from store import PaperJsonStore, PaperPgStore, PgStore
from test_api import FakeClient
from test_paper_api import Clock, FakeFeed, FakeInstruments
from tracker import Tracker

DSN = os.getenv("TEST_DATABASE_URL")
DAY = "2026-10-21"  # the test clock's day


@pytest.fixture(params=["json", "postgres"])
def env(request):
    tmp = tempfile.mkdtemp()
    pg = None
    if request.param == "json":
        store = PaperJsonStore(tmp)
    else:
        if not DSN:
            pytest.skip("set TEST_DATABASE_URL to run the Postgres strategy tests")
        pg = PgStore(DSN)
        with pg._cursor() as cur:
            cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users RESTART IDENTITY CASCADE")
            cur.execute("TRUNCATE pt_accounts RESTART IDENTITY CASCADE")
            cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen'), ('wife', 'Wife')")
        store = PaperPgStore(pg)
    clock = Clock()
    paper = PaperService(store, FakeFeed(), FakeInstruments(), clock=clock)
    auth = Auth(MemoryAuthStore())
    auth.create_user("naveen", "Naveen", "password-a1")
    auth.create_user("wife", "Wife", "password-b2")
    app = create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=paper, auth=auth)
    a, b = TestClient(app), TestClient(app)
    assert a.post("/api/auth/login", json={"username": "naveen", "password": "password-a1"}).status_code == 200
    assert b.post("/api/auth/login", json={"username": "wife", "password": "password-b2"}).status_code == 200
    yield a, b, store, clock
    if pg:
        pg.close()
    shutil.rmtree(tmp, ignore_errors=True)


def create(c, name, **kw):
    r = c.post("/api/strategies", json={"name": name, **kw})
    assert r.status_code == 200, r.text
    return r.json()["strategy"]


# ---------- rules ----------
def test_create_list_and_defaults(env):
    a, b, store, _ = env
    st = create(a, "  SuperTrend   15m ", description="Supertrend flip")
    assert st["name"] == "SuperTrend 15m" and st["kind"] == "manual" and st["capital"] == 100000
    assert st["archivedAt"] is None and "user_id" not in st and "account_id" not in st
    create(a, "EMA", capital=250000)
    names = [s["name"] for s in a.get("/api/strategies").json()["strategies"]]
    assert sorted(names) == ["EMA", "SuperTrend 15m"]
    acc = store.strategy(st["id"])["account_id"]
    assert acc and next(x for x in store.accounts() if x["id"] == acc)["capital"] == 100000  # its capital period


def test_names_unique_per_user_ignoring_case_but_free_across_users(env):
    a, b, _, _ = env
    create(a, "EMA")
    r = a.post("/api/strategies", json={"name": "ema"})
    assert r.status_code == 409 and "already have a strategy" in r.json()["detail"]
    create(b, "EMA")  # the wife can have her own "EMA"
    assert a.post("/api/strategies", json={"name": "   "}).status_code == 400
    assert a.post("/api/strategies", json={"name": "x" * 61}).status_code == 400


@pytest.mark.parametrize("capital", [9999, 10_00_00_001])
def test_capital_bounds(env, capital):
    a, _, _, _ = env
    assert a.post("/api/strategies", json={"name": "X", "capital": capital}).status_code == 400


def test_edit_name_description_and_markdown_notes(env):
    a, _, _, _ = env
    st = create(a, "EMA")
    notes = "## Rules\n- 9/21 EMA cross\n  - only after 09:30\n"
    r = a.patch(f"/api/strategies/{st['id']}", json={"name": "EMA cross", "notes": notes})
    assert r.status_code == 200 and r.json()["strategy"]["notes"] == notes
    assert a.get(f"/api/strategies/{st['id']}").json()["strategy"]["name"] == "EMA cross"
    create(a, "Other")
    assert a.patch(f"/api/strategies/{st['id']}", json={"name": "other"}).status_code == 409


def test_set_and_reset_capital_keep_history(env):
    a, _, store, _ = env
    st = create(a, "EMA")
    first = store.strategy(st["id"])["account_id"]
    assert a.put(f"/api/strategies/{st['id']}/capital", json={"capital": 200000}).json()["strategy"]["capital"] == 200000
    assert next(x for x in store.accounts() if x["id"] == first)["capital"] == 200000
    r = a.post(f"/api/strategies/{st['id']}/reset", json={"capital": 50000})
    assert r.status_code == 200 and r.json()["strategy"]["capital"] == 50000
    periods = [x for x in store.accounts() if x["strategy_id"] == st["id"]]
    assert len(periods) == 2 and periods[0]["archived_at"] and not periods[1]["archived_at"]  # old period kept
    assert a.post(f"/api/strategies/{st['id']}/reset").json()["strategy"]["capital"] == 50000  # same capital again


def test_capital_and_archive_need_a_flat_book(env):
    a, _, store, _ = env
    st = create(a, "EMA")
    acc = store.strategy(st["id"])["account_id"]
    store.save_position(acc, DAY, {"security_id": 1, "lot_size": 65, "buy_qty": 65, "sell_qty": 0, "avg_buy": 100.0,
                                   "avg_sell": 0.0, "realized": 0.0})
    for r in (a.put(f"/api/strategies/{st['id']}/capital", json={"capital": 200000}),
              a.post(f"/api/strategies/{st['id']}/reset"), a.post(f"/api/strategies/{st['id']}/archive")):
        assert r.status_code == 409 and "Exit open positions" in r.json()["detail"]
    store.save_position(acc, DAY, {"security_id": 1, "lot_size": 65, "buy_qty": 65, "sell_qty": 65, "avg_buy": 100.0,
                                   "avg_sell": 101.0, "realized": 65.0})
    assert a.post(f"/api/strategies/{st['id']}/archive").status_code == 200


def test_archived_is_read_only_until_unarchived(env):
    a, _, _, _ = env
    st = create(a, "EMA")
    r = a.post(f"/api/strategies/{st['id']}/archive")
    assert r.status_code == 200 and r.json()["strategy"]["archivedAt"]
    assert [s["name"] for s in a.get("/api/strategies").json()["strategies"]] == []
    assert [s["name"] for s in a.get("/api/strategies?archived=true").json()["strategies"]] == ["EMA"]
    assert a.get(f"/api/strategies/{st['id']}").status_code == 200  # still readable
    for r in (a.patch(f"/api/strategies/{st['id']}", json={"notes": "x"}),
              a.put(f"/api/strategies/{st['id']}/capital", json={"capital": 200000}),
              a.post(f"/api/strategies/{st['id']}/reset")):
        assert r.status_code == 409 and "read-only" in r.json()["detail"]
    assert a.post(f"/api/strategies/{st['id']}/unarchive").json()["strategy"]["archivedAt"] is None
    assert a.patch(f"/api/strategies/{st['id']}", json={"notes": "x"}).status_code == 200


def test_algo_strategy_owner_can_edit_notes_but_not_capital_or_archive(env):
    a, _, store, clock = env
    algo = store.create_strategy(1, "OI Breakout Algo", "", 100000, "algo", clock(), account_name="Algo")
    assert a.patch(f"/api/strategies/{algo['id']}", json={"notes": "B live"}).status_code == 200
    assert a.put(f"/api/strategies/{algo['id']}/capital", json={"capital": 200000}).status_code == 409
    assert a.post(f"/api/strategies/{algo['id']}/archive").status_code == 409
    assert [s["kind"] for s in a.get("/api/strategies").json()["strategies"]] == ["algo"]


# ---------- isolation ----------
def test_user_b_can_do_nothing_with_user_a_strategies(env):
    a, b, store, clock = env
    st = create(a, "SuperTrend", description="mine")
    algo = store.create_strategy(1, "OI Breakout Algo", "", 100000, "algo", clock(), account_name="Algo")
    before = {s["id"]: store.strategy(s["id"]) for s in (st, algo)}
    assert b.get("/api/strategies").json()["strategies"] == []
    assert b.get("/api/strategies?archived=true").json()["strategies"] == []
    for sid in (st["id"], algo["id"]):
        calls = [
            b.get(f"/api/strategies/{sid}"),
            b.patch(f"/api/strategies/{sid}", json={"name": "stolen", "notes": "x"}),
            b.put(f"/api/strategies/{sid}/capital", json={"capital": 500000}),
            b.post(f"/api/strategies/{sid}/reset", json={"capital": 500000}),
            b.post(f"/api/strategies/{sid}/archive"),
            b.post(f"/api/strategies/{sid}/unarchive"),
        ]
        for r in calls:
            assert r.status_code == 404 and r.json()["detail"] == "Strategy not found.", r.request.url
    assert {s: store.strategy(s) for s in before} == before  # nothing changed
    assert len([x for x in store.accounts() if x["strategy_id"] == st["id"]]) == 1  # no reset happened
    # same answer as for an id that doesn't exist, so ids reveal nothing
    assert a.get("/api/strategies/99999").json() == b.get(f"/api/strategies/{st['id']}").json()
    assert a.get("/api/strategies/abc").status_code == 404


def test_the_owner_sees_their_strategy(env):
    a, b, _, _ = env
    mine = create(b, "Wife's EMA")
    assert b.get(f"/api/strategies/{mine['id']}").json()["strategy"]["name"] == "Wife's EMA"
    assert a.get(f"/api/strategies/{mine['id']}").status_code == 404
    assert [s["name"] for s in a.get("/api/strategies").json()["strategies"]] == []
