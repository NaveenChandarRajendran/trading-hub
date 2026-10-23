"""Paper trading API end to end: routes -> PaperService -> engine -> store, with a fake feed and fake instrument
list (never the real Dhan API). Ticks are injected with svc.on_packet; the clock is set by each test.
Wednesday 21-Oct-2026 is a trading day."""
import shutil
import tempfile
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from dhan_feed import FULL, TICKER
from main import create_app
from paper_api import PaperService
from store import IST, PaperJsonStore
from test_api import FakeClient
from tracker import Tracker

CE, PE = 52175, 52176
INSTRUMENTS = {
    CE: {"securityId": CE, "symbol": "NIFTY", "expiry": "2026-10-27", "strike": 25100.0, "optionType": "CE",
         "lotSize": 65, "tickSize": 0.05, "name": "NIFTY 27 OCT 25100 CALL"},
    PE: {"securityId": PE, "symbol": "NIFTY", "expiry": "2026-10-27", "strike": 25100.0, "optionType": "PE",
         "lotSize": 65, "tickSize": 0.05, "name": "NIFTY 27 OCT 25100 PUT"},
}


class FakeFeed:
    def __init__(self):
        self.status = {"connected": True, "tokenExpired": False, "lastError": "", "lastPacketAt": None}
        self.subs, self.on_packet, self.token = {}, None, None

    def subscribe(self, keys, mode=FULL):
        for k in keys:
            self.subs[tuple(k)] = mode

    def unsubscribe(self, keys):
        for k in keys:
            self.subs.pop(tuple(k), None)

    def set_token(self, token):
        self.token = token

    def start(self):
        pass

    def stop(self):
        pass


FUT = 52162  # NIFTY near-month future (Dashboard volume)


class FakeInstruments:
    def get(self, sid):
        return INSTRUMENTS.get(int(sid))

    def future_ids(self):
        return {FUT}

    def near_future(self, symbol, today=None):
        return {"securityId": FUT, "symbol": "NIFTY", "expiry": "2026-10-27", "lotSize": 65, "name": "NIFTY OCT FUT"}

    def expiries(self, symbol, today=None):
        return ["2026-10-27", "2026-11-03"] if symbol == "NIFTY" else ["2026-10-27"]

    def chain(self, symbol, expiry):
        if symbol != "NIFTY" or expiry != "2026-10-27":
            return []
        return [{"strike": 25100.0, "ce": INSTRUMENTS[CE], "pe": INSTRUMENTS[PE]}]


class Clock:
    def __init__(self):
        self.now = at("09:20")

    def __call__(self):
        return self.now


def at(hm, day="2026-10-21"):
    return datetime.fromisoformat(f"{day}T{hm}:00").replace(tzinfo=IST)


def full(sid, ltp, bid, ask, qty=1000):
    depth = [{"bid_qty": qty, "ask_qty": qty, "bid_orders": 1, "ask_orders": 1, "bid_price": bid, "ask_price": ask}]
    depth += [{"bid_qty": 0, "ask_qty": 0, "bid_orders": 0, "ask_orders": 0, "bid_price": 0, "ask_price": 0}] * 4
    return {"kind": "full", "segment": "NSE_FNO", "security_id": sid, "ltp": ltp, "oi": 1, "volume": 1, "close": 0,
            "depth": depth}


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock, feed = Clock(), FakeFeed()
    svc = PaperService(PaperJsonStore(tmp), feed, FakeInstruments(), clock=clock)
    tracker = Tracker(FakeClient(), data_dir=tmp, clock=clock)
    c = TestClient(create_app(tracker, paper=svc))
    yield c, svc, clock, feed, tmp
    shutil.rmtree(tmp, ignore_errors=True)


def wait_until(cond, seconds=2.0):
    end = time.monotonic() + seconds
    while not cond():
        assert time.monotonic() < end, "timed out"
        time.sleep(0.005)


def buy(c, sid=CE, lots=1, order_type="MARKET", **kw):
    return c.post("/api/paper/orders", json={"securityId": sid, "side": "BUY", "lots": lots, "orderType": order_type, **kw})


def sell(c, sid=CE, lots=1, order_type="MARKET", **kw):
    return c.post("/api/paper/orders", json={"securityId": sid, "side": "SELL", "lots": lots, "orderType": order_type, **kw})


# ---------- account ----------
def test_account_defaults_and_capital(env):
    c, *_ = env
    r = c.get("/api/paper/account").json()
    assert r["account"]["capital"] == 100000 and r["funds"]["available"] == 100000
    assert r["presets"] == [100000, 200000, 500000]
    assert r["chargeRates"]["brokeragePerOrder"] == 20 and r["chargeRates"]["sttSell"] == 0.0015
    assert set(r["meta"]) >= {"asOf", "marketOpen", "tokenExpired", "lastError", "message"}
    assert c.post("/api/paper/account", json={"capital": 200000}).json()["funds"]["available"] == 200000
    assert c.post("/api/paper/account", json={"capital": 500}).status_code == 400


def test_reset_needs_flat_book_and_archives(env):
    c, svc, clock, feed, tmp = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    assert c.post("/api/paper/account/reset", json={}).status_code == 409
    c.post("/api/paper/positions/exit-all")
    r = c.post("/api/paper/account/reset", json={"capital": 500000}).json()
    assert r["account"]["id"] == 2 and r["funds"]["available"] == 500000
    accounts = PaperJsonStore(tmp).accounts()
    assert accounts[0]["archived_at"] and accounts[0]["capital"] == 100000  # old account kept for history
    assert c.get("/api/paper/positions").json()["rows"] == []


# ---------- orders ----------
def test_unknown_instrument_404_and_no_price_yet(env):
    c, svc, clock, feed, _ = env
    assert buy(c, sid=999).status_code == 404
    r = buy(c).json()
    assert r["status"] == "REJECTED" and "No live price" in r["reason"]
    assert feed.subs[("NSE_FNO", CE)] == FULL  # subscribed so the next try has a price


def test_market_buy_uses_lot_size_from_instrument_list(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    r = buy(c, lots=2).json()
    assert (r["status"], r["qty"]) == ("FILLED", 130)  # 2 lots x 65
    assert r["order"]["name"] == "NIFTY 27 OCT 25100 CALL"
    p = c.get("/api/paper/positions").json()
    assert p["rows"][0]["open_qty"] == 130 and p["rows"][0]["name"] == "NIFTY 27 OCT 25100 CALL"
    assert p["funds"]["used"] == 13000 and p["funds"]["available"] < 100000 - 13000  # minus buy charges


def test_business_rejection_is_an_order_not_an_error(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    r = sell(c)
    assert r.status_code == 200 and r.json()["status"] == "REJECTED" and "short selling" in r.json()["reason"]


def test_bad_input_is_400(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    assert buy(c, order_type="LIMIT").status_code == 400  # no price
    assert buy(c, order_type="LIMIT", price=100.03).status_code == 400
    assert buy(c, attach={"sl": 90, "target": 120}).status_code == 400  # step 5


def test_stop_loss_fills_on_tick_without_any_browser(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    sl = sell(c, order_type="SL-M", triggerPrice=90).json()
    assert sl["status"] == "PENDING"
    svc.on_packet(full(CE, 90, 89.9, 90.05))  # LTP at the trigger
    orders = {o["id"]: o for o in c.get("/api/paper/orders").json()["rows"]}
    assert orders[sl["id"]]["status"] == "FILLED" and orders[sl["id"]]["avg_price"] == 89.9
    t = c.get("/api/paper/trades").json()["rows"]
    assert [x["side"] for x in t] == ["BUY", "SELL"] and t[1]["charges"]["stt"] > 0


def test_modify_and_cancel(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    o = buy(c, order_type="LIMIT", price=95).json()
    r = c.put(f"/api/paper/orders/{o['id']}", json={"lots": 2})
    assert r.status_code == 200 and r.json()["qty"] == 130
    assert c.delete(f"/api/paper/orders/{o['id']}").json()["status"] == "CANCELLED"
    assert c.delete(f"/api/paper/orders/{o['id']}").status_code == 409
    assert c.put("/api/paper/orders/PT-NOPE", json={"price": 1}).status_code == 404


def test_exit_position(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    r = c.post(f"/api/paper/positions/{CE}/exit").json()
    assert r["rows"][0]["open_qty"] == 0
    assert c.post(f"/api/paper/positions/{CE}/exit").status_code == 409


def test_orders_rejected_when_market_closed(env):
    c, svc, clock, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    clock.now = at("15:16")
    r = buy(c).json()
    assert r["status"] == "REJECTED" and "Market closed" in r["reason"]
    meta = c.get("/api/paper/positions").json()["meta"]
    assert meta["acceptingOrders"] is False and meta["marketOpen"] is True  # session open till 15:30


# ---------- square-off, restart, day roll-over ----------
def test_auto_square_off_from_the_timer(env):
    c, svc, clock, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    svc.on_packet(full(CE, 110, 110, 110.05))
    clock.now = at("15:15")
    svc.tick_timer()
    p = c.get("/api/paper/positions").json()["rows"][0]
    assert p["open_qty"] == 0 and p["realized"] == 650.0  # 65 x (110 - 100)


def test_restart_restores_the_day(env):
    c, svc, clock, feed, tmp = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    sl = sell(c, order_type="SL-M", triggerPrice=90).json()

    feed2 = FakeFeed()
    svc2 = PaperService(PaperJsonStore(tmp), feed2, FakeInstruments(), clock=clock)
    assert svc2.funds() == svc.funds()
    assert svc2.engine.orders[sl["id"]].status == "PENDING"
    assert feed2.subs[("NSE_FNO", CE)] == FULL  # pending order + open position re-subscribed
    svc2.on_packet(full(CE, 89, 88.9, 89.05))
    assert svc2.engine.orders[sl["id"]].status == "FILLED"


def test_pnl_report_and_next_day_balance(env):
    c, svc, clock, feed, tmp = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    svc.on_packet(full(CE, 120, 120, 120.05))
    sell(c)
    rows = c.get("/api/paper/pnl?from=2026-10-01&to=2026-10-31").json()["rows"]
    assert len(rows) == 1
    r = rows[0]
    assert (r["date"], r["realized"], r["trades"]) == ("2026-10-21", 1300.0, 2)  # 65 x (120 - 100)
    assert r["net"] == round(1300 - r["charges"], 2) and r["charges"] > 40

    clock.now = at("09:20", day="2026-10-22")
    svc.tick_timer()
    f = c.get("/api/paper/account").json()["funds"]
    assert f["openingBalance"] == round(100000 + r["net"], 2) and f["realized"] == 0
    assert c.get("/api/paper/trades?date=2026-10-21").json()["rows"][0]["side"] == "BUY"  # earlier day from store
    assert c.get("/api/paper/trades").json()["rows"] == []


def test_pnl_bad_dates(env):
    c, *_ = env
    assert c.get("/api/paper/pnl?from=21-10-2026").status_code == 400
    assert c.get("/api/paper/pnl?from=2026-10-22&to=2026-10-21").status_code == 400


def test_store_failure_is_retried(env):
    c, svc, *_ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    real = svc.store.save_order
    svc.store.save_order = lambda *a: (_ for _ in ()).throw(OSError("disk full"))
    buy(c)
    assert "Database write failed" in c.get("/api/paper/positions").json()["meta"]["lastError"]
    svc.store.save_order = real
    buy(c, order_type="LIMIT", price=90)
    assert c.get("/api/paper/positions").json()["meta"]["lastError"] == ""
    assert len(svc.store.orders(1, "2026-10-21")) == 2


# ---------- websocket ----------
def test_websocket_snapshot_ticks_and_events(env):
    c, svc, clock, feed, _ = env
    with c.websocket_connect("/ws/paper") as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["funds"]["available"] == 100000
        ws.send_json({"type": "subscribe", "instruments": [["NSE_FNO", CE], ["IDX_I", 13]]})
        wait_until(lambda: ("IDX_I", 13) in feed.subs)
        assert feed.subs[("IDX_I", 13)] == TICKER and feed.subs[("NSE_FNO", CE)] == FULL

        svc.on_packet(full(CE, 100, 99.95, 100))
        tick = ws.receive_json()
        assert tick["type"] == "tick" and tick["data"]["ask"] == 100 and tick["data"]["securityId"] == CE

        buy(c)
        kinds = [ws.receive_json()["type"] for _ in range(5)]
        assert kinds == ["order", "order", "trade", "position", "funds"]

        ws.send_json({"type": "unsubscribe", "instruments": [["NSE_FNO", CE], ["IDX_I", 13]]})
        wait_until(lambda: ("IDX_I", 13) not in feed.subs)
        assert ("NSE_FNO", CE) in feed.subs  # still needed: open position


def test_token_endpoint_updates_feed(env):
    _c, svc, clock, feed, tmp = env

    class TokenClient(FakeClient):
        def set_token(self, token):
            self.token = token

    c = TestClient(create_app(Tracker(TokenClient(), data_dir=tmp, clock=clock), paper=svc))
    assert c.post("/api/token", json={"accessToken": "t" * 40}).json() == {"ok": True}
    assert feed.token == "t" * 40


def test_chain_from_instrument_list(env):
    c, *_ = env
    r = c.get("/api/paper/chain?symbol=nifty").json()
    assert (r["expiry"], r["expiries"], r["lotSize"]) == ("2026-10-27", ["2026-10-27", "2026-11-03"], 65)
    assert r["spot"] == {"segment": "IDX_I", "securityId": 13}
    assert r["rows"] == [{"strike": 25100.0, "ce": {"securityId": CE, "name": "NIFTY 27 OCT 25100 CALL"},
                          "pe": {"securityId": PE, "name": "NIFTY 27 OCT 25100 PUT"}}]
    assert c.get("/api/paper/chain?symbol=NIFTY&expiry=2026-11-03").status_code == 404
    assert c.get("/api/paper/chain?symbol=FINNIFTY").status_code == 400


def test_pnl_meta_lists_holidays(env):
    c, *_ = env
    meta = c.get("/api/paper/pnl?from=2026-10-01&to=2026-10-31").json()["meta"]
    assert meta["holidays"] == ["2026-10-02", "2026-10-20"]
