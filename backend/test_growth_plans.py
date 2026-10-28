"""Growth Plans (growth_plans.py, growth_plans_api.py): rules, privacy (user B gets 404 on everything of user A's),
one active plan per strategy with history, capital changes recorded as cash flows (never profit), and the tracker's
inputs from the strategy's fills. Real login with two users; JSON store and, with TEST_DATABASE_URL, Postgres (it
TRUNCATEs th_users and by cascade the strategies, plans and pt_ tables: use a throwaway database)."""
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
DAY = "2026-10-21"
PLAN = {"name": "24% plan", "yearlyPct": 24, "method": "compounded", "initialCapital": 100000, "startMonth": "2026-11"}


@pytest.fixture(params=["json", "postgres"])
def env(request):
    tmp = tempfile.mkdtemp()
    pg = None
    if request.param == "json":
        store = PaperJsonStore(tmp)
    else:
        if not DSN:
            pytest.skip("set TEST_DATABASE_URL to run the Postgres growth plan tests")
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


def plan(c, **kw):
    r = c.post("/api/plans", json={**PLAN, **kw})
    assert r.status_code == 200, r.text
    return r.json()["plan"]


def strategy(c, name="SuperTrend", capital=100000):
    r = c.post("/api/strategies", json={"name": name, "capital": capital})
    assert r.status_code == 200, r.text
    return r.json()["strategy"]


def closed_trade(store, acc, realized, charge=20.0, day=DAY, n=1):
    """One bought-and-sold round trip on `day`: two fills (charge each) and its closed position."""
    charges = {"brokerage": charge, "stt": 0.0, "transaction": 0.0, "sebi": 0.0, "stamp": 0.0, "gst": 0.0, "total": charge}
    d = day.replace("-", "")
    for i, side in enumerate(("BUY", "SELL")):
        store.save_trade(acc, day, {"id": f"TR{d}-{n:02d}{i + 1:02d}", "order_id": f"PT{d}-{n:02d}{i + 1:02d}",
                                    "security_id": n, "side": side, "qty": 65, "price": 100.0, "value": 6500.0,
                                    "charges": charges, "time": f"{day}T10:00:00+05:30"})
    store.save_position(acc, day, {"security_id": n, "lot_size": 65, "buy_qty": 65, "sell_qty": 65, "avg_buy": 100.0,
                                   "avg_sell": 100.0 + realized / 65, "realized": realized})


# ---------- plans ----------
def test_create_list_edit_and_validation(env):
    a, *_ = env
    p = plan(a)
    assert {k: p[k] for k in ("name", "yearlyPct", "method", "initialCapital", "startMonth", "years")} == \
        {"name": "24% plan", "yearlyPct": 24.0, "method": "compounded", "initialCapital": 100000.0,
         "startMonth": "2026-11", "years": 5}
    assert p["appliedTo"] == []
    assert a.patch(f"/api/plans/{p['id']}", json={"years": 10}).json()["plan"]["years"] == 10  # "+5 years"
    assert a.patch(f"/api/plans/{p['id']}", json={"years": 20}).status_code == 200
    assert a.patch(f"/api/plans/{p['id']}", json={"years": 25}).status_code == 400  # at most 20
    for bad in ({"method": "fancy"}, {"yearlyPct": 0}, {"initialCapital": 500}, {"startMonth": "2026-13"},
                {"startMonth": "Nov 2026"}, {"name": "  "}, {"years": 0}):
        assert a.post("/api/plans", json={**PLAN, **bad}).status_code == 400, bad
    assert [x["name"] for x in a.get("/api/plans").json()["plans"]] == ["24% plan"]


def test_plans_are_private(env):
    a, b, *_ = env
    p = plan(a)
    st_a = strategy(a)
    pb, st_b = plan(b, name="Hers"), strategy(b, "EMA")
    assert [x["name"] for x in b.get("/api/plans").json()["plans"]] == ["Hers"]
    for r in (b.get(f"/api/plans/{p['id']}"), b.patch(f"/api/plans/{p['id']}", json={"name": "x"}),
              b.post(f"/api/plans/{p['id']}/archive"),
              b.post(f"/api/strategies/{st_b['id']}/plan", json={"planId": p["id"]}),  # A's plan on her strategy
              b.post(f"/api/strategies/{st_a['id']}/plan", json={"planId": pb["id"]}),  # her plan on A's strategy
              b.get(f"/api/strategies/{st_a['id']}/plan"), b.delete(f"/api/strategies/{st_a['id']}/plan")):
        assert r.status_code == 404, (r.request.method, r.request.url)
    assert a.get(f"/api/plans/{p['id']}").json()["plan"]["name"] == "24% plan"  # unchanged


def test_one_active_plan_per_strategy_with_history(env):
    a, *_ = env
    st = strategy(a, capital=200000)
    p1, p2 = plan(a, name="One"), plan(a, name="Two")
    m = a.post(f"/api/strategies/{st['id']}/plan", json={"planId": p1["id"]}).json()["mapping"]
    assert m["initialCapital"] == 200000  # default: the strategy's capital
    a.post(f"/api/strategies/{st['id']}/plan", json={"planId": p2["id"], "initialCapital": 150000})
    t = a.get(f"/api/strategies/{st['id']}/plan").json()
    assert t["plan"]["name"] == "Two" and t["mapping"]["initialCapital"] == 150000
    assert [h["planName"] for h in t["history"]] == ["One"] and t["history"][0]["endedAt"]
    assert [x["appliedTo"] for x in a.get("/api/plans").json()["plans"]] == [[], [{"id": st["id"], "name": "SuperTrend"}]]
    a.delete(f"/api/strategies/{st['id']}/plan")
    t = a.get(f"/api/strategies/{st['id']}/plan").json()
    assert t["plan"] is None and [h["planName"] for h in t["history"]] == ["Two", "One"]


def test_archiving_a_plan_ends_its_links(env):
    a, *_ = env
    st, p = strategy(a), plan(a)
    a.post(f"/api/strategies/{st['id']}/plan", json={"planId": p["id"]})
    assert a.post(f"/api/plans/{p['id']}/archive").status_code == 200
    assert a.get(f"/api/strategies/{st['id']}/plan").json()["plan"] is None
    assert a.get("/api/plans").json()["plans"] == [] and len(a.get("/api/plans?archived=true").json()["plans"]) == 1
    assert a.post(f"/api/strategies/{st['id']}/plan", json={"planId": p["id"]}).status_code == 409
    assert a.patch(f"/api/plans/{p['id']}", json={"years": 10}).status_code == 409


# ---------- tracker inputs ----------
def test_capital_changes_are_cash_flows_not_profit(env):
    a, _, store, _ = env
    st = strategy(a, capital=100000)
    acc = store.strategy(st["id"])["account_id"]
    closed_trade(store, acc, 650.0)  # +650 realized, 40 charges -> net +610
    assert a.put(f"/api/strategies/{st['id']}/capital", json={"capital": 150000}).status_code == 200
    a.post(f"/api/strategies/{st['id']}/reset", json={"capital": 120000})
    t = a.get(f"/api/strategies/{st['id']}/plan").json()
    assert [(f["kind"], f["amount"]) for f in t["flows"]] == [("set", 50000.0), ("reset", round(120000 - 150610, 2))]
    assert t["days"] == [{"date": DAY, "net": 610.0}]  # only the trade's net is profit
    kinds = [e["kind"] for e in store.capital_events(st["id"])]
    assert kinds == ["start", "set", "reset"]


def test_tracker_days_add_up_every_capital_period(env):
    a, _, store, _ = env
    st = strategy(a)
    first = store.strategy(st["id"])["account_id"]
    closed_trade(store, first, 1300.0, day="2026-10-20", n=1)
    a.post(f"/api/strategies/{st['id']}/reset")
    second = store.strategy(st["id"])["account_id"]
    closed_trade(store, second, -650.0, day=DAY, n=2)
    t = a.get(f"/api/strategies/{st['id']}/plan").json()
    assert t["days"] == [{"date": "2026-10-20", "net": 1260.0}, {"date": DAY, "net": -690.0}]
    assert t["today"] == DAY and t["unrealized"] == 0.0 and t["strategy"]["name"] == "SuperTrend"


# ---------- edit every field, delete ----------
def test_edit_every_field_in_place(env):
    a, *_ = env
    p = plan(a, name="2% plan", yearlyPct=24, method="simple", initialCapital=100000)
    r = a.patch(f"/api/plans/{p['id']}", json={"initialCapital": 500000, "yearlyPct": 30, "method": "compounded",
                                                "startMonth": "2027-01", "name": "2.2% plan"})
    assert r.status_code == 200
    q = r.json()["plan"]
    assert (q["id"], q["initialCapital"], q["yearlyPct"], q["method"], q["startMonth"], q["name"]) == \
        (p["id"], 500000.0, 30.0, "compounded", "2027-01", "2.2% plan")
    assert len(a.get("/api/plans").json()["plans"]) == 1  # the same plan, not a new one
    for bad in ({"initialCapital": 5}, {"method": "x"}, {"startMonth": "2027-1"}, {"yearlyPct": -1}):
        assert a.patch(f"/api/plans/{p['id']}", json=bad).status_code == 400, bad


def test_links_now_and_before_and_delete(env):
    a, b, *_ = env
    one, two = strategy(a, "One"), strategy(a, "Two")
    p, other = plan(a), plan(a, name="Other")
    a.post(f"/api/strategies/{one['id']}/plan", json={"planId": p["id"]})
    a.post(f"/api/strategies/{two['id']}/plan", json={"planId": p["id"]})
    a.post(f"/api/strategies/{two['id']}/plan", json={"planId": other["id"]})  # Two moves on to Other
    got = next(x for x in a.get("/api/plans").json()["plans"] if x["id"] == p["id"])
    assert got["appliedTo"] == [{"id": one["id"], "name": "One"}]
    assert got["usedBefore"] == [{"id": two["id"], "name": "Two"}]
    assert b.delete(f"/api/plans/{p['id']}").status_code == 404  # not hers
    assert a.delete(f"/api/plans/{p['id']}").status_code == 200
    assert [x["name"] for x in a.get("/api/plans").json()["plans"]] == ["Other"]
    assert a.get(f"/api/plans/{p['id']}").status_code == 404
    t1 = a.get(f"/api/strategies/{one['id']}/plan").json()
    t2 = a.get(f"/api/strategies/{two['id']}/plan").json()
    assert t1["plan"] is None and t1["history"] == []  # its links went with it
    assert t2["plan"]["name"] == "Other" and t2["history"] == []
