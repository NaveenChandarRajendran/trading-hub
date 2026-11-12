"""ORB Algo runner (orb_service.py) on fakes: paper orders in its own account, the 15:25 square-off (ADR 0013),
catch-up, restart, kill switch, feed watchdog, liquidity, settings, summary, and no path to a real order."""
import ast
import os
import shutil
import tempfile
from datetime import datetime, time, timedelta

import pytest

import orb_config as cfg
from orb_service import OrbAlgoService, OrbData
from orb_store import MemoryOrbStore
from paper_api import PaperService
from paper_engine import PaperEngine
from store import IST, PaperJsonStore
from test_paper_api import FakeFeed, full

HERE = os.path.dirname(os.path.abspath(__file__))
DAY = "2026-11-13"  # Friday
EXP = "2026-11-17"


def at(hm, s=0):
    h, m = map(int, hm.split(":"))
    return datetime.fromisoformat(f"{DAY}T{h:02d}:{m:02d}:{s:02d}").replace(tzinfo=IST)


def sid(strike, side):
    return (100000 if side == "CE" else 200000) + int(strike)


class Instruments:
    def get(self, s):
        strike, typ = (s - 100000, "CE") if s < 200000 else (s - 200000, "PE")
        return {"securityId": s, "symbol": "NIFTY", "expiry": EXP, "strike": float(strike), "optionType": typ,
                "lotSize": 65, "tickSize": 0.05, "name": f"NIFTY 17 NOV {strike} {'CALL' if typ == 'CE' else 'PUT'}"}

    def chain(self, symbol, expiry):
        return [{"strike": float(k), "ce": self.get(sid(k, "CE")), "pe": self.get(sid(k, "PE"))} for k in range(23700, 24401, 50)]

    def future_ids(self):
        return set()

    def expiries(self, symbol, today=None):
        return [EXP]


class Clock:
    now = at("09:14")

    def __call__(self):
        return self.now


class Market:
    def __init__(self):
        self.dead = set()
        self.history = []

    def chain(self, expiry):
        def leg(k, side):
            dead = (k, side) in self.dead
            return {"oi": 50000, "volume": 0 if dead else 90000, "top_bid_price": 0 if dead else 100.0,
                    "top_ask_price": 0 if dead else 100.5, "last_price": 100.2}
        return {"spot": 24000.0, "lotSize": 65, "oc": {float(k): {"ce": leg(k, "CE"), "pe": leg(k, "PE")} for k in range(23700, 24401, 50)}}


def make(store, orb, paper, market, clock, mode="paper"):
    data = OrbData(expiries=lambda: [DAY, EXP, "2026-11-24"], chain=market.chain, intraday=lambda: list(market.history),
                   token_expired=lambda: False)
    return OrbAlgoService(store, orb, paper, Instruments(), data, clock, mode=mode)


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock = Clock()
    clock.now = at("09:14")
    store = PaperJsonStore(tmp)
    store.create_strategy(1, cfg.STRATEGY_NAME, "", cfg.CAPITAL, "algo", clock(), account_name=cfg.ACCOUNT_NAME)
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    market, orb = Market(), MemoryOrbStore()
    svc = make(store, orb, paper, market, clock)
    yield svc, paper, clock, store, orb, market
    shutil.rmtree(tmp, ignore_errors=True)


OPTS = {sid(k, side): p for k, side, p in ((24000, "CE", 120.0), (23950, "CE", 150.0), (24100, "PE", 110.0),
                                             (24050, "CE", 95.0), (24050, "PE", 80.0), (23900, "PE", 60.0))}


def index(paper, clock, t, spot):
    clock.now = t
    paper.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 13, "ltp": spot})


def books(paper, prices):
    for s, p in prices.items():
        paper.on_packet(full(s, p, round(p - 0.05, 2), round(p + 0.05, 2)))


def minute(svc, paper, clock, hm, o, h, l, c, opts=OPTS):
    """Ticks for the 1-minute candle starting at hm, the option books, then the timer 3 s after it closes."""
    s = at(hm)
    for i, px in enumerate((o, h, l, c)):
        index(paper, clock, s + timedelta(seconds=5 + 12 * i), px)
    books(paper, opts)
    clock.now = s + timedelta(minutes=1, seconds=3)
    svc.tick(clock.now)


def flat(svc, paper, clock, start_i, end_i, px=24000):
    for i in range(start_i, end_i):
        m = 9 * 60 + 15 + i
        minute(svc, paper, clock, f"{m // 60:02d}:{m % 60:02d}", px, px, px, px)


def morning(svc, paper, clock):
    """09:15-10:14 live: 5m OR 23,990-24,010, 30m OR 23,960-24,040 (the 09:30 candle), 60m OR 23,900-24,050 (0.625%)."""
    svc.tick(at("09:14", 30))
    minute(svc, paper, clock, "09:15", 24000, 24010, 23990, 24000)
    flat(svc, paper, clock, 1, 15)
    minute(svc, paper, clock, "09:30", 24000, 24040, 23960, 24000)
    flat(svc, paper, clock, 16, 45)
    minute(svc, paper, clock, "10:00", 24000, 24050, 23900, 24000)
    flat(svc, paper, clock, 46, 60)


def events(orb, typ=None):
    return [e for e in orb.events(DAY) if typ is None or e["type"] == typ]


def test_60m_breakout_buys_1_itm_ce_in_the_orb_account_and_the_close_stop_sells(env):
    svc, paper, clock, store, orb, _ = env
    morning(svc, paper, clock)
    assert svc.state["setups"]["b60"]["status"] == "armed"
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    o = svc.state["setups"]["b60"]["open"]
    assert (o["strike"], o["side"], o["lots"], o["entrySpot"], o["stop"]) == (24000.0, "CE", 1, 24060, 23900)  # ATM 24,050: 1 ITM 24,000
    acc = store.active_account(cfg.ACCOUNT_NAME)["id"]
    (order,) = store.orders(acc, DAY)
    assert order["setup"] == "ORB 60m Breakout" and order["source"] == "algo" and order["qty"] == 65
    minute(svc, paper, clock, "10:30", 23950, 23960, 23890, 23950)  # wick below 23,900, close above: holds
    assert svc.state["setups"]["b60"]["open"] is not None
    minute(svc, paper, clock, "10:40", 23950, 23950, 23880, 23890, {**OPTS, sid(24000, "CE"): 70.0})
    (t,) = [x for x in svc.state["closed"] if x["setup"] == "b60"]
    assert (t["entrySpot"], t["exitSpot"], t["points"]) == (24060, 23890, -170.0)
    assert t["pnl"] == round((69.95 - 120.05) * 65, 2) and t["charges"] > 0 and t["exitReason"].startswith("Stop: the 10:40 candle closed")
    assert svc.broker.open_qty(sid(24000, "CE")) == 0 and svc.state["setups"]["b60"]["status"] == "done"


def test_the_orb_account_trades_until_1525_and_squares_off_then(env):
    svc, paper, clock, store, orb, _ = env
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    assert svc.broker.engine.square_off_at == time(15, 25)
    assert svc.broker.engine.accepting_orders(at("15:20")) and not svc.broker.engine.accepting_orders(at("15:25"))
    books(paper, {sid(24000, "CE"): 140.0})
    index(paper, clock, at("15:24", 50), 24120)
    clock.now = at("15:25", 1)
    svc.tick(clock.now)
    (t,) = [x for x in svc.state["closed"] if x["setup"] == "b60"]
    assert (t["exitReason"], t["exitAt"], t["exitSpot"], t["exitPrice"]) == ("15:25 exit", "15:25", 24120, 139.95)
    assert t["points"] == 60.0 and svc.broker.open_qty(sid(24000, "CE")) == 0
    acc = store.active_account(cfg.ACCOUNT_NAME)["id"]
    assert any("15:25" in (o.get("setup") or "") for o in store.orders(acc, DAY))


def test_engine_square_off_time_is_per_account():
    assert PaperEngine(1000).square_off_at == time(15, 15)
    e = PaperEngine(1000, square_off=time(15, 25))
    assert e.accepting_orders(at("15:24")) and not e.accepting_orders(at("15:25"))
    with pytest.raises(ValueError):
        PaperEngine(1000, square_off=time(15, 31))


def test_illiquid_1_itm_means_no_trade_by_default(env):
    svc, paper, clock, store, orb, market = env
    market.dead.add((24000, "CE"))
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    st = svc.state["setups"]["b60"]
    assert st["open"] is None and st["status"] == "done" and "24,000 CE no trades today" in st["reason"]
    assert svc.state["trades"] == 0


def test_a_late_start_catches_up_from_history_without_trading_old_signals(env):
    svc, paper, clock, store, orb, market = env
    morning(svc, paper, clock)  # only to build the history below from a real run
    hist = [c for t, c in sorted(svc.minutes.items())]
    # a 5m reversal while the algo was down: first breakout 09:25, back inside 09:26, other side 09:27
    hist = [dict(c) for c in hist]
    for c in hist:
        hm = datetime.fromtimestamp(c["time"], IST).strftime("%H:%M")
        if hm in ("09:25", "09:26", "09:27"):
            c.update(close={"09:25": 24020, "09:26": 24000, "09:27": 23980}[hm])
            c["high"], c["low"] = max(c["high"], c["close"]), min(c["low"], c["close"])
    paper.listeners.remove(svc.on_packet)
    market.history = hist
    fresh = make(store, MemoryOrbStore(), paper, market, clock)
    clock.now = at("10:15", 10)
    fresh.tick(clock.now)
    assert fresh.state["ors"]["60"]["done"] and fresh.state["ors"]["60"]["high"] == 24050
    v5 = fresh.state["setups"]["v5"]
    assert v5["status"] == "done" and "not traded" in v5["reason"] and v5["open"] is None
    assert any(e["message"].startswith("Caught up 60 candles") for e in fresh.orb.events(DAY))
    flat(fresh, paper, clock, 61, 65)  # live minutes 10:16-10:19 (the option books come in)
    minute(fresh, paper, clock, "10:20", 24040, 24065, 24040, 24060)  # live again: trades
    assert fresh.state["setups"]["b60"]["open"]["strike"] == 24000.0


def test_restart_resumes_the_open_trade_and_never_enters_twice(env):
    svc, paper, clock, store, orb, market = env
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    market.history = [c for _t, c in sorted(svc.minutes.items())]
    paper.listeners.remove(svc.on_packet)
    again = make(store, orb, paper, market, clock)
    clock.now = at("10:22", 5)
    again.tick(clock.now)
    assert again.state["setups"]["b60"]["open"]["securityId"] == sid(24000, "CE") and again.state["trades"] == 1
    acc = store.active_account(cfg.ACCOUNT_NAME)["id"]
    assert len(store.orders(acc, DAY)) == 1
    assert any(e["message"].startswith("Restarted: resumed today's state (1 trades, open: 60m Breakout)") for e in orb.events(DAY))


def test_kill_switch_and_stale_feed_block_entries(env):
    svc, paper, clock, store, orb, _ = env
    morning(svc, paper, clock)
    svc.stop(who="naveen")
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    assert svc.state["setups"]["b60"]["open"] is None and "kill switch" in svc.state["setups"]["b60"]["reason"]
    svc.resume()
    # stale: no tick for over 2 minutes
    clock.now = at("10:24", 30)
    svc.tick(clock.now)
    assert svc.stale and events(orb, "feed")[-1]["message"].startswith("Live feed stale")


def test_stop_exit_all_sells_every_open_setup(env):
    svc, paper, clock, store, orb, _ = env
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    svc.stop(exit_all=True, who="naveen")
    assert svc.state["setups"]["b60"]["open"] is None and svc.broker.open_qty(sid(24000, "CE")) == 0
    assert svc.state["closed"][0]["exitReason"] == "kill switch: stop + exit all"


def test_settings_change_new_decisions_and_square_off_time(env):
    svc, paper, clock, store, orb, _ = env
    svc.set_settings({"squareOff": "15:20", "lots": 2}, who="naveen")
    assert svc.broker.square_off == time(15, 20) and svc.settings()["lots"] == 2
    assert [h["key"] for h in orb.settings_store.history(cfg.SLUG)] == ["lots", "squareOff"] or \
        {h["key"] for h in orb.settings_store.history(cfg.SLUG)} == {"lots", "squareOff"}
    morning(svc, paper, clock)
    assert svc.broker.engine.square_off_at == time(15, 20)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    assert svc.state["setups"]["b60"]["open"]["lots"] == 2
    svc.set_settings({"lots": 1})
    assert svc.state["setups"]["b60"]["open"]["lots"] == 2  # the open trade keeps its lots


def test_daily_summary_per_setup(env):
    svc, paper, clock, store, orb, _ = env
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    minute(svc, paper, clock, "10:40", 23950, 23950, 23880, 23890, {**OPTS, sid(24000, "CE"): 70.0})
    rows = svc.write_summary(at("15:35"))
    b60 = next(r for r in rows if r["setup"] == "b60")
    assert (b60["trades"], b60["losses"], b60["points"]) == (1, 1, -170.0) and b60["net_pnl"] < b60["gross_pnl"] < 0
    assert {r["setup"] for r in orb.summaries(DAY, DAY)} == {"b60", "r30", "v5"}


def test_signals_mode_places_no_orders(env):
    _svc, paper, clock, store, _orb, market = env
    paper.listeners.remove(_svc.on_packet)
    svc = make(store, MemoryOrbStore(), paper, market, clock, mode="signals")
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    assert svc.broker is None and svc.state["setups"]["b60"]["open"]["strike"] == 24000.0
    acc = store.active_account(cfg.ACCOUNT_NAME)["id"]
    assert store.orders(acc, DAY) == []


MODULES = ("orb_config.py", "orb_logic.py", "orb_service.py", "orb_store.py")
ALLOWED = {"copy", "json", "logging", "os", "threading", "dataclasses", "datetime", "typing", "orb_config", "orb_logic",
           "algo_logic", "algo_service", "algo_settings", "candles", "dhan_feed", "holidays", "store", "toi_algo_data",
           "toi_algo_logic"}
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
    from algo_service import AlgoBroker
    assert "engine" in AlgoBroker.buy.__code__.co_names and "engine" in AlgoBroker.sell.__code__.co_names
