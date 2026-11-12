from datetime import datetime

from sig_gap import evaluate, gap_rule
from sig_indicators import IST


def _m(day, hh, mm, o, h, l, c):
    t = datetime(2026, 11, day, hh, mm, tzinfo=IST).timestamp()
    return {"time": t, "open": o, "high": h, "low": l, "close": c}


PREV = [_m(11, 9, 15, 60000, 60100, 59900, 60050), _m(11, 15, 29, 60050, 60200, 60000, 60000)]


def _state(first, now=datetime(2026, 11, 12, 9, 16, 30, tzinfo=IST)):
    ev = evaluate(PREV + [first], now)
    return {"symbol": "BANKNIFTY", "marketOpen": True, "positions": {}, "hm": (now.hour, now.minute), "gap": ev,
            "signalTime": "09:15"}


def test_gap_up_close_above_high_buys_call():
    r = gap_rule(_state(_m(12, 9, 15, 60400, 60500, 60380, 60450)))  # +0.67 % gap, close above 60,200
    assert r["go"] and r["side"] == "CE"


def test_gap_down_close_below_low_buys_put():
    r = gap_rule(_state(_m(12, 9, 15, 59600, 59650, 59500, 59550)))  # -0.67 %, close below 59,900
    assert r["go"] and r["side"] == "PE"


def test_small_gap_no_trade():
    r = gap_rule(_state(_m(12, 9, 15, 60300, 60400, 60250, 60350)))  # +0.5 %
    assert not r["go"] and r["grade"] is None


def test_close_back_inside_no_trade():
    r = gap_rule(_state(_m(12, 9, 15, 60400, 60450, 60100, 60150)))  # gap but closes below yesterday's high
    assert not r["go"]


def test_too_late_blocked():
    r = gap_rule(_state(_m(12, 9, 15, 60400, 60500, 60380, 60450), now=datetime(2026, 11, 12, 9, 20, 30, tzinfo=IST)))
    assert not r["go"] and r["grade"] == "A" and r["blocked"]


def test_one_a_day():
    st = _state(_m(12, 9, 15, 60400, 60500, 60380, 60450))
    st["tradedToday"] = True
    assert not gap_rule(st)["go"]
