"""Live variant B + shadow variants A, C, D on the same candles (algo_service.py): only the live variant ever places a
paper order; each shadow logs its own signals / would-be entries and exits with its variant tag. And the "no room"
rule in every variant (algo_logic.py)."""
import os
import shutil
import tempfile

import pytest

from algo_logic import lock_levels, new_state, on_candle
from algo_service import AlgoService
from paper_api import PaperService
from store import PaperJsonStore
from test_algo_service import (DAY, GOOD_CE, Clock, Instruments, at, books, breakout_entry, ce, make_data, tick)
from test_algo_variants import LEVELS as V_LEVELS
from test_algo_variants import at as vat
from test_paper_api import FakeFeed


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock = Clock()
    clock.now = at("09:20")
    store = PaperJsonStore(tmp)
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    algo = AlgoService(store, paper, Instruments(), make_data(), clock, mode="paper", log_dir=os.path.join(tmp, "logs"),
                       variant="B", shadows=("A", "C", "D"))
    algo.filters = lambda sym, end, now, r=None: dict(GOOD_CE)
    yield algo, paper, clock, store
    shutil.rmtree(tmp, ignore_errors=True)


def test_shadows_never_place_orders_and_log_their_own_would_be_trades(env):
    algo, paper, clock, store = env
    buys = []
    real_buy = algo.broker.buy
    algo.broker.buy = lambda *a, **k: buys.append(a) or real_buy(*a, **k)
    breakout_entry(algo, paper, clock)  # 10:00 break, 10:05 pullback: every variant enters
    books(paper, clock, at("10:20"), {ce(22800): 190.0})
    tick(paper, clock, at("10:21"), 22991)  # R2 zone: every variant exits
    assert len(buys) == 1  # the live variant only
    orders = store.orders(algo.broker.account["id"], DAY)
    assert [(o["side"], o["variant"], o["source"]) for o in orders] == [("BUY", "B", "algo"), ("SELL", "B", "algo")]
    ev = store.algo_events(DAY)
    for v in ("A", "C", "D"):
        mine = [e for e in ev if e["variant"] == v and e["index"] == "NIFTY"]
        assert [e["type"] for e in mine if e["type"] in ("signal", "entry", "exit")] == ["signal", "entry", "exit"]
        entry = next(e for e in mine if e["type"] == "entry")
        assert entry["message"].startswith(f"SHADOW {v} would BUY NIFTY 27 OCT 22800 CALL @ 120")
        sh = algo.shadows[("NIFTY", v)]
        assert sh["closed"][0]["points"] == pytest.approx(22991 - 22821, abs=0.01) and sh["closed"][0]["pnl"] is None
    live = [e for e in ev if e["variant"] == "B" and e["type"] == "entry"]
    assert len(live) == 1 and live[0]["message"].startswith("BUY NIFTY 27 OCT 22800 CALL")
    states = store.algo_states(DAY)
    assert {k for k in states if k[0] == "NIFTY"} == {("NIFTY", v) for v in "ABCD"}
    assert states[("NIFTY", "B")]["live"] is True and states[("NIFTY", "A")]["live"] is False
    status = algo.status()
    assert status["meta"]["variant"] == "B" and status["meta"]["shadows"] == ["A", "C", "D"]
    assert [s["variant"] for s in status["indices"][0]["shadows"]] == ["A", "C", "D"]


def test_kill_switch_and_day_loss_never_turn_a_shadow_into_an_order(env):
    algo, paper, clock, store = env
    algo.broker.buy = lambda *a, **k: pytest.fail("no order may be placed")
    algo.stop()  # live stopped: no new entries; shadows keep logging signals
    breakout_entry(algo, paper, clock)
    assert store.orders(algo.broker.account["id"], DAY) == []
    assert any(e["variant"] == "A" and e["type"] == "entry" for e in store.algo_events(DAY))


# ---------------------------------------------------------------- "no room": every variant
def state():
    s = new_state("NIFTY", "2026-10-23")
    lock_levels(s, V_LEVELS, vat("09:30"))
    return s


def f(rsi):
    return {"oiChecked": False, "toi": None, "oiChange": None, "components": None, "rsi": rsi}


@pytest.mark.parametrize("variant", ["A", "B", "C", "D"])
def test_no_room_skips_a_breakdown_already_through_the_s2_zone(variant):
    s = state()  # S1 22,700, S2 22,600 (zone 22,610)
    on_candle(s, {"open": 22705, "high": 22708, "low": 22660, "close": 22680}, vat("10:00"), f(40), variant=variant)
    out = on_candle(s, {"open": 22680, "high": 22695, "low": 22560, "close": 22605}, vat("10:05"), f(40), variant=variant)
    assert not [a for a in out if a["type"] == "enter"]
    msg = [a["message"] for a in out if a.get("kind") == "skip"][0]
    assert "no room: spot 22,605 is already at or below the S2 target zone 22,610" in msg
    assert s["trades"] == 0


@pytest.mark.parametrize("variant", ["A", "B", "C", "D"])
def test_no_room_skips_a_range_entry_already_in_the_target_zone(variant):
    s = state()
    s["levels"] = {**V_LEVELS, "R1": 22800.0, "S1": 22790.0 - 100}  # R1 - S1 = 110 >= 100
    # R1 rejection -> PE targeting S1 + 10 = 22,700: a close at 22,695 is already there
    out = on_candle(s, {"open": 22780, "high": 22805, "low": 22694, "close": 22695}, vat("10:30"), f(40), variant=variant)
    assert not [a for a in out if a["type"] == "enter"]
    assert any("no room: spot 22,695 is already at or below the S1 target zone 22,700" in a.get("message", "") for a in out)


@pytest.mark.parametrize("variant", ["A", "B", "C", "D"])
def test_with_room_every_variant_still_enters(variant):
    s = state()
    on_candle(s, {"open": 22705, "high": 22708, "low": 22660, "close": 22680}, vat("10:00"), f(40), variant=variant)
    out = on_candle(s, {"open": 22680, "high": 22695, "low": 22650, "close": 22670}, vat("10:05"), f(40), variant=variant)
    assert [a["type"] for a in out if a["type"] == "enter"] == ["enter"]
