"""toi_algo_logic.py, step 2: direction (rule 1), the no-trade filters (rule 2), the pullback entry (rule 3), the
strike (rule 4), the stop loss at the day low / high and its 0.6 % skip (rules 5-6), the daily entry limits."""
from datetime import datetime

import pytest

import toi_algo_logic as L
from store import IST
from trending_oi_algo_config import merged

S = merged()
DAY = "2026-11-12"


def at(hm):
    return datetime.fromisoformat(f"{DAY}T{hm}:00").replace(tzinfo=IST)


def rows(*spec):
    """spec: ("HH:MM", sentiment, strength %)."""
    return [{"ts": f"{DAY} {t}", "sentiment": snt, "strengthPct": pct} for t, snt, pct in spec]


BULL = rows(("09:20", "Bullish", 30), ("09:25", "Bullish", 45), ("09:30", "Bullish", 64))
BEAR = rows(("09:20", "Bearish", -50), ("09:30", "Bearish", -64))


def ctx(hm="10:00", candle=None, st=23200.0, st_up=True, vwap=23210.0, rsi=60.0, toi=BULL, day_low=23150.0,
        day_high=23300.0, day_pnl=0.0, stale=False):
    candle = candle or {"open": 23230, "high": 23240, "low": 23215, "close": 23235}
    return {"now": at(hm), "candle": candle, "spot": candle["close"], "st": {"value": st, "up": st_up}, "vwap": vwap,
            "rsi": rsi, "rows": toi, "dayLow": day_low, "dayHigh": day_high, "dayPnl": day_pnl, "capital": 500000.0,
            "stale": stale}


def kinds(out):
    return [o["kind"] if o["type"] == "event" else "do:" + o["do"] for o in out]


# ---------------------------------------------------------------- rule 1 / 2
def test_direction_needs_strength_dots_and_no_recent_flip():
    assert L.direction(BULL, at("10:00"), S)["side"] == "CE"
    assert L.direction(BEAR, at("10:00"), S)["side"] == "PE"
    weak = L.direction(rows(("09:30", "Bullish", 35)), at("10:00"), S)
    assert weak["side"] is None and weak["dots"] == 1 and weak["reason"].startswith("unclear: Trending OI Bullish 35.0%")
    assert L.direction(rows(("09:30", "Bullish", 40)), at("10:00"), S)["side"] == "CE"  # 40 % = 2 dots: enough
    flip = rows(("09:25", "Bearish", -45), ("09:40", "Bullish", 55))
    assert "turned Bullish at 09:40" in L.direction(flip, at("10:05"), S)["reason"]  # 25 min ago
    assert L.direction(flip, at("10:10"), S)["side"] == "CE"  # 30 min after the flip: clear
    assert L.direction([], at("10:00"), S)["reason"] == "no Trending OI data yet"


def test_weak_day_only_from_1030():
    narrow = dict(day_low=23200.0, day_high=23280.0)  # 80 pts = 0.34 % of spot
    assert L.no_trade_reasons("CE", ctx("10:25", **narrow), S) == []
    r = L.no_trade_reasons("CE", ctx("10:30", **narrow), S)
    assert len(r) == 1 and r[0].startswith("weak day: range 80 pts = 0.34% of spot")


def test_over_extended_by_vwap_and_rsi():
    far = ctx(vwap=23000.0)  # 235 pts = 1.01 % from VWAP
    assert L.no_trade_reasons("CE", far, S)[0].startswith("over-extended: 1.01% from VWAP")
    assert L.no_trade_reasons("CE", ctx(rsi=81), S) == ["over-extended: RSI 81.0 > 80 for CE"]
    assert L.no_trade_reasons("PE", ctx(rsi=19), S) == ["over-extended: RSI 19.0 < 20 for PE"]
    assert L.no_trade_reasons("PE", ctx(rsi=81), S) == []  # a high RSI only blocks CE
    assert L.no_trade_reasons("CE", ctx(vwap=None), S) == ["indicators not ready (Supertrend / VWAP / RSI)"]


def test_the_no_trade_reason_is_logged_when_it_changes():
    st = L.new_state(DAY)
    weak = rows(("09:30", "Bullish", 30))
    far = {"open": 23270, "high": 23280, "low": 23260, "close": 23270}  # no pullback (50 pts above VWAP)
    assert kinds(L.on_candle(st, ctx(toi=weak, candle=far), S)) == ["noTrade"]
    assert kinds(L.on_candle(st, ctx(toi=weak, candle=far), S)) == []  # same reason: not logged again
    assert kinds(L.on_candle(st, ctx(candle=far), S)) == ["clear"]
    assert st["direction"]["side"] == "CE" and st["direction"]["dots"] == 3


# ---------------------------------------------------------------- rule 3: the pullback that holds
def test_ce_pullback_to_supertrend_or_vwap_that_closes_above_both():
    assert L.holds("CE", {"low": 23209, "close": 23235}, {"value": 23200}, 23210, 10) == (True, "Supertrend / VWAP")
    assert L.holds("CE", {"low": 23219, "close": 23235}, {"value": 23200}, 23210, 10) == (True, "VWAP")  # 9 pts off VWAP
    assert L.holds("CE", {"low": 23221, "close": 23235}, {"value": 23200}, 23210, 10)[0] is False  # 11 pts: not near
    assert L.holds("CE", {"low": 23190, "close": 23205}, {"value": 23200}, 23210, 10)[0] is False  # closed below VWAP
    assert L.holds("PE", {"high": 23195, "close": 23180}, {"value": 23200}, 23210, 10) == (True, "Supertrend")


def test_entry_on_the_first_hold_with_the_stop_at_the_day_low():
    st = L.new_state(DAY)
    out = L.on_candle(st, ctx(), S)
    assert kinds(out) == ["clear", "entry", "do:enter"]
    enter = out[-1]
    assert (enter["side"], enter["lots"], enter["stop"]) == ("CE", 2, {"dir": "below", "price": 23150.0})
    assert st["trades"] == 1 and st["open"]["risk"] == 85.0  # 23,235 - 23,150
    assert kinds(L.on_candle(st, ctx("10:05"), S)) == []  # a trade is open: no second entry


def test_pe_mirrors_with_the_day_high():
    st = L.new_state(DAY)
    pull = {"open": 23190, "high": 23205, "low": 23180, "close": 23185}
    out = L.on_candle(st, ctx(candle=pull, st=23200.0, st_up=False, vwap=23210.0, toi=BEAR, day_high=23260.0), S)
    assert out[-1]["side"] == "PE" and out[-1]["stop"] == {"dir": "above", "price": 23260.0}


def test_skip_when_the_stop_is_more_than_0_6_pct_away():
    st = L.new_state(DAY)
    out = L.on_candle(st, ctx(day_low=23080.0), S)  # 155 pts = 0.67 %
    assert kinds(out)[-1] == "skip" and "0.67% away (> 0.6%)" in out[-1]["message"]
    assert st["open"] is None and st["trades"] == 0


# ---------------------------------------------------------------- daily limits
def test_entry_hours_trades_per_day_and_the_day_loss():
    for hm, why in (("09:40", "entries only 09:45-14:30"), ("14:35", "entries only 09:45-14:30")):
        out = L.on_candle(L.new_state(DAY), ctx(hm), S)
        assert why in out[-1]["message"]
    st = L.new_state(DAY)
    st["trades"] = 2
    assert "2 trades already today" in L.on_candle(st, ctx(), S)[-1]["message"]
    assert "reached -2% of capital" in L.on_candle(L.new_state(DAY), ctx(day_pnl=-10000.0), S)[-1]["message"]
    assert "live feed stale" in L.on_candle(L.new_state(DAY), ctx(stale=True), S)[-1]["message"]


def test_stop_loss_exits_all_and_blocks_that_direction_only():
    st = L.new_state(DAY)
    L.on_candle(st, ctx(), S)
    L.on_filled(st, 23200.0, 70001, 112.4)
    assert L.on_tick(st, 23151.0, at("10:07"), S) == []
    out = L.on_tick(st, 23149.95, at("10:08"), S)
    assert kinds(out) == ["exit", "do:exit"] and out[-1]["lots"] == 2 and out[-1]["reason"] == "stop loss"
    assert L.on_tick(st, 23140.0, at("10:08"), S) == []  # already exiting: one exit only
    L.on_exited(st, 23149.95, -4000.0, at("10:08"))
    assert st["open"] is None and st["stopped"] == ["CE"] and st["closed"][0]["pnl"] == -4000.0
    assert "the CE stop loss was hit today" in L.on_candle(st, ctx("10:30"), S)[-1]["message"]
    pull = {"open": 23190, "high": 23205, "low": 23180, "close": 23185}
    out = L.on_candle(st, ctx("10:35", candle=pull, st_up=False, toi=BEAR, day_high=23260.0, day_low=23100.0), S)
    assert out[-1]["do"] == "enter" and out[-1]["side"] == "PE"  # the other direction still trades


def test_after_an_exit_the_next_hold_is_a_new_entry():
    st = L.new_state(DAY)
    L.on_candle(st, ctx(), S)
    L.on_filled(st, 23200.0, 70001, 112.4)
    L.on_exited(st, 23300.0, 6500.0, at("11:00"))
    assert L.on_candle(st, ctx("11:10"), S)[-1]["do"] == "enter" and st["trades"] == 2


def test_a_failed_fill_undoes_the_entry():
    st = L.new_state(DAY)
    L.on_candle(st, ctx(), S)
    out = L.on_entry_failed(st, "no liquid strike")
    assert st["open"] is None and st["trades"] == 0 and out[0]["message"] == "Entry not placed: no liquid strike"


# ---------------------------------------------------------------- rule 4: the strike
STRIKES = [23100.0, 23150.0, 23200.0, 23250.0, 23300.0, 23350.0]


def test_one_in_the_money_strike():
    assert L.strike_ladder(STRIKES, 23235.0, "CE") == [("1ITM", 23200.0), ("ATM", 23250.0), ("2ITM", 23150.0)]
    assert L.strike_ladder(STRIKES, 23235.0, "PE") == [("1ITM", 23300.0), ("ATM", 23250.0), ("2ITM", 23350.0)]


@pytest.mark.parametrize("dead, want", [
    (set(), ("1ITM", 23200.0, "")),
    ({23200.0}, ("ATM", 23250.0, "1 ITM not liquid (23,200 CE no trades today): using ATM 23,250 CE")),
    ({23200.0, 23250.0}, ("2ITM", 23150.0, None)),
])
def test_an_illiquid_1_itm_falls_back_to_atm_then_2_itm(dead, want):
    label, k, note = L.choose_strike(STRIKES, 23235.0, "CE", lambda s: "no trades today" if s in dead else "")
    assert (label, k) == want[:2]
    if want[2] is not None:
        assert note == want[2]


def test_no_liquid_strike_at_all():
    label, k, note = L.choose_strike(STRIKES, 23235.0, "CE", lambda s: "untraded")
    assert (label, k) == (None, None) and note.startswith("no liquid strike: 23,200 CE untraded; 23,250 CE untraded")
