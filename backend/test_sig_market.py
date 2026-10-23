from datetime import date, datetime

from sig_indicators import IST
from sig_market import five_minute_bars, previous_session


def minute(day, hm, close):
    h, m = map(int, hm.split(":"))
    t = int(datetime(2026, 10, day, h, m, tzinfo=IST).timestamp())
    return {"time": t, "open": close, "high": close + 1, "low": close - 1, "close": close, "volume": 10}


def test_only_closed_five_minute_bars_and_completeness():
    mins = [minute(23, f"10:{m:02d}", 100 + m) for m in range(0, 7)]  # 10:00 ... 10:06
    bars, complete = five_minute_bars(mins, datetime(2026, 10, 23, 10, 7, 30, tzinfo=IST))
    assert len(bars) == 1 and bars[0]["close"] == 104 and complete  # 10:00-10:04; 10:05 is still open
    assert bars[0]["volume"] == 50
    gap = [m for m in mins if m["close"] != 104]  # the 10:04 minute has not arrived yet
    bars, complete = five_minute_bars(gap, datetime(2026, 10, 23, 10, 5, 30, tzinfo=IST))
    assert len(bars) == 1 and not complete


def test_previous_session_high_low_close():
    mins = [minute(22, "15:28", 200), minute(22, "15:29", 205), minute(23, "09:15", 300)]
    p = previous_session(mins, (date(2026, 10, 22), date(2026, 10, 23)))
    assert p == {"high": 206, "low": 199, "close": 205, "date": "2026-10-22"}
