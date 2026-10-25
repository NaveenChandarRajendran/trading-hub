"""OI breakout algo rules (algo_logic.py) on synthetic 5-minute candles. NIFTY, buffer 10."""
from datetime import datetime

import algo_config as cfg
from algo_logic import entry_block, lock_levels, new_state, note_result, on_tick, round_trip_charges
from algo_logic import on_candle as _on_candle
from store import IST

LEVELS = {"R1": 22800.0, "R2": 23000.0, "R3": 23100.0, "S1": 22600.0, "S2": 22500.0, "S3": 22200.0}
GOOD_CE = {"toi": {"sentiment": "Bullish", "strength": 52.0}, "oiChange": {"verdict": "BULLISH", "points": 30.0},
           "components": {"verdict": "Neutral", "indexMove": 0.02, "priced": 50, "total": 50}, "rsi": 61.0}
GOOD_PE = {"toi": {"sentiment": "Bearish", "strength": -48.0}, "oiChange": {"verdict": "BEARISH", "points": -25.0},
           "components": {"verdict": "Bearish", "indexMove": -0.3, "priced": 50, "total": 50}, "rsi": 38.0}


def on_candle(*a, **k):
    """These tests describe variant A (the 23-Oct rules); the live default is B since 25-Oct."""
    return _on_candle(*a, variant=k.pop("variant", "A"), **k)


def at(hm):
    return datetime.fromisoformat(f"2026-10-23T{hm}:00").replace(tzinfo=IST)


def cnd(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


def state(levels=LEVELS):
    s = new_state("NIFTY", "2026-10-23")
    lock_levels(s, levels, at("09:30"))
    return s


def kinds(actions):
    return [a.get("kind", a["type"]) for a in actions]


def test_levels_locked_once_with_a_log_line():
    s = new_state("NIFTY", "2026-10-23")
    ev = lock_levels(s, LEVELS, at("09:30"))
    assert s["levels"] == LEVELS and s["levelsAt"] == "09:30"
    assert ev[0]["message"].startswith("Levels locked at 09:30: R1 22,800")


def test_breakout_then_pullback_enters_ce_with_target_r2_zone_and_spot_stop():
    s = state()
    a = on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), GOOD_CE)
    assert kinds(a) == ["armed"] and s["setup"]["side"] == "CE"
    assert on_candle(s, cnd(22815, 22840, 22812, 22835), at("10:05"), GOOD_CE) == []  # no pullback yet
    a = on_candle(s, cnd(22835, 22836, 22806, 22821), at("10:10"), GOOD_CE)
    assert kinds(a) == ["enter"]
    e = a[0]
    assert (e["side"], e["setup"], e["data"]["target"], e["data"]["spotStop"]) == ("CE", "Breakout CE", 22990.0, "close below 22,790")
    assert "break 10:00 candle" in e["reason"] and "pullback 10:10 candle" in e["reason"] and "RSI OK: 61.0" in e["reason"]
    assert s["trades"] == 1 and s["open"]["entryAt"] == "10:10" and s["setup"] is None


def test_failed_breakout_is_cancelled_and_needs_a_close_back_below_r1_to_arm_again():
    s = state()
    on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), GOOD_CE)
    a = on_candle(s, cnd(22815, 22816, 22780, 22785), at("10:05"), GOOD_CE)
    assert kinds(a) == ["cancel"] and s["setup"] is None and s["armed"]["CE"] is True  # closed back below R1: re-armed
    assert kinds(on_candle(s, cnd(22785, 22830, 22784, 22825), at("10:10"), GOOD_CE)) == ["armed"]


def test_breakout_expires_without_a_pullback_and_does_not_rearm_while_above_r1():
    s = state()
    on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), GOOD_CE)
    acts = [on_candle(s, cnd(22850 + i, 22870 + i, 22845 + i, 22860 + i), at(f"10:{5 + 5 * i:02d}"), GOOD_CE) for i in range(6)]
    assert kinds(acts[-1]) == ["expire"] and all(a == [] for a in acts[:-1])
    assert on_candle(s, cnd(22860, 22880, 22850, 22870), at("10:40"), GOOD_CE) == []  # still above R1: no new break


def test_filter_failure_logs_every_reason_and_does_not_arm():
    s = state()
    f = {**GOOD_CE, "rsi": 84.2, "toi": {"sentiment": "Bullish", "strength": 31.0}}
    a = on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), f)
    assert kinds(a) == ["skip"] and s["setup"] is None
    m = a[0]["message"]
    assert "Breakout CE filters failed" in m and "RSI FAIL: 84.2 (need 50-80)" in m and "Trending OI FAIL: Bullish 31.0%" in m
    assert "OI change OK" in m and "Components OK" in m


def test_missing_filter_data_fails_the_check():
    s = state()
    a = on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), {**GOOD_CE, "components": None, "rsi": None})
    assert "Components FAIL: no data" in a[0]["message"] and "RSI FAIL: no data" in a[0]["message"]


def test_breakdown_pe_mirrors_at_s1_and_targets_s2_zone():
    s = state()
    assert kinds(on_candle(s, cnd(22610, 22612, 22585, 22588), at("11:00"), GOOD_PE)) == ["armed"]
    a = on_candle(s, cnd(22588, 22595, 22570, 22580), at("11:05"), GOOD_PE)
    assert kinds(a) == ["enter"] and a[0]["side"] == "PE" and a[0]["data"]["target"] == 22510.0
    assert a[0]["data"]["spotStop"] == "close above 22,610"


def test_range_rejection_at_r1_buys_pe_targeting_s1_zone():
    s = state()
    a = on_candle(s, cnd(22780, 22805, 22775, 22790), at("10:30"), GOOD_PE)
    assert kinds(a) == ["enter"]
    assert (a[0]["side"], a[0]["setup"], a[0]["data"]["target"], a[0]["data"]["spotStop"]) == (
        "PE", "Range PE (R1 rejection)", 22610.0, "close above 22,810")
    # bounce at S1 mirrors
    s = state()
    a = on_candle(s, cnd(22620, 22625, 22595, 22612), at("10:30"), GOOD_PE | {"toi": None})
    assert a[0]["side"] == "CE" and a[0]["data"]["target"] == 22790.0


def test_narrow_range_is_blocked():
    s = state({**LEVELS, "R1": 22680.0})  # R1 - S1 = 80 < 100
    a = on_candle(s, cnd(22660, 22685, 22655, 22670), at("10:30"), GOOD_CE)
    assert kinds(a) == ["skip"] and "R1 - S1 = 80 < 100" in a[0]["message"] and s["open"] is None


def test_range_blocked_by_trending_oi_against_it_and_waits_for_a_fresh_touch():
    s = state()
    a = on_candle(s, cnd(22780, 22805, 22775, 22790), at("10:30"), {**GOOD_CE, "toi": {"sentiment": "Bullish", "strength": 45.0}})
    assert kinds(a) == ["skip"] and "Trending OI Bullish 45.0% >= 40% against it" in a[0]["message"]
    assert on_candle(s, cnd(22790, 22802, 22780, 22795), at("10:35"), GOOD_PE) == []  # same touch: not re-armed
    on_candle(s, cnd(22795, 22798, 22770, 22780), at("10:40"), GOOD_PE)  # high below R1: re-armed
    assert kinds(on_candle(s, cnd(22780, 22801, 22775, 22785), at("10:45"), GOOD_PE)) == ["enter"]


def test_range_waits_while_a_breakout_setup_is_open():
    s = state()
    on_candle(s, cnd(22610, 22612, 22585, 22588), at("11:00"), GOOD_PE)  # breakdown armed
    a = on_candle(s, cnd(22588, 22620, 22580, 22615), at("11:05"), GOOD_PE)  # back above S1, not a pullback entry
    assert "enter" not in kinds(a)


def test_exits_target_zone_premium_stop_and_spot_stop():
    s = state()
    on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), GOOD_CE)
    on_candle(s, cnd(22815, 22830, 22805, 22820), at("10:05"), GOOD_CE)
    s["open"]["entryPrice"] = 100.0
    assert on_tick(s, 22985, 119) is None
    x = on_tick(s, 22990, 115)
    assert x["type"] == "exit" and x["reason"].startswith("Target zone reached: spot 22,990 >= 22,990")
    assert on_tick(s, 22995, 116) is None  # exiting already: one exit only

    s["open"].pop("exiting")
    assert on_tick(s, 22900, 119.95) is None
    assert on_tick(s, 22900, 120.0)["reason"] == "Premium target: LTP 120 >= entry 100 + 20%"  # before the level zone

    s["open"].pop("exiting")
    assert on_tick(s, 22850, 90.5) is None
    assert on_tick(s, 22850, 90.0)["reason"] == "Premium stop: LTP 90 <= entry 100 - 10%"

    s["open"].pop("exiting")
    a = on_candle(s, cnd(22800, 22801, 22780, 22785), at("10:30"), GOOD_CE)
    assert a[0]["type"] == "exit" and "Spot stop: 10:30 candle" in a[0]["reason"] and "closed below 22,790" in a[0]["reason"]


def test_risk_limits_block_entries_with_a_reason():
    s = state()
    s["trades"] = cfg.MAX_TRADES_PER_INDEX
    a = on_candle(s, cnd(22780, 22805, 22775, 22790), at("10:30"), GOOD_PE)
    assert kinds(a) == ["skip"] and "max 2 trades for NIFTY today" in a[0]["message"]
    s = state()
    a = on_candle(s, cnd(22780, 22805, 22775, 22790), at("14:35"), GOOD_PE)
    assert "outside the entry window 09:35-14:30" in a[0]["message"]
    s = state()
    a = on_candle(s, cnd(22780, 22805, 22775, 22790), at("10:30"), GOOD_PE, block="day loss limit reached")
    assert "day loss limit reached" in a[0]["message"] and s["trades"] == 0
    s = state()
    a = on_candle(s, cnd(22780, 22805, 22775, 22790), at("09:30"), GOOD_PE)
    assert "outside the entry window" in a[0]["message"]  # the 09:25-09:30 candle: before 09:35


def test_premium_target_uses_the_minute_high_in_a_replay():
    s = state()
    on_candle(s, cnd(22790, 22818, 22788, 22815), at("10:00"), GOOD_CE)
    on_candle(s, cnd(22815, 22830, 22805, 22820), at("10:05"), GOOD_CE)
    s["open"]["entryPrice"] = 100.0
    assert on_tick(s, 22850, 101, 119)is None
    assert on_tick(s, 22850, 101, 121)["reason"] == "Premium target: LTP 121 >= entry 100 + 20%"


def test_two_trades_a_day_and_a_win_ends_the_day():
    """Rule (2026-10-25): stop 10 %, target 20 %, max 2 trades per index; trade 1 in profit -> done for the day;
    trade 1 in loss -> trade 2, then done whatever its result. Profit = P&L after charges above 0."""
    s = state()
    now = at("10:30")
    assert entry_block(s, now) == ""
    s["trades"] = 1
    assert note_result(s, -650.0, 60.0) == -710.0  # trade 1: loss
    assert entry_block(s, now) == ""  # trade 2 allowed
    s["trades"] = 2
    assert note_result(s, 300.0, 60.0) == 240.0  # trade 2: profit, but the cap is reached anyway
    assert entry_block(s, now) == "a trade closed in profit: done for NIFTY today"

    s = state()
    s["trades"] = 1
    note_result(s, 1300.0, 60.0)  # trade 1: profit
    assert entry_block(s, now) == "a trade closed in profit: done for NIFTY today"

    s = state()
    s["trades"] = 1
    assert note_result(s, 40.0, 60.0) == -20.0  # gross +40 but -20 after charges: a loss, trade 2 allowed
    assert entry_block(s, now) == ""
    assert note_result(s, None, None) is None and not s["won"]  # unknown P&L: not a win
    s["trades"] = 2
    assert entry_block(s, now) == "max 2 trades for NIFTY today"


def test_round_trip_charges_match_the_paper_engine():
    # 65 units bought at 100 and sold at 120: the paper engine's BUY + SELL order charges (2 x Rs 20 brokerage + taxes)
    from paper_charges import order_charges
    assert round_trip_charges(100.0, 120.0, 65) == round(order_charges("BUY", 6500).total + order_charges("SELL", 7800).total, 2) == 65.03
