"""Power Scalper backend (scalper_service.py, scalper_api.py, scalper_reports.py): the separate "Scalper" paper account,
one-click MARKET orders, the sell-only-closes rule, OCO protection, reports and the 15:35 summary, and proof that the
Manual and Algo accounts are untouched. Fake feed / instruments from test_paper_api.py; 21-Oct-2026 is a trading day."""
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

from main import create_app
from paper_api import PaperService
from scalper_reports import day_rows, round_trips, tiles
from scalper_service import ACCOUNT_NAME, ScalperService
from store import PaperJsonStore
from test_api import FakeClient
from test_paper_api import CE, PE, Clock, FakeFeed, FakeInstruments, at, full
from tracker import Tracker


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock, feed = Clock(), FakeFeed()
    store = PaperJsonStore(tmp)
    paper = PaperService(store, feed, FakeInstruments(), clock=clock)
    scalper = ScalperService(store, paper, paper.instruments, clock=clock)
    c = TestClient(create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=paper, scalper=scalper))
    yield c, paper, scalper, clock, feed, store
    shutil.rmtree(tmp, ignore_errors=True)


def tick(paper, clock, hm, sid=CE, ltp=100.0, bid=99.95, ask=100.0):
    clock.now = at(hm)
    paper.on_packet(full(sid, ltp, bid, ask))


def order(c, side, sid=CE, lots=1):
    r = c.post("/api/scalper/orders", json={"securityId": sid, "side": side, "lots": lots})
    assert r.status_code == 200, r.text
    return r.json()["order"]


# ---------- account and orders ----------
def test_own_account_default_capital_1_lakh_and_source_scalper(env):
    c, paper, scalper, clock, _, store = env
    acc = c.get("/api/scalper/account").json()
    assert acc["account"]["name"] == ACCOUNT_NAME and acc["account"]["capital"] == 100000
    assert acc["account"]["id"] != paper.account["id"] and acc["funds"]["available"] == 100000
    assert acc["presets"] == [50000, 100000, 200000, 500000]
    tick(paper, clock, "09:30")
    o = order(c, "BUY")
    assert (o["status"], o["avg_price"], o["qty"], o["name"]) == ("FILLED", 100.0, 65, "NIFTY 27 OCT 25100 CALL")
    stored = store.orders(scalper.account["id"], "2026-10-21")
    assert [s["source"] for s in stored] == ["scalper"]
    assert store.orders(paper.account["id"], "2026-10-21") == []  # nothing in the manual account
    assert paper.engine.positions == {} and c.get("/api/paper/positions").json()["rows"] == []


def test_sell_only_closes_an_open_long(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30")
    o = order(c, "SELL")
    assert o["status"] == "REJECTED" and "short selling is not allowed" in o["reason"]
    order(c, "BUY")
    o = order(c, "SELL", lots=2)
    assert o["status"] == "REJECTED" and "exceeds the 65 units" in o["reason"]
    tick(paper, clock, "09:31", ltp=110, bid=110, ask=110.05)
    o = order(c, "SELL")
    assert o["status"] == "FILLED" and o["avg_price"] == 110


def test_exit_and_exit_all(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30")
    tick(paper, clock, "09:30", sid=PE)
    order(c, "BUY")
    order(c, "BUY", sid=PE, lots=2)
    rows = c.post(f"/api/scalper/exit/{CE}").json()["rows"]
    assert {r["security_id"]: r["open_qty"] for r in rows} == {CE: 0, PE: 130}
    assert c.post(f"/api/scalper/exit/{CE}").status_code == 409  # nothing left to exit
    rows = c.post("/api/scalper/exit-all").json()["rows"]
    assert all(r["open_qty"] == 0 for r in rows)


def test_buy_needs_funds_and_market_hours(env):
    c, paper, scalper, clock, *_ = env
    c.put("/api/scalper/account/capital", json={"capital": 10000})
    tick(paper, clock, "09:30")
    o = order(c, "BUY", lots=2)  # 130 x 100 = 13,000 > 10,000
    assert o["status"] == "REJECTED" and "Insufficient funds" in o["reason"]
    tick(paper, clock, "15:20")
    assert order(c, "BUY")["reason"].startswith("Market closed")


def test_held_instruments_stay_subscribed(env):
    c, paper, _, clock, feed, _ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    assert ("NSE_FNO", CE) in feed.subs  # no page asked for it: the open Scalper position keeps it
    c.post(f"/api/scalper/exit/{CE}")
    assert ("NSE_FNO", CE) not in paper._extra_subs.get("scalper", set())


# ---------- OCO protection ----------
def test_protection_create_modify_cancel_and_validation(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    r = c.put(f"/api/scalper/protection/{CE}", json={"target": 120.0, "stop": 90.0})
    assert r.status_code == 200
    pos = r.json()["position"]
    assert (pos["target"], pos["stop"]) == (120.0, 90.0)
    pos = c.put(f"/api/scalper/protection/{CE}", json={"stop": 92.5}).json()["position"]  # target absent: kept
    assert (pos["target"], pos["stop"]) == (120.0, 92.5)
    pos = c.put(f"/api/scalper/protection/{CE}", json={"target": None}).json()["position"]  # null: cancelled
    assert (pos["target"], pos["stop"]) == (None, 92.5)
    bad = c.put(f"/api/scalper/protection/{CE}", json={"stop": 101.0})
    assert bad.status_code == 409 and "must be below LTP 100" in bad.json()["detail"]
    assert c.put(f"/api/scalper/protection/{CE}", json={}).status_code == 400
    tick(paper, clock, "09:40", ltp=92.0, bid=92.0, ask=92.05)  # stop hit
    rows = c.get("/api/scalper/positions").json()["rows"]
    assert rows[0]["open_qty"] == 0 and rows[0]["stop"] is None


# ---------- reports ----------
def fill(sid, side, qty, value, t, charges=20.0, i=[0]):
    i[0] += 1
    return {"id": f"T{i[0]}", "security_id": sid, "side": side, "qty": qty, "value": value, "time": t,
            "charges": {"total": charges}, "name": str(sid)}


def test_round_trips_partial_exits_and_still_open():
    fills = [fill(CE, "BUY", 130, 13000, "09:30"), fill(CE, "SELL", 65, 7150, "09:35"), fill(PE, "BUY", 65, 6500, "09:36"),
             fill(CE, "SELL", 65, 6500, "09:40"), fill(CE, "BUY", 65, 6000, "09:50")]
    closed, still_open = round_trips(fills)
    assert len(closed) == 1 and closed[0]["securityId"] == CE
    assert (closed[0]["pnl"], closed[0]["charges"], closed[0]["net"], closed[0]["exitAt"]) == (650.0, 60.0, 590.0, "09:40")
    assert sorted(o["securityId"] for o in still_open) == [CE, PE] and all(o["net"] is None for o in still_open)
    days = day_rows([{"date": "2026-10-21", "realized": 650.0, "charges": 100.0, "trades": 5}], {"2026-10-21": closed})
    t = tiles(days, closed + [{**closed[0], "net": -200.0}])
    assert (t["net"], t["trades"], t["winRate"], t["avgWin"], t["avgLoss"]) == (550.0, 2, 50.0, 590.0, -200.0)
    assert t["bestDay"] == t["worstDay"] == {"date": "2026-10-21", "net": 550.0}


def test_reports_day_view_and_1535_summary(env):
    c, paper, scalper, clock, _, store = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    tick(paper, clock, "09:35", ltp=110, bid=110, ask=110.05)
    order(c, "SELL")  # +650 gross
    order(c, "BUY")
    tick(paper, clock, "09:40", ltp=105, bid=105, ask=105.05)
    order(c, "SELL")  # 65 x (105 - 110.05) = -328.25 gross
    rep = c.get("/api/scalper/reports?from=2026-10-01&to=2026-10-21").json()
    day = rep["days"][0]
    assert (day["date"], day["trades"], day["wins"], day["losses"], day["fills"]) == ("2026-10-21", 2, 1, 1, 4)
    assert day["realized"] == 321.75 and rep["tiles"]["trades"] == 2 and rep["tiles"]["winRate"] == 50.0
    view = c.get("/api/scalper/day?date=2026-10-21").json()
    assert [t["pnl"] for t in view["trades"]] == [650.0, -328.25] and len(view["fills"]) == 4
    scalper.tick_timer(at("15:34"))
    assert store.scalper_summaries(scalper.account["id"], "2026-10-21", "2026-10-21") == []
    scalper.tick_timer(at("15:35"))
    [row] = store.scalper_summaries(scalper.account["id"], "2026-10-21", "2026-10-21")
    assert (row["trades"], row["wins"], row["losses"], row["realized"], row["net"]) == (2, 1, 1, 321.75, day["net"])


def test_reset_starts_fresh_and_keeps_history(env):
    c, paper, scalper, clock, _, store = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    assert c.post("/api/scalper/account/reset", json={}).status_code == 409  # not flat
    c.post(f"/api/scalper/exit/{CE}")
    old = scalper.account["id"]
    acc = c.post("/api/scalper/account/reset", json={"capital": 50000}).json()
    assert acc["account"]["id"] != old and acc["account"]["capital"] == 50000 and acc["account"]["name"] == ACCOUNT_NAME
    assert c.get("/api/scalper/reports?from=2026-10-21&to=2026-10-21").json()["days"] == []  # the new account
    assert len(store.trades(old, "2026-10-21")) == 2  # history kept


# ---------- Manual and Algo untouched ----------
def test_manual_and_algo_data_unchanged_by_scalper_trading(env):
    c, paper, scalper, clock, *_ = env
    tick(paper, clock, "09:30")
    c.post("/api/paper/orders", json={"securityId": CE, "side": "BUY", "lots": 1, "orderType": "MARKET"})
    tick(paper, clock, "09:35", ltp=104, bid=104, ask=104.05)
    c.post("/api/paper/orders", json={"securityId": CE, "side": "SELL", "lots": 1, "orderType": "MARKET"})
    q = "from=2026-10-01&to=2026-10-21"
    before = {u: c.get(u).json()["rows"] for u in (f"/api/paper/pnl?{q}", f"/api/paper/pnl?{q}&account=manual",
                                                   f"/api/paper/pnl?{q}&account=algo", "/api/paper/trades",
                                                   "/api/paper/trades?account=algo", "/api/paper/orders",
                                                   "/api/paper/positions")}
    manual_funds = c.get("/api/paper/account").json()["funds"]
    order(c, "BUY", lots=2)
    tick(paper, clock, "09:40", ltp=90, bid=90, ask=90.05)
    order(c, "SELL", lots=2)
    strip = lambda rows: [{k: v for k, v in r.items() if k != "ltp"} for r in rows]  # noqa: E731 (the market moved)
    for u, rows in before.items():
        assert strip(c.get(u).json()["rows"]) == strip(rows), u
    assert c.get("/api/paper/account").json()["funds"] == manual_funds
    scal = c.get(f"/api/paper/pnl?{q}&account=scalper").json()["rows"]
    man = before[f"/api/paper/pnl?{q}"]
    total = c.get(f"/api/paper/pnl?{q}&account=all").json()
    assert total["meta"]["account"] == "All" and scal[0]["realized"] == -1826.5  # 130 x (90 - 104.05)
    assert total["rows"][0]["realized"] == round(man[0]["realized"] + scal[0]["realized"], 2)
    assert total["rows"][0]["trades"] == man[0]["trades"] + scal[0]["trades"]
    fills = c.get("/api/paper/trades?account=all").json()["rows"]
    assert sorted({f["account"] for f in fills}) == ["Manual", "Scalper"]
    assert c.get("/api/paper/pnl?account=nope").status_code == 400


def test_next_day_opens_with_yesterdays_net(env):
    c, paper, scalper, clock, *_ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    tick(paper, clock, "09:35", ltp=110, bid=110, ask=110.05)
    order(c, "SELL")
    net = scalper.funds()["realized"] - scalper.funds()["charges"]
    scalper.tick_timer(at("09:20", "2026-10-22"))
    assert scalper.funds()["openingBalance"] == round(100000 + net, 2)
