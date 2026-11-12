"""toi_algo_service.py, step 4: the Trending OI Algo on the paper feed with fake market data. Entry / add / partial /
stop as paper orders in its own "Trending OI Algo" account (the OI breakout algo's account untouched), the decision
log and state in its store, restart without duplicates, catch-up after a late start, the kill switch, the stale feed,
settings changes logged old -> new, the strike fallback, signals mode, the 15:35 summary, and no real order path."""
import ast
import os
import shutil
import tempfile
from datetime import datetime, timedelta

import pytest

import trending_oi_algo_config as cfg
from paper_api import PaperService
from store import IST, PaperJsonStore
from test_paper_api import FakeFeed, full
from toi_algo_service import ToiAlgoService, ToiData
from toi_algo_store import MemoryToiStore

HERE = os.path.dirname(os.path.abspath(__file__))
DAY = "2026-11-12"
EXP = "2026-11-17"
FUT = 52162
LEVELS = {"R1": 23300.0, "R2": 23400.0, "R3": 23500.0, "S1": 23100.0, "S2": 23000.0, "S3": 22900.0}


def at(hm, s=0, day=DAY):
    h, m = map(int, hm.split(":"))
    return datetime.fromisoformat(f"{day}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=IST)


def sid(strike, side):
    return (100000 if side == "CE" else 200000) + int(strike)


class Instruments:
    def get(self, s):
        strike, typ = (s - 100000, "CE") if s < 200000 else (s - 200000, "PE")
        return {"securityId": s, "symbol": "NIFTY", "expiry": EXP, "strike": float(strike), "optionType": typ,
                "lotSize": 65, "tickSize": 0.05, "name": f"NIFTY 17 NOV {strike} {'CALL' if typ == 'CE' else 'PUT'}"}

    def future_ids(self):
        return {FUT}

    def expiries(self, symbol, today=None):
        return [EXP]

    def chain(self, symbol, expiry):
        return [{"strike": float(k), "ce": self.get(sid(k, "CE")), "pe": self.get(sid(k, "PE"))} for k in range(23000, 23501, 50)]


class Clock:
    now = at("09:15")

    def __call__(self):
        return self.now


class Market:
    """The fake chain (liquidity, delta) and Trending OI rows the data callbacks read."""

    def __init__(self):
        self.dead = set()  # (strike, side) with no trades today
        self.rows = [{"ts": f"{DAY} 09:30", "sentiment": "Bullish", "strengthPct": 64.0}]
        self.asked = []  # Trending OI intervals the algo asked for

    def chain(self, expiry):
        def leg(k, side):
            dead = (k, side) in self.dead
            return {"oi": 50000, "volume": 0 if dead else 120000, "top_bid_price": 0 if dead else 110.0,
                    "top_ask_price": 0 if dead else 110.5, "last_price": 110.2, "greeks": {"delta": 0.5}}
        return {"spot": 23235.0, "lotSize": 65, "oc": {float(k): {"ce": leg(k, "CE"), "pe": leg(k, "PE")} for k in range(23000, 23501, 50)}}


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock = Clock()
    store = PaperJsonStore(tmp)
    store.create_strategy(1, "OI Breakout Algo", "", 100000, "algo", clock(), account_name="Algo")
    store.create_strategy(1, cfg.STRATEGY_NAME, "", cfg.CAPITAL, "algo", clock(), account_name=cfg.ACCOUNT_NAME)
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    market, toi = Market(), MemoryToiStore()
    svc = make(store, toi, paper, market, clock)
    yield svc, paper, clock, store, toi, market
    shutil.rmtree(tmp, ignore_errors=True)


def make(store, toi, paper, market, clock, mode="paper"):
    data = ToiData(expiries=lambda: [EXP, "2026-11-24"], chain=market.chain,
                   trending_rows=lambda interval: market.asked.append(interval) or list(reversed(market.rows)),
                   intraday=lambda: [], future_intraday=lambda s: [], futures=lambda: [{"securityId": FUT, "symbol": "NIFTY", "expiry": "2026-11-24"}],
                   levels=lambda day: dict(LEVELS), token_expired=lambda: False)
    if "candleMin" not in toi.settings():
        toi.save_settings({**toi.settings(), "candleMin": 5}, clock())  # these scenarios are written in 5-minute candles
    svc = ToiAlgoService(store, toi, paper, Instruments(), data, clock, mode=mode)
    real = ToiAlgoService.indicators

    def ind(end):  # real candles; Supertrend / VWAP / RSI fixed per test (indicators.py has its own tests)
        out = real(svc, end)
        if out:
            out.update(st={"value": svc.fake_st, "up": True}, vwap=svc.fake_vwap, rsi=60.0, vwapFuture=svc.fake_vwap + 120, basis=120.0)
        return out
    svc.indicators = ind
    svc.fake_st, svc.fake_vwap = 23200.0, 23210.0
    return svc


def index(paper, clock, t, spot):
    clock.now = t
    paper.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 13, "ltp": spot})


def books(paper, clock, prices):
    for s, p in prices.items():
        paper.on_packet(full(s, p, round(p - 0.05, 2), round(p + 0.05, 2)))


def candle(svc, paper, clock, end, o, h, l, c, opts=None):
    """Index ticks for the 5-minute candle ending at `end`, option books, then the timer 11 s after it closes."""
    e = at(end)
    for i, px in enumerate((o, h, l, c)):
        index(paper, clock, e - timedelta(minutes=4, seconds=50) + timedelta(minutes=i), px)
    if opts:
        books(paper, clock, opts)
    index(paper, clock, e - timedelta(seconds=5), c)  # the closing tick (the feed stays fresh)
    clock.now = e + timedelta(seconds=11)
    svc.tick(clock.now)


OPTS = {sid(k, side): p for k, side, p in ((23200, "CE", 110.0), (23250, "CE", 85.0), (23150, "CE", 140.0),
                                             (23250, "PE", 90.0), (23300, "PE", 120.0), (23350, "PE", 150.0))}


def morning(svc, paper, clock):
    """09:15 start, levels at 09:30, quiet candles to 09:45 (day low 23,180)."""
    clock.now = at("09:15", 5)
    svc.tick(clock.now)
    candle(svc, paper, clock, "09:20", 23220, 23230, 23180, 23225, OPTS)
    candle(svc, paper, clock, "09:25", 23225, 23235, 23215, 23230, OPTS)
    candle(svc, paper, clock, "09:30", 23230, 23240, 23220, 23238, OPTS)
    clock.now = at("09:30", 20)
    svc.tick(clock.now)
    for end in ("09:35", "09:40", "09:45"):
        candle(svc, paper, clock, end, 23238, 23260, 23236, 23255, OPTS)


def entry(svc, paper, clock):
    morning(svc, paper, clock)
    candle(svc, paper, clock, "09:50", 23240, 23242, 23205, 23235, OPTS)  # pullback to Supertrend / VWAP, holds


def events(toi, typ=None):
    return [e for e in toi.events(DAY) if typ is None or e["type"] == typ]


def acc(store, name):
    return store.active_account(name)["id"]


# ---------------------------------------------------------------- entry as a paper order in its own account
def test_entry_is_a_paper_order_in_the_trending_oi_algo_account(env):
    svc, paper, clock, store, toi, _ = env
    entry(svc, paper, clock)
    assert svc.state["levels"] == LEVELS and events(toi, "levels")[0]["message"].startswith("Levels locked: R1 23,300")
    o = svc.state["open"]
    assert (o["side"], o["lots"], o["strike"], o["stop"]) == ("CE", 2, 23200.0, {"dir": "below", "price": 23180})
    orders = store.orders(acc(store, cfg.ACCOUNT_NAME), DAY)
    assert [(x["side"], x["lots"], x["status"], x["source"], x["setup"]) for x in orders] == [
        ("BUY", 2, "FILLED", "algo", "Trending OI entry CE")]
    assert store.orders(acc(store, "Algo"), DAY) == []  # the OI breakout algo's account is untouched
    assert [e["type"] for e in events(toi)][-2:] == ["entry", "info"]  # the decision, then the fill
    assert toi.state(DAY)["open"]["lots"] == 2  # stored after the change
    assert ("IDX_I", 13) in paper._feed_subs and ("NSE_FNO", FUT) in paper._feed_subs and ("NSE_FNO", sid(23200, "CE")) in paper._feed_subs
    assert toi.candles(DAY)[-1]["supertrend"] == 23200.0


def test_illiquid_1_itm_falls_back_to_atm_and_logs_it(env):
    svc, paper, clock, store, toi, market = env
    market.dead.add((23200, "CE"))
    entry(svc, paper, clock)
    assert svc.state["open"]["strike"] == 23250.0
    assert any("1 ITM not liquid (23,200 CE no trades today): using ATM 23,250 CE" in e["message"] for e in events(toi, "info"))


# ---------------------------------------------------------------- add, partial, stop
def test_add_partial_and_stop_are_paper_orders(env):
    svc, paper, clock, store, toi, _ = env
    entry(svc, paper, clock)
    books(paper, clock, {sid(23200, "CE"): 105.0})
    candle(svc, paper, clock, "09:55", 23235, 23236, 23206, 23226, {sid(23200, "CE"): 105.0})  # against me, holds: averaging
    assert svc.state["open"]["lots"] == 4 and svc.state["open"]["adds"]["avg"] == 1
    index(paper, clock, at("10:01"), 23300.0)  # R1: sell half
    books(paper, clock, {sid(23200, "CE"): 150.0})
    index(paper, clock, at("10:01", 2), 23300.5)
    assert svc.state["open"]["lots"] == 2 and svc.state["open"]["breakeven"]
    index(paper, clock, at("10:20"), 23179.0)  # below the day low: the stop exits the rest
    assert svc.state["open"] is None and svc.state["stopped"] == ["CE"]
    sells = [(x["side"], x["lots"], x["setup"]) for x in store.orders(acc(store, cfg.ACCOUNT_NAME), DAY) if x["side"] == "SELL"]
    assert sells == [("SELL", 2, "Trending OI partial R1"), ("SELL", 2, "Trending OI stop loss")]
    assert svc.broker.open_qty(sid(23200, "CE")) == 0
    closed = svc.state["closed"][0]
    assert closed["partials"] == 1 and closed["adds"] == {"avg": 1, "pyr": 0}


# ---------------------------------------------------------------- restart, catch-up
def test_restart_restores_the_open_trade_and_never_enters_twice(env):
    svc, paper, clock, store, toi, market = env
    entry(svc, paper, clock)
    svc.stop_thread()
    paper.listeners.remove(svc.on_packet)
    again = make(store, toi, paper, market, clock)  # a new process: same Postgres (toi store) and paper account
    clock.now = at("09:51")
    again.tick(clock.now)
    o = again.state["open"]
    assert (o["lots"], o["strike"], again.state["trades"]) == (2, 23200.0, 1)
    assert any(e["message"].startswith("Restarted: resumed today's state (1 trades, open CE 2 lots)") for e in events(toi, "info"))
    candle(again, paper, clock, "09:55", 23235, 23250, 23236, 23245, OPTS)  # no pullback; and an open trade: no entry
    buys = [x for x in store.orders(acc(store, cfg.ACCOUNT_NAME), DAY) if x["side"] == "BUY"]
    assert len(buys) == 1


def test_restart_after_an_exit_while_down_closes_the_state(env):
    svc, paper, clock, store, toi, market = env
    entry(svc, paper, clock)
    svc.broker.exit(sid(23200, "CE"), at("09:52"), "manual test exit")  # the paper account is flat; the state not
    paper.listeners.remove(svc.on_packet)
    again = make(store, toi, paper, market, clock)
    clock.now = at("09:53")
    again.tick(clock.now)
    assert again.state["open"] is None and again.state["closed"]
    assert any("already closed in the paper account" in e["message"] for e in events(toi, "info"))


def test_a_late_start_catches_up_without_trading_old_candles(env):
    svc, paper, clock, store, toi, market = env
    clock.now = at("11:02")
    svc.tick(clock.now)
    assert svc.state["lastCandle"] == int(at("11:00").timestamp())
    assert any(e["message"].startswith("Started at 11:02: indicators from Dhan's history; candles up to 11:00 are not traded")
               for e in events(toi, "info"))


# ---------------------------------------------------------------- kill switch, stale feed, settings
def test_kill_switch_blocks_entries_and_stop_exit_all_sells(env):
    svc, paper, clock, store, toi, _ = env
    morning(svc, paper, clock)
    svc.stop(who="naveen")
    candle(svc, paper, clock, "09:50", 23240, 23242, 23205, 23235, OPTS)
    assert svc.state["open"] is None and "stopped by the kill switch" in events(toi, "skip")[-1]["message"]
    svc.resume()
    candle(svc, paper, clock, "09:55", 23240, 23242, 23205, 23235, OPTS)
    assert svc.state["open"]["lots"] == 2
    svc.stop(exit_all=True)
    assert svc.state["open"] is None and svc.broker.open_qty(sid(23200, "CE")) == 0


def test_a_stale_feed_blocks_entries(env):
    svc, paper, clock, store, toi, _ = env
    morning(svc, paper, clock)
    clock.now = at("09:48", 30)  # 2 min 30 s without an index tick
    svc.tick(clock.now)
    assert svc.stale and events(toi, "feed")[-1]["message"].startswith("Live feed stale")


def test_settings_changes_are_logged_and_used_by_new_decisions(env):
    svc, paper, clock, store, toi, _ = env
    morning(svc, paper, clock)
    with pytest.raises(ValueError):
        svc.set_settings({"nope": 1})
    svc.set_settings({"entryLots": 3}, who="naveen")
    ev = events(toi, "settings")[-1]
    assert ev["message"] == "Setting entryLots: 2 -> 3 (by naveen); open trades keep their stop and lots"
    candle(svc, paper, clock, "09:50", 23240, 23242, 23205, 23235, OPTS)
    assert svc.state["open"]["lots"] == 3


# ---------------------------------------------------------------- signals mode, summary
def test_signals_mode_places_no_orders(env):
    _svc, paper, clock, store, toi, market = env
    paper.listeners.remove(_svc.on_packet)
    svc = make(store, MemoryToiStore(), paper, market, clock, mode="signals")
    svc.broker = None
    entry(svc, paper, clock)
    assert svc.state["open"]["lots"] == 2
    assert store.orders(acc(store, cfg.ACCOUNT_NAME), DAY) == []


def test_daily_summary_at_1535(env):
    svc, paper, clock, store, toi, _ = env
    entry(svc, paper, clock)
    index(paper, clock, at("10:20"), 23179.0)  # stop loss
    clock.now = at("15:35", 5)
    svc.tick(clock.now)
    (row,) = toi.summaries(DAY, DAY)
    assert (row["trades"], row["wins"], row["losses"]) == (1, 0, 1) and row["net_pnl"] < 0


# ---------------------------------------------------------------- safety: no real orders
MODULES = ("trending_oi_algo_config.py", "indicators.py", "toi_algo_data.py", "toi_algo_logic.py", "toi_algo_service.py",
           "toi_algo_store.py")
ALLOWED = {"copy", "json", "logging", "os", "threading", "dataclasses", "datetime", "typing", "toi_algo_logic",
           "trending_oi_algo_config", "algo_filters", "algo_service", "candles", "dhan_feed", "holidays", "indicators",
           "sr_levels", "store", "toi_algo_data"}
ORDER_WORDS = ("/orders", "/super/orders", "/forever", "placeorder", "modify_order", "cancel_order", "/v2/orders", "dhan_client")


def test_cannot_reach_a_real_order_endpoint():
    for name in MODULES:
        src = open(os.path.join(HERE, name), encoding="utf-8").read()
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Import):
                mods = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                mods = [(node.module or "").split(".")[0]]
            else:
                continue
            assert set(mods) <= ALLOWED, f"{name} imports {mods}"
        low = src.lower()
        for w in ORDER_WORDS:
            assert w not in low, f"{name} mentions {w!r}"
    # orders go only through algo_service.AlgoBroker, whose engine is the paper simulator
    from algo_service import AlgoBroker
    assert "PaperEngine(" in open(os.path.join(HERE, "algo_service.py"), encoding="utf-8").read()
    assert "engine" in AlgoBroker.buy.__code__.co_names and "engine" in AlgoBroker.sell.__code__.co_names


# ---------------------------------------------------------------- routes (toi_algo_api.py)
def client(svc, user=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import toi_algo_api
    from test_algo_service import signed_in
    app = signed_in(FastAPI(), user)
    toi_algo_api.register(app, svc)
    return TestClient(app)


def test_routes_status_kill_switch_settings_and_reports(env):
    svc, paper, clock, store, toi, _ = env
    entry(svc, paper, clock)
    c = client(svc)
    st = c.get("/api/toi-algo/status").json()
    assert st["direction"]["side"] == "CE" and st["direction"]["dots"] == 3 and st["levels"] == LEVELS
    o = st["open"]
    assert (o["side"], o["lots"], o["strike"], o["next"], o["caps"]) == ("CE", 2, 23200.0, "R1 23,300", {"avg": 6, "pyr": 4, "max": 6})
    assert st["indicators"]["supertrend"] == 23200.0 and st["indicators"]["basis"] == 120.0
    assert st["meta"]["entryWindow"] == "09:45-14:30" and st["meta"]["mode"] == "paper"
    rows = c.get("/api/toi-algo/events").json()["rows"]
    assert rows[0]["type"] == "info" and rows[0]["message"].startswith("Entry filled")  # newest first
    assert c.post("/api/toi-algo/stop").json()["meta"]["halted"] is True
    assert c.post("/api/toi-algo/resume").json()["meta"]["halted"] is False
    assert c.put("/api/toi-algo/settings", json={"entryLots": 2.5}).status_code == 400
    assert c.put("/api/toi-algo/settings", json={"entryFrom": "9:45"}).status_code == 400
    assert c.put("/api/toi-algo/settings", json={"nope": 1}).status_code == 400
    r = c.put("/api/toi-algo/settings", json={"maxTrades": 1, "entryTo": "14:00"})
    assert r.status_code == 200 and r.json()["settings"]["maxTrades"] == 1
    assert [e["message"] for e in events(toi, "settings")] == [
        "Setting maxTrades: 2 -> 1 (by naveen); open trades keep their stop and lots",
        "Setting entryTo: 14:30 -> 14:00 (by naveen); open trades keep their stop and lots"]
    assert c.post("/api/toi-algo/stop-exit-all").json()["open"] is None
    svc.write_summary(at("15:35"))
    rep = c.get(f"/api/toi-algo/reports?from={DAY}&to={DAY}").json()
    assert rep["tiles"]["trades"] == 1 and len(rep["rows"]) == 1 and rep["tiles"]["winRate"] is not None
    day = c.get(f"/api/toi-algo/day?date={DAY}").json()
    assert day["trades"] and day["candles"]


def test_routes_are_only_for_the_owner(env):
    from auth import User
    svc, *_ = env
    c = client(svc, User(2, "wife", "Wife"))
    assert c.get("/api/toi-algo/status").status_code == 404
    assert c.post("/api/toi-algo/stop-exit-all").status_code == 404


def test_three_minute_candles_by_default(env):
    """The default timeframe: 3-minute candles 09:15-aligned (09:15-09:18, 09:18-09:21 ...), each evaluated once,
    Trending OI asked for 3-minute rows."""
    _svc, paper, clock, store, _toi, market = env
    paper.listeners.remove(_svc.on_packet)
    toi = MemoryToiStore()
    toi.save_settings({"candleMin": 3}, clock())
    svc = make(store, toi, paper, market, clock)
    assert svc.settings()["candleMin"] == 3
    assert svc._last_closed_end(at("09:17", 59)) is None and svc._last_closed_end(at("09:18", 5)) == at("09:18")
    assert svc._last_closed_end(at("10:04")) == at("10:03")
    clock.now = at("09:15", 5)
    svc.tick(clock.now)
    for i, px in enumerate((23220, 23230, 23210)):  # 09:15, 09:16, 09:17
        index(paper, clock, at(f"09:1{5 + i}", 20), px)
    index(paper, clock, at("09:17", 55), 23225)
    clock.now = at("09:18", 11)
    svc.tick(clock.now)
    svc.tick(at("09:18", 40))  # same candle: not evaluated twice
    (row,) = toi.candles(DAY)
    assert row["start"] == int(at("09:15").timestamp()) and (row["open"], row["high"], row["low"], row["close"]) == (23220, 23230, 23210, 23225)
    assert market.asked == [3]
