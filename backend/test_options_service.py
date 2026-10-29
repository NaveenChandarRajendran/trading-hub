"""Options strategies end to end (options_service.py, options_api.py, ADR 0010): an options strategy created over the API,
a basket on live ticks with Dhan's margin, refusals, exits, the 15:30 expiry settlement (recorded spot, Dhan fallback,
pending), restart, the strategy-card numbers, capital rules, and Manual strategies untouched. Two real logins; JSON
store and, with TEST_DATABASE_URL, Postgres (it TRUNCATEs th_users / pt_accounts and by cascade the options tables)."""
import os
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

from auth import Auth, MemoryAuthStore
from dhan_client import DhanError
from main import create_app
from options_service import OptionsService
from paper_api import PaperService
from store import PaperJsonStore, PaperPgStore, PgStore
from test_api import FakeClient
from test_paper_api import Clock, FakeFeed, FakeInstruments, at, full
from tracker import Tracker

DSN = os.getenv("TEST_DATABASE_URL")
EXP = "2026-10-27"  # a Tuesday
LEGS = {  # security id: (strike, type, price) - an iron condor, 1 lot of 65
    9101: (24400.0, "PE", 19.2), 9102: (25800.0, "CE", 4.4), 9103: (24150.0, "PE", 8.85), 9104: (26050.0, "CE", 2.85)}


class Instruments(FakeInstruments):
    def get(self, sid):
        if int(sid) in LEGS:
            k, t, _ = LEGS[int(sid)]
            return {"securityId": int(sid), "symbol": "NIFTY", "expiry": EXP, "strike": k, "optionType": t, "lotSize": 65,
                    "tickSize": 0.05, "name": f"NIFTY 27 OCT {k:g} {'CALL' if t == 'CE' else 'PUT'}"}
        return super().get(sid)


class MarginClient(FakeClient):
    def __init__(self):
        super().__init__()
        self.calls, self.fail_with = [], None

    def margin_multi(self, scripts):
        self.calls.append(scripts)
        if self.fail_with:
            raise self.fail_with
        return {"total": 48000.0, "span": 16000.0, "exposure": 32000.0, "hedgeBenefit": 0.0}


@pytest.fixture(params=["json", "postgres"])
def env(request):
    tmp = tempfile.mkdtemp()
    pg = None
    if request.param == "json":
        store = PaperJsonStore(tmp)
    else:
        if not DSN:
            pytest.skip("set TEST_DATABASE_URL to run the Postgres options tests")
        pg = PgStore(DSN)
        with pg._cursor() as cur:
            cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users RESTART IDENTITY CASCADE")
            cur.execute("TRUNCATE pt_accounts RESTART IDENTITY CASCADE")
            cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen'), ('wife', 'Wife')")
        store = PaperPgStore(pg)
    clock = Clock()
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    auth = Auth(MemoryAuthStore())
    auth.create_user("naveen", "Naveen", "password-a1")
    auth.create_user("wife", "Wife", "password-b2")
    client = MarginClient()
    app = create_app(Tracker(client, data_dir=tmp, clock=clock), paper=paper, auth=auth)
    a, b = TestClient(app), TestClient(app)
    assert a.post("/api/auth/login", json={"username": "naveen", "password": "password-a1"}).status_code == 200
    assert b.post("/api/auth/login", json={"username": "wife", "password": "password-b2"}).status_code == 200
    st = a.post("/api/strategies", json={"name": "Weekly IC", "capital": 200000, "kind": "options"}).json()["strategy"]
    yield a, b, paper, clock, client, app.state.options, st, store
    if pg:
        pg.close()
    shutil.rmtree(tmp, ignore_errors=True)


def ticks(paper, clock, hm="10:00", day="2026-10-21", prices=None, spot=None):
    clock.now = at(hm, day)
    for sid, (_, _, p) in LEGS.items():
        px = (prices or {}).get(sid, p)
        paper.on_packet(full(sid, px, px, px))  # bid = ask = ltp
    if spot is not None:
        paper.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 13, "ltp": spot})


def condor(a, st):
    r = a.post(f"/api/options/basket?strategy={st['id']}", json={"legs": [
        {"securityId": 9101, "side": "S", "lots": 1}, {"securityId": 9102, "side": "S", "lots": 1},
        {"securityId": 9103, "side": "B", "lots": 1}, {"securityId": 9104, "side": "B", "lots": 1}]})
    return r


def card(a, st):
    return next(r for r in a.get("/api/strategies/summary").json()["rows"] if r["id"] == st["id"])


# ---------- trading ----------
def test_basket_fills_with_dhan_margin_and_shows_positions(env):
    a, _, paper, clock, client, _, st, _ = env
    assert st["kind"] == "options"
    ticks(paper, clock)
    r = condor(a, st)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(f["side"], f["qty"], f["price"]) for f in body["fills"]] == [
        ("SELL", 65, 19.2), ("SELL", 65, 4.4), ("BUY", 65, 8.85), ("BUY", 65, 2.85)]
    assert sorted((p["security_id"], p["qty"]) for p in body["positions"]) == [(9101, -65), (9102, -65), (9103, 65), (9104, 65)]
    assert body["funds"]["blockedMargin"] == 48000.0 and body["funds"]["premiumOpen"] == pytest.approx(773.5)
    assert sorted((s["securityId"], s["transactionType"], s["quantity"]) for s in client.calls[-1]) == [
        (9101, "SELL", 65), (9102, "SELL", 65), (9103, "BUY", 65), (9104, "BUY", 65)]  # the book after the trade
    assert card(a, st)["open"] == 4


def test_refusals(env):
    a, b, paper, clock, client, _, st, _ = env
    ticks(paper, clock)
    client.fail_with = DhanError("Dhan HTTP 502")
    r = condor(a, st)
    assert r.status_code == 409 and "Margin unavailable from Dhan" in r.json()["detail"]
    client.fail_with = None
    assert b.post(f"/api/options/basket?strategy={st['id']}", json={"legs": [{"securityId": 9101, "side": "S", "lots": 1}]}).status_code == 404
    manual = a.post("/api/strategies", json={"name": "Manual", "capital": 100000}).json()["strategy"]
    assert a.post(f"/api/options/basket?strategy={manual['id']}", json={"legs": [{"securityId": 9101, "side": "S", "lots": 1}]}).status_code == 400
    assert a.post(f"/api/options/basket?strategy={st['id']}", json={"legs": [{"securityId": 777, "side": "S", "lots": 1}]}).status_code == 404
    assert a.post(f"/api/options/basket?strategy={st['id']}", json={"legs": [{"securityId": 9101, "side": "X", "lots": 1}]}).status_code == 400
    # manual tools can't trade into an options strategy, and the options strategy stays empty
    assert a.post(f"/api/paper/orders?strategy={st['id']}", json={"securityId": 9101, "side": "BUY", "lots": 1, "orderType": "MARKET"}).status_code == 409
    assert a.get(f"/api/options/positions?strategy={st['id']}").json()["positions"] == []


def test_exit_one_leg_then_all_books_the_pnl(env):
    a, _, paper, clock, client, _, st, _ = env
    ticks(paper, clock)
    condor(a, st)
    ticks(paper, clock, "11:00", prices={9101: 12.0})
    r = a.post(f"/api/options/exit?strategy={st['id']}", json={"securityId": 9101}).json()
    assert [(f["side"], f["price"], f["realized"]) for f in r["fills"]] == [("BUY", 12.0, round(65 * 7.2, 2))]
    assert sorted(p["security_id"] for p in r["positions"]) == [9102, 9103, 9104]
    assert sorted(s["securityId"] for s in client.calls[-1]) == [9102, 9103, 9104]  # margin of what stays open
    a.post(f"/api/options/exit?strategy={st['id']}")
    pos = a.get(f"/api/options/positions?strategy={st['id']}").json()
    assert pos["positions"] == [] and pos["funds"]["blockedMargin"] == 0.0
    assert card(a, st)["booked"] == pytest.approx(65 * 7.2 - pos["funds"]["charges"], abs=0.02)


# ---------- expiry ----------
def test_expiry_settles_at_the_recorded_1530_spot_and_books_the_credit(env):
    a, _, paper, clock, _, svc, st, _ = env
    ticks(paper, clock)
    condor(a, st)
    ticks(paper, clock, "15:29", day=EXP, spot=25100.0)  # NIFTY between the short strikes
    clock.now = at("15:31", EXP)
    paper.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 13, "ltp": 25900.0})  # after 15:30: ignored
    fills = svc.settle_due()
    assert [(f.kind, f.price) for f in fills] == [("settle", 0.0)] * 4
    pos = a.get(f"/api/options/positions?strategy={st['id']}").json()
    assert pos["positions"] == [] and pos["funds"]["blockedMargin"] == 0.0
    c = card(a, st)
    assert c["booked"] == pytest.approx(773.5 - pos["funds"]["charges"], abs=0.02) and c["open"] == 0
    assert c["lastDay"] == EXP


def test_settlement_waits_for_a_spot_then_uses_dhans_close(env):
    a, _, paper, clock, _, svc, st, _ = env
    ticks(paper, clock)
    condor(a, st)
    clock.now = at("09:20", "2026-10-28")  # the backend missed expiry day
    assert svc.settle_due() == []
    pos = a.get(f"/api/options/positions?strategy={st['id']}").json()
    assert all(p["settlementPending"] for p in pos["positions"]) and len(pos["positions"]) == 4
    svc.spot_close = lambda symbol, day: 24000.0 if (symbol, day) == ("NIFTY", EXP) else None  # below the put wing
    fills = svc.settle_due()
    assert sum(f.realized for f in fills) == pytest.approx(-(250 - 11.9) * 65)  # max loss
    assert next(f for f in fills if f.security_id == 9103).charges.stt == pytest.approx(round(150 * 65 * 0.00125, 2))  # long 24150 PE: 150 ITM


# ---------- restart, capital, records ----------
def test_positions_survive_a_restart(env):
    a, _, paper, clock, client, _, st, store = env
    ticks(paper, clock)
    condor(a, st)
    st_full = store.strategy(st["id"])
    fresh = OptionsService(store, paper, margin_multi=client.margin_multi, clock=clock)
    e = fresh.book(st_full).engine
    assert sorted((p.security_id, p.qty) for p in e.open_positions()) == [(9101, -65), (9102, -65), (9103, 65), (9104, 65)]
    assert e.blocked_margin == 48000.0
    assert len(store.options_fills(st_full["account_id"])) == 4
    trades = store.trades(st_full["account_id"], "2026-10-21")
    assert len(trades) == 4  # mirrored for the reports
    assert {o["source"] for o in store.orders(st_full["account_id"], "2026-10-21")} == {"builder"}


def test_capital_and_reset_need_a_flat_book(env):
    a, _, paper, clock, _, _, st, _ = env
    ticks(paper, clock)
    condor(a, st)
    assert a.put(f"/api/strategies/{st['id']}/capital", json={"capital": 300000}).status_code == 409
    a.post(f"/api/options/exit?strategy={st['id']}")
    assert a.put(f"/api/strategies/{st['id']}/capital", json={"capital": 300000}).status_code == 200
    assert a.get(f"/api/options/positions?strategy={st['id']}").json()["funds"]["capital"] == 300000
    assert a.post("/api/strategies", json={"name": "Bad", "kind": "futures"}).status_code == 400


def test_pnl_calendar_and_growth_plan_read_an_options_strategy(env):
    """The reports read options strategies from the same tables: entry day = charges, expiry day = the credit kept."""
    a, _, paper, clock, _, svc, st, _ = env
    ticks(paper, clock)
    condor(a, st)
    entry_charges = a.get(f"/api/options/positions?strategy={st['id']}").json()["funds"]["charges"]
    ticks(paper, clock, "15:29", day=EXP, spot=25100.0)
    clock.now = at("15:31", EXP)
    svc.settle_due()
    days = {r["date"]: r for r in a.get(f"/api/paper/pnl?strategy={st['id']}&from=2026-10-01&to=2026-10-31").json()["rows"]}
    assert days["2026-10-21"]["realized"] == 0.0 and days["2026-10-21"]["charges"] == pytest.approx(entry_charges, abs=0.02)
    assert days[EXP]["realized"] == pytest.approx(773.5) and days[EXP]["charges"] == 0.0  # OTM settlement: no charges
    plan = a.post("/api/plans", json={"name": "2 %", "yearlyPct": 24, "method": "compounded", "initialCapital": 200000,
                                      "startMonth": "2026-10"}).json()["plan"]
    assert a.post(f"/api/strategies/{st['id']}/plan", json={"planId": plan["id"]}).status_code == 200
    t = a.get(f"/api/strategies/{st['id']}/plan").json()
    assert t["days"] == [{"date": "2026-10-21", "net": round(-entry_charges, 2)}, {"date": EXP, "net": 773.5}]
    assert t["strategy"]["kind"] == "options"


def test_report_and_portfolios(env):
    """Strategy Builder → Portfolios: one trade per expiry, unbooked while open, booked after the settlement; only the
    user's own options strategies."""
    a, b, paper, clock, _, svc, st, _ = env
    ticks(paper, clock)
    condor(a, st)
    charges = a.get(f"/api/options/positions?strategy={st['id']}").json()["funds"]["charges"]
    ticks(paper, clock, "11:00", prices={9101: 15.0})  # the short put fell 4.20: 273 unbooked
    r = a.get(f"/api/options/report?strategy={st['id']}").json()
    (t,) = r["trades"]
    assert (t["expiry"], t["status"], t["legs"], t["credit"]) == (EXP, "open", 4, pytest.approx(773.5))
    assert t["unbooked"] == pytest.approx(273.0) and t["booked"] == pytest.approx(-charges, abs=0.02)
    ticks(paper, clock, "15:29", day=EXP, spot=25100.0)
    clock.now = at("15:31", EXP)
    svc.settle_due()
    r = a.get(f"/api/options/report?strategy={st['id']}").json()
    (t,) = r["trades"]
    assert (t["status"], t["unbooked"]) == ("settled", 0.0) and t["net"] == pytest.approx(773.5 - charges, abs=0.02)
    assert r["months"][0]["month"] == "2026-10" and r["months"][0]["wins"] == 1
    assert r["summary"]["total"] == pytest.approx(773.5 - charges, abs=0.02)
    manual = a.post("/api/strategies", json={"name": "Scalps", "capital": 100000}).json()["strategy"]
    assert a.get(f"/api/options/report?strategy={manual['id']}").status_code == 400
    assert b.get(f"/api/options/report?strategy={st['id']}").status_code == 404
    rows = a.get("/api/options/portfolios").json()["rows"]
    assert [x["id"] for x in rows] == [st["id"]] and rows[0]["summary"]["trades"] == 1
    assert b.get("/api/options/portfolios").json()["rows"] == []
