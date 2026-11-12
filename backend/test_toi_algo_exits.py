"""toi_algo_logic.py, step 3: adds (averaging up to 6 lots, pyramiding up to 4, the 6-lot cap, the ₹10,000 risk guard,
adds blocked when Trending OI no longer supports or after a partial), partial exits at the locked levels 20+ points
beyond the entry, breakeven, the 1R breakeven without levels, the Supertrend trail and the 15:15 square-off."""
import toi_algo_logic as L
from test_toi_algo_logic import BEAR, BULL, DAY, S, at, ctx, kinds, rows

LEVELS = {"R1": 23300.0, "R2": 23400.0, "R3": 23500.0, "S1": 23100.0, "S2": 23000.0, "S3": 22900.0}


def opened(day_low=23180.0, levels=LEVELS, avg=112.4, entry_close=23235):
    """A CE trade of 2 lots entered at index 23,235 (stop below the day low), filled at `avg`."""
    st = L.new_state(DAY)
    st["levels"] = dict(levels) if levels else None
    out = L.on_candle(st, ctx(day_low=day_low, candle={"open": 23230, "high": 23240, "low": 23215, "close": entry_close}), S)
    assert out[-1]["do"] == "enter", out
    L.on_filled(st, 23200.0, 70001, avg)
    return st


def candle_ctx(hm, low, close, high=None, st=23200.0, vwap=23210.0, ltp=105.0, delta=0.5, toi=BULL, **kw):
    c = ctx(hm, candle={"open": close, "high": high if high is not None else close + 5, "low": low, "close": close},
            st=st, vwap=vwap, toi=toi, **kw)
    return {**c, "optionLtp": ltp, "delta": delta, "lotSize": 65}


def add(st, c):
    """A candle; when it asks for an add, fill it at the candle's option price."""
    out = L.on_candle(st, c, S)
    if out and out[-1].get("do") == "add":
        L.on_add_filled(st, out[-1]["lots"], c["optionLtp"])
    return out


# ---------------------------------------------------------------- averaging / pyramiding / caps
def test_averaging_adds_2_lots_up_to_6():
    st = opened()
    # against me (close 23,225 < entry 23,235), the pullback to Supertrend / VWAP holds: +2 -> 4 lots
    out = add(st, candle_ctx("10:05", low=23205, close=23225, ltp=105.0))
    assert kinds(out)[-2:] == ["add", "do:add"] and "(averaging) -> 4 lots; stop stays below 23,180" in out[-2]["message"]
    assert st["open"]["lots"] == 4 and st["open"]["avg"] == 108.7 and st["open"]["adds"] == {"avg": 1, "pyr": 0}
    out = add(st, candle_ctx("10:10", low=23205, close=23220, ltp=102.0))
    assert st["open"]["lots"] == 6  # risk 9,543: within ₹10,000
    out = add(st, candle_ctx("10:15", low=23205, close=23220, ltp=100.0))
    assert "6 lots open + 2 would pass the 6-lot averaging cap" in out[-1]["message"] and st["open"]["lots"] == 6
    assert st["open"]["stop"] == {"dir": "below", "price": 23180.0}  # adds never move the stop


def test_the_risk_guard_blocks_an_add():
    st = opened(day_low=23150.0)  # 85-point stop
    # 4 lots if added at 105: average 108.7, option at the stop ~ 105 - 0.55 x 75 = 63.75 -> loss 11,687 > 10,000
    out = add(st, candle_ctx("10:05", low=23205, close=23225, ltp=105.0, delta=0.55))
    assert out[-1]["kind"] == "skip" and "risk guard: loss if the stop hits now would be 11,687 (> 10,000)" in out[-1]["message"]
    assert st["open"]["lots"] == 2
    assert round(L.loss_at_stop(st["open"], 105.0, 0.55, 23225.0, 2, 65)) == 11687


def test_pyramiding_after_a_new_swing_high_up_to_4_lots():
    st = opened()
    assert add(st, candle_ctx("10:05", low=23260, close=23275, high=23280, st=23240, vwap=23230)) == []  # new high, no pullback
    # the next pullback to Supertrend that holds, in favour: +1 -> 3 lots
    out = add(st, candle_ctx("10:10", low=23245, close=23260, st=23240, vwap=23230, ltp=130.0, delta=0.55))
    assert "(pyramiding) -> 3 lots" in out[-2]["message"] and st["open"]["adds"] == {"avg": 0, "pyr": 1}
    # another hold without a new swing high since: nothing
    assert add(st, candle_ctx("10:15", low=23245, close=23262, high=23270, st=23240, vwap=23230, ltp=131.0)) == []
    add(st, candle_ctx("10:20", low=23290, close=23300, high=23310, st=23260, vwap=23240))  # new swing high 23,310
    out = add(st, candle_ctx("10:25", low=23265, close=23280, high=23290, st=23260, vwap=23240, ltp=135.0, delta=0.45))
    assert st["open"]["lots"] == 4
    add(st, candle_ctx("10:30", low=23320, close=23330, high=23340, st=23290, vwap=23260))
    out = add(st, candle_ctx("10:35", low=23295, close=23310, high=23320, st=23290, vwap=23260, ltp=140.0))
    assert "4 lots open + 1 would pass the 4-lot pyramiding cap" in out[-1]["message"]


def test_no_add_when_trending_oi_no_longer_supports():
    st = opened()
    turned = rows(("09:20", "Bullish", 50), ("10:00", "Bearish", -45))
    out = add(st, candle_ctx("10:05", low=23205, close=23225, toi=turned))
    assert "no add: Trending OI no longer supports CE" in out[-1]["message"] and st["open"]["lots"] == 2


def test_no_add_after_a_partial_exit():
    st = opened()
    L.on_tick(st, 23300.0, at("10:20"), S)  # R1: partial
    L.on_partial_filled(st, 1, 150.0, 2449.0)
    out = add(st, candle_ctx("10:25", low=23205, close=23225))
    assert out[-1]["message"].endswith("no add: no adds after a partial exit")


# ---------------------------------------------------------------- partial exits, breakeven, trail
def test_targets_skip_levels_less_than_20_points_beyond_the_entry():
    assert L.partial_targets(LEVELS, "CE", 23235.0, 20) == [("R1", 23300.0), ("R2", 23400.0)]
    assert L.partial_targets(LEVELS, "CE", 23285.0, 20) == [("R2", 23400.0), ("R3", 23500.0)]  # R1 only 15 away
    assert L.partial_targets(LEVELS, "PE", 23115.0, 20) == [("S2", 23000.0), ("S3", 22900.0)]  # S1 only 15 away
    assert L.partial_targets(LEVELS, "CE", 23490.0, 20) == []
    assert L.partial_targets(None, "CE", 23235.0, 20) == []


def test_half_at_r1_then_half_the_rest_at_r2_then_breakeven_and_the_trail():
    st = opened()
    st["open"]["lots"] = 4  # as if averaged
    out = L.on_tick(st, 23300.0, at("10:30"), S, option_ltp=150.0)
    assert kinds(out) == ["partial", "do:partial"] and out[-1]["lots"] == 2 and "breakeven" in out[0]["message"]
    assert L.on_tick(st, 23305.0, at("10:30"), S) == []  # pending: not twice
    L.on_partial_filled(st, 2, 150.0, 4901.0)
    o = st["open"]
    assert (o["lots"], o["breakeven"], o["trailing"], o["partials"]) == (2, True, True, 1)
    out = L.on_tick(st, 23400.0, at("11:00"), S, option_ltp=200.0)
    assert out[-1]["do"] == "partial" and out[-1]["lots"] == 1 and out[-1]["level"] == "R2"
    L.on_partial_filled(st, 1, 200.0, 5694.0)
    # the last lot trails Supertrend: a 5-minute close below it exits
    out = L.on_candle(st, candle_ctx("11:30", low=23340, close=23345, st=23350, vwap=23300), S)
    assert kinds(out)[-2:] == ["exit", "do:exit"] and out[-1]["reason"] == "Supertrend trail" and out[-1]["lots"] == 1


def test_breakeven_exits_the_rest_when_the_option_falls_back_to_the_average():
    st = opened()
    L.on_tick(st, 23300.0, at("10:30"), S)
    L.on_partial_filled(st, 1, 150.0, 2449.0)
    assert L.on_tick(st, 23270.0, at("10:40"), S, option_ltp=112.45) == []
    out = L.on_tick(st, 23260.0, at("10:45"), S, option_ltp=112.4)
    assert out[-1]["reason"] == "breakeven" and out[-1]["lots"] == 1


def test_a_last_lot_partial_is_a_full_exit():
    st = opened()
    L.on_tick(st, 23300.0, at("10:30"), S)
    L.on_partial_filled(st, 1, 150.0, 2449.0)
    out = L.on_tick(st, 23400.0, at("11:00"), S, option_ltp=200.0)
    assert out[-1]["do"] == "exit" and out[-1]["reason"] == "R2 partial" and out[-1]["lots"] == 1


def test_no_levels_beyond_the_entry_breakeven_at_1r_then_the_trail():
    st = opened(levels=None)  # risk = 23,235 - 23,180 = 55 points
    assert st["open"]["targets"] == []
    assert L.on_tick(st, 23289.0, at("10:30"), S) == []
    out = L.on_tick(st, 23290.0, at("10:31"), S)
    assert kinds(out) == ["stopMove"] and "1R in favour" in out[0]["message"]
    assert st["open"]["breakeven"] and st["open"]["trailing"]
    out = L.on_candle(st, candle_ctx("10:40", low=23250, close=23255, st=23260, vwap=23230), S)
    assert out[-1]["reason"] == "Supertrend trail"


def test_square_off_at_1515_and_the_stop_loss_exit_everything():
    st = opened()
    st["open"]["lots"] = 6
    out = L.on_tick(st, 23250.0, at("15:15"), S)
    assert out[-1]["reason"] == "square-off" and out[-1]["lots"] == 6
    st = opened()
    out = L.on_tick(st, 23179.95, at("10:30"), S)
    assert out[-1]["reason"] == "stop loss" and st["stopped"] == ["CE"]


def test_pe_partial_targets_and_breakeven_mirror():
    st = L.new_state(DAY)
    st["levels"] = dict(LEVELS)
    pull = {"open": 23190, "high": 23205, "low": 23180, "close": 23185}
    out = L.on_candle(st, ctx(candle=pull, st=23200.0, st_up=False, vwap=23210.0, toi=BEAR, day_high=23240.0), S)
    assert out[-1]["side"] == "PE" and st["open"]["targets"] == [("S1", 23100.0), ("S2", 23000.0)]
    L.on_filled(st, 23250.0, 70002, 140.0)
    out = L.on_tick(st, 23100.0, at("10:30"), S)
    assert out[-1]["do"] == "partial" and out[-1]["level"] == "S1"
