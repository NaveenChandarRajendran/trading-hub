"""indicators.py and toi_algo_data.py: Supertrend (TradingView ta.supertrend, worked by hand), session VWAP of the future,
the basis to index terms, and which option expiry / future the Trending OI Algo uses."""
from datetime import date, datetime

import pytest

from indicators import atr, session_vwap, supertrend, vwap_index
from store import IST
from toi_algo_data import closed, day_range, option_expiry, vwap_future


def bar(t, h, l, c, v=0, day="2026-11-12"):
    ts = int(datetime.fromisoformat(f"{day}T{t}:00").replace(tzinfo=IST).timestamp())
    return {"time": ts, "open": c, "high": h, "low": l, "close": c, "volume": v}


# high, low, close; worked by hand below with period 3, factor 1
HLC = [(10, 8, 9), (11, 9, 10.5), (12, 10, 11.5), (13, 11, 12.5), (12, 9, 9.5), (10, 7, 7.5), (14, 12, 13.5)]
BARS = [bar(f"09:{15 + 5 * i}", *x) for i, x in enumerate(HLC)]


def test_atr_is_tradingview_rma_seeded_with_the_sma():
    # TR: 2, 2, 2, 2, 3.5 (|9 - 12.5|), 3 (10 - 7), 6.5 (|14 - 7.5|)
    a = atr(BARS, 3)
    assert a[:2] == [None, None]
    assert a[2:] == pytest.approx([2.0, 2.0, 2.5, 8 / 3, (8 / 3 * 2 + 6.5) / 3])


def test_supertrend_by_hand():
    st = supertrend(BARS, period=3, mult=1.0)
    assert st[:2] == [None, None]
    # bar 3: hl2 11, bands 9 / 13; the first bar with an ATR is a downtrend -> 13
    assert st[2] == {"value": 13.0, "up": False}
    # bar 4: up band rises to 10, down band stays 13 (14 is higher); close 12.5 not above 13 -> still 13
    assert st[3] == {"value": 13.0, "up": False}
    # bar 5: up 8 would fall, so it holds at 10; down 13; close 9.5 -> 13
    assert st[4] == {"value": 13.0, "up": False}
    # bar 6: ATR 2.667, hl2 8.5: down band falls to 11.17; up band resets to 5.83 (prev close 9.5 < 10)
    assert st[5] == {"value": 11.17, "up": False}
    # bar 7: close 13.5 above the down band 11.17 -> uptrend; the line is the up band 13 - 3.944 = 9.06
    assert st[6] == {"value": 9.06, "up": True}


def test_supertrend_stays_below_price_in_a_steady_rise():
    rising = [bar(f"{9 + (15 + 5 * i) // 60:02d}:{(15 + 5 * i) % 60:02d}", 100 + i * 2 + 1, 100 + i * 2 - 1, 100 + i * 2 + 0.5)
              for i in range(40)]
    st = supertrend(rising, 10, 3.0)
    assert st[9] is not None and st[8] is None
    assert all(s["up"] and s["value"] < c["low"] for s, c in zip(st[15:], rising[15:]))


def test_session_vwap_of_the_future_resets_each_day():
    candles = [bar("09:15", 10, 8, 9, v=100), bar("09:20", 12, 10, 11, v=300), bar("09:25", 12, 12, 12, v=0),
               bar("09:15", 20, 20, 20, v=50, day="2026-11-13")]
    # typical prices 9 and 11: (9 * 100 + 11 * 300) / 400 = 10.5; a no-volume candle leaves it; a new day restarts
    assert session_vwap(candles) == [9.0, 10.5, 10.5, 20.0]
    assert session_vwap([bar("09:15", 10, 8, 9, v=0)]) == [None]


def test_vwap_in_index_terms_subtracts_the_current_basis():
    # future VWAP 23,348, future 23,375, index 23,246 -> basis 129 -> VWAP 23,219 on the index
    assert vwap_index(23348.0, 23375.0, 23246.0) == 23219.0
    assert vwap_index(None, 23375.0, 23246.0) is None


def test_option_expiry_moves_on_on_expiry_day():
    ex = ["2026-11-17", "2026-11-24", "2026-12-01"]
    assert option_expiry(ex, date(2026, 11, 12)) == "2026-11-17"
    assert option_expiry(ex, date(2026, 11, 17)) == "2026-11-24"  # expiry day: the next weekly
    assert option_expiry(["2026-11-17"], date(2026, 11, 17)) is None


def test_vwap_future_rolls_in_its_expiry_week():
    futs = [{"securityId": 1, "symbol": "NIFTY", "expiry": "2026-11-24"}, {"securityId": 2, "symbol": "NIFTY", "expiry": "2026-12-29"},
            {"securityId": 3, "symbol": "BANKNIFTY", "expiry": "2026-11-24"}]
    assert vwap_future(futs, date(2026, 11, 20))["securityId"] == 1  # the week before: current month
    assert vwap_future(futs, date(2026, 11, 23))["securityId"] == 2  # Monday of the expiry week: next month
    assert vwap_future(futs, date(2026, 11, 25))["securityId"] == 2  # after expiry
    assert vwap_future(futs[:1], date(2026, 11, 23))["securityId"] == 1  # no next month listed yet: keep it
    assert vwap_future([], date(2026, 11, 23)) is None


def test_closed_candles_and_the_day_range():
    now = datetime(2026, 11, 12, 9, 27, tzinfo=IST)
    assert [c["close"] for c in closed(BARS, now)] == [9, 10.5]  # 09:25 is still forming at 09:27
    assert day_range(BARS, date(2026, 11, 12)) == (7, 14)
    assert day_range(BARS, date(2026, 11, 12), ltp=6.5) == (6.5, 14)
    assert day_range(BARS, date(2026, 11, 13)) == (None, None)
