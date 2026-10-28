"""Power Scalper backend (scalper_service.py, scalper_api.py, scalper_reports.py) on strategies: orders go into the
picked strategy (source "scalper") through the paper service's one engine per strategy, the sell-only-closes rule, OCO
protection, reports and the 15:35 pt_daily_summary, and proof that another strategy is untouched. Fake feed /
instruments from test_paper_api.py; 21-Oct-2026 is a trading day. The signed-in user (authfake) owns strategies
#1 "Manual" and #2 "Scalper"; the Scalper client trades into #2 unless a test says otherwise."""
import shutil
import tempfile

import pytest

from authfake import StrategyClient, create_app
from paper_api import PaperService
from scalper_reports import day_rows, round_trips, tiles
from scalper_service import ScalperService
from store import PaperJsonStore
from test_api import FakeClient
from test_paper_api import CE, PE, Clock, FakeFeed, FakeInstruments, at, full, manual_strategy
from tracker import Tracker

MANUAL, SCALP = 1, 2


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock, feed = Clock(), FakeFeed()
    store = PaperJsonStore(tmp)
    manual_strategy(store, clock, name="Manual")
    manual_strategy(store, clock, name="Scalper")
    paper = PaperService(store, feed, FakeInstruments(), clock=clock)
    calls = []

    def intraday(symbol, frm, to, sid):  # Dhan /charts/intraday for one option (fake)
        calls.append((symbol, frm, to, sid))
        t0 = int(at("09:15").timestamp())
        return {"timestamp": [t0, t0 + 60, int(at("16:00").timestamp())], "open": [100, 101, 1], "high": [102, 103, 1],
                "low": [99, 100, 1], "close": [101, 102, 1], "volume": [650, 1300, 1]}
    scalper = ScalperService(store, paper, paper.instruments, clock=clock, intraday=intraday)
    scalper.calls = calls
    app = create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=paper, scalper=scalper)
    c = StrategyClient(app, SCALP)
    c.app_ = app
    yield c, paper, scalper, clock, feed, store
    shutil.rmtree(tmp, ignore_errors=True)


def tick(paper, clock, hm, sid=CE, ltp=100.0, bid=99.95, ask=100.0):
    clock.now = at(hm)
    paper.on_packet(full(sid, ltp, bid, ask))


def order(c, side, sid=CE, lots=1):
    r = c.post("/api/scalper/orders", json={"securityId": sid, "side": side, "lots": lots})
    assert r.status_code == 200, r.text
    return r.json()["order"]


def acc_of(paper, sid):
    return paper.books[sid].account["id"]


# ---------- account and orders ----------
def test_orders_go_into_the_picked_strategy_with_source_scalper(env):
    c, paper, scalper, clock, _, store = env
    acc = c.get("/api/scalper/account").json()
    assert acc["strategy"]["name"] == "Scalper" and acc["account"]["capital"] == 100000
    assert acc["funds"]["available"] == 100000 and acc["presets"] == [50000, 100000, 200000, 500000]
    tick(paper, clock, "09:30")
    o = order(c, "BUY")
    assert (o["status"], o["avg_price"], o["qty"], o["name"]) == ("FILLED", 100.0, 65, "NIFTY 27 OCT 25100 CALL")
    stored = store.orders(acc_of(paper, SCALP), "2026-10-21")
    assert [s["source"] for s in stored] == ["scalper"]
    assert store.orders(acc_of(paper, MANUAL), "2026-10-21") == []  # nothing in the other strategy
    assert c.get(f"/api/paper/positions?strategy={MANUAL}").json()["rows"] == []


def test_one_engine_per_strategy_whichever_screen_trades(env):
    """Paper Trading and Power Scalper on the same strategy share its funds and positions."""
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")  # Scalper screen, strategy #2
    rows = c.get(f"/api/paper/positions?strategy={SCALP}").json()["rows"]  # Paper Trading screen, same strategy
    assert rows[0]["open_qty"] == 65 and rows[0]["security_id"] == CE
    r = c.post(f"/api/paper/orders?strategy={SCALP}", json={"securityId": CE, "side": "SELL", "lots": 1,
                                                            "orderType": "MARKET"}).json()
    assert r["status"] == "FILLED"
    assert c.get("/api/scalper/positions").json()["rows"][0]["open_qty"] == 0
    sources = [o["source"] for o in c.get("/api/scalper/orders").json()["rows"]]
    assert sources == ["scalper", "manual"]
    f2 = c.get("/api/scalper/account").json()["funds"]
    f1 = c.get(f"/api/scalper/account?strategy={MANUAL}").json()["funds"]
    assert f2["charges"] > 0 and f1["charges"] == 0 and f1["available"] == 100000  # separate funds


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
    assert c.put("/api/scalper/account/capital", json={"capital": 10000}).status_code == 200
    tick(paper, clock, "09:30")
    o = order(c, "BUY", lots=2)  # 130 x 100 = 13,000 > 10,000
    assert o["status"] == "REJECTED" and "Insufficient funds" in o["reason"]
    tick(paper, clock, "15:20")
    assert order(c, "BUY")["reason"].startswith("Market closed")


def test_held_instruments_stay_subscribed(env):
    c, paper, _, clock, feed, _ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    assert ("NSE_FNO", CE) in feed.subs  # no page asked for it: the open position keeps it
    c.post(f"/api/scalper/exit/{CE}")
    assert ("NSE_FNO", CE) not in paper._extra_subs.get("scalper", set())


def test_orders_need_an_active_manual_strategy_of_your_own(env):
    c, paper, _, clock, _, store = env
    store.create_strategy(1, "OI Breakout Algo", "", 100000, "algo", clock(), account_name="Algo")
    store.create_strategy(2, "Wife's", "", 100000, "manual", clock())
    tick(paper, clock, "09:30")
    body = {"securityId": CE, "side": "BUY", "lots": 1}
    assert c.post("/api/scalper/orders?strategy=3", json=body).status_code == 409  # algo strategy
    assert c.post("/api/scalper/orders?strategy=4", json=body).status_code == 404  # someone else's
    assert c.post("/api/scalper/orders?strategy=99", json=body).status_code == 404
    assert c.post("/api/scalper/orders?strategy=", json=body).status_code == 400
    c.post(f"/api/strategies/{MANUAL}/archive")
    assert c.post(f"/api/scalper/orders?strategy={MANUAL}", json=body).status_code == 409  # archived


# ---------- OCO protection ----------
def test_protection_create_modify_cancel_and_validation(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    sent = []
    paper.event_listeners.append(lambda book, kind, data: sent.append((kind, data)))
    r = c.put(f"/api/scalper/protection/{CE}", json={"target": 120.0, "stop": 90.0})
    assert r.status_code == 200
    pos = r.json()["position"]
    assert (pos["target"], pos["stop"]) == (120.0, 90.0)
    pushed = [d for k, d in sent if k == "position"]  # the open pages see the new target / stop too
    assert len(pushed) == 1 and (pushed[0]["target"], pushed[0]["stop"]) == (120.0, 90.0)
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
    paper.tick_timer(at("15:34"))
    assert store.daily_summaries([SCALP], "2026-10-21", "2026-10-21") == []
    paper.tick_timer(at("15:35"))
    [row] = store.daily_summaries([SCALP, MANUAL], "2026-10-21", "2026-10-21")  # only strategies with fills
    assert (row["strategy_id"], row["trades"], row["wins"], row["losses"], row["realized"], row["net"]) == \
        (SCALP, 2, 1, 1, 321.75, day["net"])


def test_reset_starts_fresh_and_keeps_history(env):
    c, paper, scalper, clock, _, store = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    assert c.post("/api/scalper/account/reset", json={}).status_code == 409  # not flat
    c.post(f"/api/scalper/exit/{CE}")
    old = acc_of(paper, SCALP)
    acc = c.post("/api/scalper/account/reset", json={"capital": 50000}).json()
    assert acc["account"]["id"] != old and acc["account"]["capital"] == 50000 and acc["strategy"]["name"] == "Scalper"
    assert acc["funds"]["available"] == 50000
    assert c.get("/api/scalper/reports?from=2026-10-21&to=2026-10-21").json()["days"] == []  # the new period
    assert len(store.trades(old, "2026-10-21")) == 2  # history kept
    pnl = c.get(f"/api/paper/pnl?strategy={SCALP}&from=2026-10-21&to=2026-10-21").json()["rows"]
    assert pnl[0]["trades"] == 2  # the strategy's P&L calendar still shows the old period's day


# ---------- another strategy untouched ----------
def test_other_strategy_unchanged_by_scalper_trading(env):
    c, paper, scalper, clock, *_ = env
    tick(paper, clock, "09:30")
    m = f"strategy={MANUAL}"
    c.post(f"/api/paper/orders?{m}", json={"securityId": CE, "side": "BUY", "lots": 1, "orderType": "MARKET"})
    tick(paper, clock, "09:35", ltp=104, bid=104, ask=104.05)
    c.post(f"/api/paper/orders?{m}", json={"securityId": CE, "side": "SELL", "lots": 1, "orderType": "MARKET"})
    q = "from=2026-10-01&to=2026-10-21"
    before = {u: c.get(u).json()["rows"] for u in (f"/api/paper/pnl?{q}&{m}", f"/api/paper/trades?{m}",
                                                   f"/api/paper/orders?{m}", f"/api/paper/positions?{m}")}
    manual_funds = c.get(f"/api/paper/account?{m}").json()["funds"]
    order(c, "BUY", lots=2)
    tick(paper, clock, "09:40", ltp=90, bid=90, ask=90.05)
    order(c, "SELL", lots=2)
    strip = lambda rows: [{k: v for k, v in r.items() if k != "ltp"} for r in rows]  # noqa: E731 (the market moved)
    for u, rows in before.items():
        assert strip(c.get(u).json()["rows"]) == strip(rows), u
    assert c.get(f"/api/paper/account?{m}").json()["funds"] == manual_funds
    scal = c.get(f"/api/paper/pnl?{q}").json()["rows"]
    man = before[f"/api/paper/pnl?{q}&{m}"]
    total = c.get(f"/api/paper/pnl?{q}&strategy=all").json()
    assert scal[0]["realized"] == -1826.5  # 130 x (90 - 104.05)
    assert total["rows"][0]["realized"] == round(man[0]["realized"] + scal[0]["realized"], 2)
    assert total["rows"][0]["trades"] == man[0]["trades"] + scal[0]["trades"]
    fills = c.get("/api/paper/trades?strategy=all").json()["rows"]
    assert sorted({f["strategy"] for f in fills}) == ["Manual", "Scalper"]
    assert c.get("/api/paper/pnl?strategy=nope").status_code == 404


def test_next_day_opens_with_yesterdays_net(env):
    c, paper, scalper, clock, *_ = env
    tick(paper, clock, "09:30")
    order(c, "BUY")
    tick(paper, clock, "09:35", ltp=110, bid=110, ask=110.05)
    order(c, "SELL")
    f = paper.funds(paper.books[SCALP])
    net = f["realized"] - f["charges"]
    paper.tick_timer(at("09:20", "2026-10-22"))
    assert paper.funds(paper.books[SCALP])["openingBalance"] == round(100000 + net, 2)


# ---------- live data for the page ----------
def test_option_history_from_dhan_cached_and_unknown_404(env):
    c, paper, scalper, clock, *_ = env
    clock.now = at("10:00")
    r = c.get(f"/api/scalper/candles?securityId={CE}").json()
    assert r["meta"]["name"] == "NIFTY 27 OCT 25100 CALL" and len(r["candles"]) == 2  # 16:00 is outside the session
    assert r["candles"][1] == {"time": int(at("09:16").timestamp()), "open": 101.0, "high": 103.0, "low": 100.0,
                               "close": 102.0, "volume": 1300.0}
    # previous session (20-Oct is a holiday) .. the day after today: Dhan's toDate is exclusive by date
    assert scalper.calls == [("NIFTY", "2026-10-19 09:15:00", "2026-10-22 09:15:00", CE)]
    c.get(f"/api/scalper/candles?securityId={CE}")
    assert len(scalper.calls) == 1  # cached
    assert c.get("/api/scalper/candles?securityId=1").status_code == 404


def test_websocket_snapshot_ticks_candles_volume_and_events(env):
    c, paper, scalper, clock, feed, _ = env
    with c.websocket_connect(f"/ws/scalper?strategy={SCALP}") as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["strategyId"] == SCALP and snap["positions"] == []
        ws.send_json({"type": "subscribe", "instruments": [["NSE_FNO", CE], ["IDX_I", 13]]})
        for _ in range(200):
            if ("NSE_FNO", CE) in feed.subs:
                break
            import time as _t
            _t.sleep(0.005)
        assert ("NSE_FNO", CE) in feed.subs and ("IDX_I", 13) in feed.subs  # shared feed, Full mode for the option
        clock.now = at("09:30")
        pkt = full(CE, 100, 99.95, 100)
        pkt.update(high=104.5, low=96.0, open=98.0, volume=5000)
        paper.on_packet(pkt)
        tick = ws.receive_json()
        assert tick["type"] == "tick" and (tick["data"]["ask"], tick["data"]["high"], tick["data"]["low"]) == (100, 104.5, 96.0)
        candle = ws.receive_json()
        assert candle["type"] == "candle" and candle["data"]["time"] == int(at("09:30").timestamp())
        assert ws.receive_json()["type"] == "volume"
        pkt["volume"] = 5650
        paper.on_packet(pkt)
        vols = [m for m in (ws.receive_json() for _ in range(3)) if m["type"] == "volume"]
        assert vols[0]["data"]["volume"] == 650  # this minute's traded volume, not the day's
        c.post("/api/scalper/orders", json={"securityId": CE, "side": "BUY", "lots": 1})
        msgs = [ws.receive_json() for _ in range(5)]
        assert [m["type"] for m in msgs] == ["order", "order", "trade", "position", "funds"]
        assert {m["strategyId"] for m in msgs} == {SCALP}
        ws.send_json({"type": "strategy", "id": MANUAL})  # the selector switched: a new snapshot
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["strategyId"] == MANUAL and snap["positions"] == []
        ws.send_json({"type": "unsubscribe", "instruments": [["NSE_FNO", CE], ["IDX_I", 13]]})
    assert ("NSE_FNO", CE) in feed.subs  # still held: the open position
