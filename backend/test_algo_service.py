"""OI breakout algo end to end (algo_service.py): ticks -> 5-minute candles -> rules -> PAPER orders in the Algo account,
exits, 15:15, risk / stale / kill switch, restart without double entry, signals mode, and the no-real-orders check.
Real PaperService + PaperEngine + PaperJsonStore with a fake feed, fake instruments and fake market data."""
import ast
import os
import shutil
import tempfile
from datetime import datetime, timedelta

import pytest

import algo_config as cfg
from algo_service import AlgoData, AlgoService
from paper_api import PaperService
from store import IST, PaperJsonStore
from test_paper_api import FakeFeed, full

HERE = os.path.dirname(__file__)
DAY = "2026-10-23"  # Friday
NIFTY_ID = 13
CALLS = {22800: 900, 22900: 100, 23000: 800, 23100: 700, 23200: 50}
PUTS = {22600: 900, 22500: 800, 22400: 100, 22300: 50, 22200: 700}
GOOD_CE = {"toi": {"sentiment": "Bullish", "strength": 55.0}, "oiChange": {"verdict": "BULLISH", "points": 25.0},
           "components": {"verdict": "Neutral", "indexMove": 0.01, "priced": 50, "total": 50}, "rsi": 62.0}


def at(hm, s=0):
    h, m = map(int, hm.split(":"))
    return datetime(2026, 10, 23, h, m, s, tzinfo=IST)


def ce(strike):
    return 100000 + strike


def pe(strike):
    return 200000 + strike


class Instruments:
    def get(self, sid):
        strike, typ = (sid - 100000, "CE") if sid < 200000 else (sid - 200000, "PE")
        return {"securityId": sid, "symbol": "NIFTY", "expiry": "2026-10-27", "strike": float(strike), "optionType": typ,
                "lotSize": 65, "tickSize": 0.05, "name": f"NIFTY 27 OCT {strike} {'CALL' if typ == 'CE' else 'PUT'}"}

    def future_ids(self):
        return set()

    def expiries(self, symbol, today=None):
        return ["2026-10-27", "2026-11-03"]

    def chain(self, symbol, expiry):
        if symbol != "NIFTY":
            return []
        return [{"strike": float(k), "ce": self.get(ce(k)), "pe": self.get(pe(k))} for k in range(22500, 23101, 100)]


class Clock:
    now = at("09:20")

    def __call__(self):
        return self.now


def make_data(token=lambda: False):
    oc = {float(k): {"ce": {"oi": CALLS.get(k, 0), "previous_oi": 0}, "pe": {"oi": PUTS.get(k, 0), "previous_oi": 0}}
          for k in sorted(set(CALLS) | set(PUTS))}

    def chain(symbol, expiry):
        if symbol != "NIFTY":
            raise RuntimeError("no BANKNIFTY in this test")
        return {"spot": 22700.0, "oc": oc, "lotSize": 65}

    return AlgoData(expiries=lambda s: ["2026-10-27"], chain=chain, trending=lambda s, e: None,
                    components=lambda s: {"constituents": [], "quotes": {}, "history": {}},
                    intraday=lambda s: [], token_expired=token)


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock = Clock()
    clock.now = at("09:20")
    store = PaperJsonStore(tmp)
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    algo = AlgoService(store, paper, Instruments(), make_data(), clock, mode="paper", log_dir=os.path.join(tmp, "logs"))
    algo.filters = lambda sym, end, now: dict(GOOD_CE)
    yield algo, paper, clock, store, tmp
    shutil.rmtree(tmp, ignore_errors=True)


def tick(paper, clock, t, spot):
    clock.now = t
    paper.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": NIFTY_ID, "ltp": spot})


def books(paper, clock, t, prices):
    """Option order books: {security id: ltp} (bid / ask 0.05 around it)."""
    clock.now = t
    for sid, p in prices.items():
        paper.on_packet(full(sid, p, round(p - 0.05, 2), round(p + 0.05, 2)))


def candle(algo, paper, clock, end, o, h, l, c, options=None):
    """Ticks for the 5-minute candle ending at `end` ("10:05"), then the algo's timer just after it closes."""
    e = at(end)
    for i, px in enumerate((o, h, l, c)):
        tick(paper, clock, e - timedelta(minutes=4, seconds=50) + timedelta(minutes=i), px)
    if options:
        books(paper, clock, e - timedelta(seconds=30), options)
    tick(paper, clock, e - timedelta(seconds=5), c)
    clock.now = e + timedelta(seconds=11)
    algo.tick(clock.now)


def kinds(algo, symbol="NIFTY"):
    return [e["kind"] for e in algo.store.algo_events(DAY) if e["symbol"] in (symbol, "*")]


def setup_levels(algo, paper, clock):
    tick(paper, clock, at("09:29", 50), 22700)
    clock.now = at("09:30", 5)
    algo.tick(clock.now)
    assert algo.states["NIFTY"]["levels"] == {"R1": 22800.0, "R2": 23000.0, "R3": 23100.0,
                                              "S1": 22600.0, "S2": 22500.0, "S3": 22200.0}


def breakout_entry(algo, paper, clock):
    setup_levels(algo, paper, clock)
    opts = {ce(22800): 120.0, pe(22800): 95.0, ce(22900): 70.0, pe(22900): 150.0, ce(22700): 180.0, pe(22700): 60.0}
    candle(algo, paper, clock, "10:00", 22790, 22818, 22788, 22815, opts)
    candle(algo, paper, clock, "10:05", 22815, 22830, 22806, 22821, opts)
    return opts


def test_levels_locked_at_0930_and_logged_to_store_and_file(env):
    algo, paper, clock, store, tmp = env
    setup_levels(algo, paper, clock)
    ev = [e for e in store.algo_events(DAY) if e["kind"] == "levels"]
    assert len(ev) == 1 and ev[0]["message"].startswith("Levels locked at 09:30: R1 22,800")
    log_text = open(os.path.join(tmp, "logs", f"algo-{DAY}.log"), encoding="utf-8").read()
    assert "LEVELS" in log_text and "R1 22,800" in log_text
    assert ("IDX_I", NIFTY_ID) in paper._feed_subs


def test_breakout_pullback_places_a_tagged_paper_order_in_the_algo_account(env):
    algo, paper, clock, store, _ = env
    breakout_entry(algo, paper, clock)
    st = algo.states["NIFTY"]
    assert st["trades"] == 1 and st["open"]["option"] == "NIFTY 27 OCT 22800 CALL" and st["open"]["entryPrice"] == 120.05
    acc = algo.broker.account
    assert acc["name"] == "Algo" and acc["capital"] == cfg.CAPITAL
    orders = store.orders(acc["id"], DAY)
    assert [(o["side"], o["status"], o["source"], o["setup"]) for o in orders] == [("BUY", "FILLED", "algo", "Breakout CE")]
    assert paper.account["id"] != acc["id"] and store.orders(paper.account["id"], DAY) == []  # manual account untouched
    entry = [e for e in store.algo_events(DAY) if e["kind"] == "entry"][0]
    assert "BUY NIFTY 27 OCT 22800 CALL @ 120.05" in entry["message"] and "Why: Breakout CE: break 10:00 candle" in entry["message"]
    assert kinds(algo)[-3:] == ["candle", "armed", "candle"] or "entry" in kinds(algo)


def test_target_zone_exit_records_the_trade_for_review(env):
    algo, paper, clock, store, _ = env
    breakout_entry(algo, paper, clock)
    books(paper, clock, at("10:20"), {ce(22800): 190.0})
    tick(paper, clock, at("10:21"), 22991)  # R2 23,000 - 10
    st = algo.states["NIFTY"]
    assert st["open"] is None
    t = st["closed"][0]
    assert t["exitReason"].startswith("Target zone reached: spot 22,991 >= 22,990") and t["exitPrice"] == 189.95
    assert t["pnl"] == round((189.95 - 120.05) * 65, 2) and t["entryAt"] == "10:05:11" and t["exitAt"] == "10:21:00"
    assert t["reason"].startswith("Breakout CE: break 10:00 candle")
    sells = [o for o in store.orders(algo.broker.account["id"], DAY) if o["side"] == "SELL"]
    assert sells[0]["setup"] == "Breakout CE" and sells[0]["source"] == "algo"


def test_premium_stop_exits_on_the_option_tick(env):
    algo, paper, clock, *_ = env
    breakout_entry(algo, paper, clock)
    books(paper, clock, at("10:10"), {ce(22800): 109.0})  # 120.05 - 10% = 108.045: not yet
    assert algo.states["NIFTY"]["open"] is not None
    books(paper, clock, at("10:11"), {ce(22800): 108.0})
    assert algo.states["NIFTY"]["closed"][0]["exitReason"].startswith("Premium stop: LTP 108 <= entry 120.05 - 10%")


def test_spot_stop_on_the_candle_close_and_square_off_at_1515(env):
    algo, paper, clock, *_ = env
    opts = breakout_entry(algo, paper, clock)
    candle(algo, paper, clock, "10:10", 22820, 22822, 22780, 22785, opts)
    assert algo.states["NIFTY"]["closed"][0]["exitReason"].startswith("Spot stop: 10:10 candle")

    algo, paper, clock, store, tmp = env
    algo.filters = lambda sym, end, now: {**GOOD_CE, "toi": None}  # bullish Trending OI would block a range PE
    candle(algo, paper, clock, "10:30", 22780, 22805, 22775, 22790, opts)  # range touch at R1 -> PE
    assert algo.states["NIFTY"]["open"]["setup"] == "Range PE (R1 rejection)"
    tick(paper, clock, at("15:14", 50), 22700)
    books(paper, clock, at("15:14", 55), {pe(22800): 99.0})
    clock.now = at("15:15", 1)
    algo.tick(clock.now)
    assert algo.states["NIFTY"]["closed"][-1]["exitReason"] == "Square-off 15:15"
    assert algo.broker.open_qty(pe(22800)) == 0


def test_max_trades_and_day_loss_block_new_entries(env):
    algo, paper, clock, *_ = env
    setup_levels(algo, paper, clock)
    algo.states["NIFTY"]["trades"] = cfg.MAX_TRADES_PER_INDEX
    algo.filters = lambda sym, end, now: {**GOOD_CE, "toi": None}
    candle(algo, paper, clock, "10:30", 22780, 22805, 22775, 22790)
    msgs = [e["message"] for e in algo.store.algo_events(DAY) if e["kind"] == "skip"]
    assert any("max 4 trades for NIFTY today" in m for m in msgs)

    algo.states["NIFTY"]["trades"] = 0
    algo.filters = lambda sym, end, now: {**GOOD_CE, "toi": None}
    algo.broker.day_pnl = lambda: -2000.0
    candle(algo, paper, clock, "10:40", 22795, 22798, 22770, 22780)  # re-arms the R1 touch
    candle(algo, paper, clock, "10:45", 22780, 22801, 22775, 22785)
    msgs = [e["message"] for e in algo.store.algo_events(DAY)]
    assert any("day loss limit reached" in m for m in msgs) and algo.states["NIFTY"]["open"] is None


def test_stale_data_blocks_entries_and_exits_an_open_position_when_data_returns(env):
    algo, paper, clock, *_ = env
    breakout_entry(algo, paper, clock)
    clock.now = at("10:12")  # last spot tick 10:05:05 -> > 5 min old
    algo.tick(clock.now)
    assert algo.states["NIFTY"]["open"]["staleExit"] is True
    books(paper, clock, at("10:12", 30), {ce(22800): 125.0})  # option tick alone does not count as spot data
    tick(paper, clock, at("10:13"), 22830)
    t = algo.states["NIFTY"]["closed"][0]
    assert t["exitReason"].startswith("Data was stale for more than 5 minutes")


def test_restart_resumes_without_double_entry(env):
    algo, paper, clock, store, tmp = env
    opts = breakout_entry(algo, paper, clock)
    # a new process: same store, same moment
    paper2 = PaperService(PaperJsonStore(tmp), FakeFeed(), Instruments(), clock=clock)
    algo2 = AlgoService(paper2.store, paper2, Instruments(), make_data(), clock, mode="paper",
                        log_dir=os.path.join(tmp, "logs"))
    algo2.filters = lambda sym, end, now: dict(GOOD_CE)
    clock.now = at("10:05", 30)
    algo2.tick(clock.now)  # the 10:05 candle was already evaluated: not again
    st = algo2.states["NIFTY"]
    assert st["levels"]["R1"] == 22800.0 and st["trades"] == 1 and st["open"]["option"] == "NIFTY 27 OCT 22800 CALL"
    assert algo2.broker.account["id"] == algo.broker.account["id"]
    buys = [o for o in paper2.store.orders(algo2.broker.account["id"], DAY) if o["side"] == "BUY"]
    assert len(buys) == 1
    books(paper2, clock, at("10:06"), opts)
    candle(algo2, paper2, clock, "10:10", 22821, 22840, 22815, 22830, opts)
    assert len([o for o in paper2.store.orders(algo2.broker.account["id"], DAY) if o["side"] == "BUY"]) == 1
    assert any(e["message"].startswith("Restarted: resumed today's state") for e in paper2.store.algo_events(DAY))


def test_kill_switch_stop_and_stop_exit_all(env):
    algo, paper, clock, *_ = env
    opts = breakout_entry(algo, paper, clock)
    algo.stop(exit_all=False)
    assert algo.states["NIFTY"]["open"] is not None and algo.states["NIFTY"]["stopped"]
    algo.stop(exit_all=True)
    assert algo.states["NIFTY"]["open"] is None
    assert algo.states["NIFTY"]["closed"][0]["exitReason"] == "Kill switch: stop and exit all"
    candle(algo, paper, clock, "10:30", 22780, 22805, 22775, 22790, opts)
    assert algo.states["NIFTY"]["open"] is None
    algo.resume()
    assert not algo.states["NIFTY"]["stopped"]


def test_signals_mode_logs_entries_and_exits_without_orders(env):
    algo, paper, clock, store, tmp = env
    sig = AlgoService(store, paper, Instruments(), make_data(), clock, mode="signals", log_dir=os.path.join(tmp, "logs2"))
    sig.filters = lambda sym, end, now: dict(GOOD_CE)
    paper.listeners.remove(algo.on_packet)
    breakout_entry(sig, paper, clock)
    entry = [e for e in store.algo_events(DAY) if e["kind"] == "entry"]
    assert entry and entry[-1]["message"].startswith("SIGNAL BUY NIFTY 27 OCT 22800 CALL @ 120")
    assert store.orders(sig.broker.account["id"], DAY) == []
    tick(paper, clock, at("10:21"), 22995)
    assert sig.states["NIFTY"]["closed"][0]["pnl"] is not None


def test_status_endpoint_shape(env):
    algo, paper, clock, *_ = env
    breakout_entry(algo, paper, clock)
    s = algo.status()
    n = s["indices"][0]
    assert s["meta"]["mode"] == "paper" and n["symbol"] == "NIFTY" and n["state"] == "in trade"
    assert n["open"]["ltp"] == 120.0 and n["levels"]["R1"] == 22800.0 and n["trades"] == 1
    assert algo.events()[0]["kind"] in ("entry", "candle")


# ---------------------------------------------------------------- safety
ALGO_MODULES = ("algo_config.py", "algo_filters.py", "algo_logic.py", "algo_service.py", "algo_api.py")
ALLOWED_IMPORTS = {"json", "logging", "os", "re", "threading", "dataclasses", "datetime", "typing", "fastapi",
                   "algo_config", "algo_filters", "algo_logic", "candles", "dhan_client", "dhan_feed", "holidays",
                   "paper_engine", "sr_levels", "store"}
ORDER_WORDS = ("/orders", "/super/orders", "/forever", "placeorder", "place_order(", "modify_order", "cancel_order",
               "/v2/orders", "slicing")


def test_algo_cannot_reach_a_real_order_endpoint():
    for name in ALGO_MODULES:
        src = open(os.path.join(HERE, name), encoding="utf-8").read()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                mods = [(node.module or "").split(".")[0]]
            else:
                continue
            assert set(mods) <= ALLOWED_IMPORTS, f"{name} imports {mods}"
            if isinstance(node, ast.ImportFrom) and node.module == "dhan_client":
                assert {a.name for a in node.names} <= {"SCRIP"}, f"{name} imports {[a.name for a in node.names]} from dhan_client"
        low = src.lower().replace("broker.buy(", "").replace("engine.place_order(", "")
        for w in ORDER_WORDS:
            assert w not in low, f"{name} mentions {w!r}"
    # the only Dhan module the algo touches has no order endpoint at all
    dhan = open(os.path.join(HERE, "dhan_client.py"), encoding="utf-8").read().lower()
    assert "/orders" not in dhan and "forever" not in dhan and "super/" not in dhan
    # orders go to the paper engine: the broker's engine is a PaperEngine
    from algo_service import AlgoBroker
    from paper_engine import PaperEngine
    assert "PaperEngine(" in open(os.path.join(HERE, "algo_service.py"), encoding="utf-8").read()
    assert AlgoBroker.buy.__code__.co_names.count("engine") >= 1 and PaperEngine.place_order


def test_api_routes_and_kill_switch(env):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import algo_api
    algo, paper, clock, *_ = env
    breakout_entry(algo, paper, clock)
    app = FastAPI()
    algo_api.register(app, algo)
    c = TestClient(app)
    assert c.get("/api/algo/status").json()["indices"][0]["state"] == "in trade"
    ev = c.get("/api/algo/events").json()["rows"]
    assert ev[0]["at"] >= ev[-1]["at"]  # newest first
    assert c.get("/api/algo/events?date=23-10-2026").status_code == 400
    r = c.post("/api/algo/stop-exit-all").json()
    assert r["indices"][0]["state"] == "stopped" and r["indices"][0]["open"] is None
    assert c.post("/api/algo/resume").json()["indices"][0]["stopped"] is False


def test_create_app_wires_the_algo_only_when_asked():
    from main import create_app
    from test_api import FakeClient
    from tracker import Tracker
    tmp = tempfile.mkdtemp()
    try:
        clock = Clock()
        paper = PaperService(PaperJsonStore(tmp), FakeFeed(), Instruments(), clock=clock)
        tr = Tracker(FakeClient(), data_dir=tmp, clock=clock)
        assert not any(r.path == "/api/algo/status" for r in create_app(tr, paper=paper).routes)
        app = create_app(tr, paper=paper, algo_mode="signals")
        assert any(r.path == "/api/algo/status" for r in app.routes) and app.state.algo.mode == "signals"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
