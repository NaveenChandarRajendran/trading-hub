"""Broken levels and setup priority (algo_logic.py, 27-Oct-2026): a broken S1 gives no Range CE, a broken R1 no Range
PE, at most one range trade per level, one setup per level; plus the replay-only options (stop buffer, Trending OI with
the range trade, arming on the stop-out candle). Synthetic NIFTY candles, buffer 10."""
from datetime import datetime

import pytest

import algo_config as cfg
from algo_logic import active_sides, lock_levels, new_state, on_candle
from store import IST

LEVELS = {"R1": 22800.0, "R2": 23000.0, "R3": 23200.0, "S1": 22700.0, "S2": 22600.0, "S3": 22500.0}


def at(hm):
    return datetime.fromisoformat(f"2026-10-27T{hm}:00").replace(tzinfo=IST)


def state():
    s = new_state("NIFTY", "2026-10-27")
    lock_levels(s, LEVELS, at("09:30"))
    return s


def f(rsi=45.0, toi=None):
    return {"oiChecked": False, "toi": None, "oiChange": None, "components": None, "rsi": rsi} | (
        {"oiChecked": None, "toi": toi} if toi else {})


def step(s, hm, o, h, l, c, variant="B", filters=None):
    """One candle; carries out an exit like the runner (the open trade closes at the candle's close)."""
    out = on_candle(s, {"open": o, "high": h, "low": l, "close": c}, at(hm), filters or f(), variant=variant)
    if any(a["type"] == "exit" for a in out):
        s["open"] = None
    assert all(len(sides) == 1 for sides in active_sides(s).values()), active_sides(s)
    return out


def texts(out, kind):
    return [a["message"] for a in out if a.get("kind") == kind]


def test_a_close_beyond_the_buffer_breaks_a_level_and_a_close_back_beyond_it_reclaims_it():
    s = state()
    out = step(s, "09:35", 22710, 22712, 22685, 22695, "A")  # below S1 but not by the buffer
    assert s["broken"] == {} and not texts(out, "level")
    out = step(s, "09:40", 22695, 22698, 22680, 22689, "A")
    assert s["broken"] == {"S1": {"dir": "below", "at": "09:40"}}
    assert texts(out, "level") == ["S1 22,700 broken: 09:40 candle O 22,695 H 22,698 L 22,680 C 22,689 closed below S1 "
                                   "- 10. No Range CE at S1 until a close back above 22,710"]
    out = step(s, "09:45", 22689, 22712, 22688, 22709, "A")  # back above S1, not by the buffer: still broken
    assert "S1" in s["broken"] and not texts(out, "level")
    out = step(s, "09:50", 22709, 22720, 22705, 22711, "A")
    assert s["broken"] == {} and texts(out, "level")[0].startswith("S1 22,700 reclaimed: 09:50 candle")


def test_27_oct_pattern_range_ce_at_a_broken_s1_is_blocked_and_one_range_trade_per_level():
    s = state()
    out = step(s, "09:35", 22720, 22725, 22695, 22710)  # trade 1: Range CE (S1 bounce)
    assert [a["setup"] for a in out if a["type"] == "enter"] == ["Range CE (S1 bounce)"]
    assert s["open"]["level"] == "S1" and s["rangeTaken"] == {"R1": 0, "S1": 1}
    out = step(s, "09:40", 22710, 22712, 22675, 22680)  # spot stop + S1 broken
    assert [a["type"] for a in out if a["type"] == "exit"] == ["exit"]
    assert "Breakdown PE break ignored (position open)" in texts(out, "skip")[0]
    step(s, "09:45", 22702, 22709, 22701, 22705)  # a candle above S1 (re-arms the touch), not reclaimed
    out = step(s, "09:50", 22705, 22708, 22698, 22704)  # retest from below: no CE bounce
    assert texts(out, "skip") == ["Range CE at S1 blocked: S1 broken at 09:40 (closed below S1 - 10), not reclaimed: a "
                                  "retest from below belongs to the Breakdown PE setup. 09:50 candle O 22,705 H 22,708 "
                                  "L 22,698 C 22,704: low 22,698 touched S1 22,700, closed back above"]
    assert s["open"] is None and s["trades"] == 1
    step(s, "09:55", 22704, 22716, 22703, 22715)  # reclaimed
    out = step(s, "10:00", 22715, 22718, 22699, 22705)
    assert texts(out, "skip") == ["Range CE at S1 blocked: 1 range trade at S1 already today (max 1 per level). 10:00 "
                                  "candle O 22,715 H 22,718 L 22,699 C 22,705: low 22,699 touched S1 22,700, closed back "
                                  "above"]


def test_range_pe_at_a_broken_r1_is_blocked():
    s = state()
    out = step(s, "09:35", 22790, 22818, 22788, 22815, "A", f(rsi=45))  # break above R1 + 10, CE filters fail (RSI)
    assert "Breakout CE filters failed" in texts(out, "skip")[0] and s["broken"]["R1"]["dir"] == "above"
    out = step(s, "09:40", 22815, 22816, 22792, 22795, "A")  # back below R1, not by the buffer
    assert texts(out, "skip")[0].startswith("Range PE at R1 blocked: R1 broken at 09:35 (closed above R1 + 10), not "
                                            "reclaimed: a retest from above belongs to the Breakout CE setup.")
    assert s["open"] is None


def test_variant_d_never_arms_a_pe_at_the_level_of_an_open_ce(monkeypatch):
    monkeypatch.setattr(cfg, "STOP_BUFFER", {**cfg.STOP_BUFFER, "NIFTY": 50})  # the CE survives a close below S1 - 10
    s = state()
    step(s, "09:35", 22720, 22725, 22695, 22710, "D")
    assert s["open"]["stop"] == {"dir": "below", "price": 22650.0}
    out = step(s, "09:40", 22710, 22712, 22675, 22680, "D")
    assert texts(out, "skip") == ["Breakdown PE break not armed: Range CE (S1 bounce) CE is open at S1 (one setup per "
                                  "level): 09:40 candle O 22,710 H 22,712 L 22,675 C 22,680 closed below S1 22,700 - 10"]
    assert s["setups"] == {} and active_sides(s) == {"S1": {"CE"}}


def test_stop_buffer_option_moves_only_the_spot_stop(monkeypatch):
    monkeypatch.setattr(cfg, "STOP_BUFFER", {**cfg.STOP_BUFFER, "NIFTY": 50})
    s = state()
    step(s, "09:35", 22720, 22725, 22695, 22710)
    out = step(s, "09:40", 22710, 22712, 22675, 22680)
    assert not [a for a in out if a["type"] == "exit"] and s["broken"]["S1"]["at"] == "09:40"  # break still at 10
    out = step(s, "09:45", 22680, 22684, 22640, 22645)
    assert [a["reason"] for a in out if a["type"] == "exit"][0].endswith("closed below 22,650")


def test_range_toi_option_needs_trending_oi_with_the_trade(monkeypatch):
    monkeypatch.setattr(cfg, "RANGE_TOI_WITH_MIN", 20.0)
    s = state()
    out = step(s, "09:35", 22720, 22725, 22695, 22710, filters=f(toi={"sentiment": "Bullish", "strength": 10.8}))
    assert texts(out, "skip") == ["Range CE (S1 bounce) blocked: Trending OI Bullish 10.8% (need Bullish >= 20%). 09:35 "
                                  "candle O 22,720 H 22,725 L 22,695 C 22,710: low 22,695 touched S1 22,700, closed "
                                  "back above"]
    step(s, "09:40", 22710, 22730, 22705, 22725)  # re-arms the touch
    out = step(s, "09:45", 22725, 22728, 22698, 22712, filters=f(toi={"sentiment": "Bullish", "strength": 25.0}))
    assert [a["setup"] for a in out if a["type"] == "enter"] == ["Range CE (S1 bounce)"]


@pytest.mark.parametrize("variant", ["A", "B", "C"])
def test_proposal_arm_on_stop_candle(monkeypatch, variant):
    s = state()
    step(s, "09:35", 22720, 22725, 22695, 22710, variant)
    out = step(s, "09:40", 22710, 22712, 22675, 22680, variant)
    assert "break ignored (position open)" in texts(out, "skip")[0]  # live rule
    monkeypatch.setattr(cfg, "ARM_ON_STOP_CANDLE", True)
    s = state()
    step(s, "09:35", 22720, 22725, 22695, 22710, variant)
    out = step(s, "09:40", 22710, 22712, 22675, 22680, variant)
    assert [a["type"] for a in out if a["type"] == "exit"] == ["exit"]
    assert texts(out, "armed")[0].startswith("Breakdown PE armed")


def test_a_retest_that_closes_on_the_wrong_side_is_logged():
    s = state()
    step(s, "09:35", 22720, 22722, 22676, 22680)  # Breakdown PE armed (B)
    out = step(s, "09:40", 22681, 22705, 22685, 22703)
    assert texts(out, "skip") == ["Breakdown PE retest at 09:40 not a pullback: high 22,705 came within 10 of S1 22,700 "
                                  "but closed 22,703 at or above it (a pullback closes below S1)"]
    assert "S1" in s["setups"]
