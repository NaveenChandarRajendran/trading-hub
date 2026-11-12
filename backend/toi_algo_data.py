"""
toi_algo_data.py - which contracts and candles the Trending OI Algo uses. Pure.

- Option expiry: the nearest weekly NIFTY expiry from today; on an expiry day the next one.
- VWAP future: the current-month NIFTY future; from the Monday of its expiry week, the next month's (its volume and
  price take over before the current one expires).
- Candles: index candles of the timeframe (3 minutes by default; candles.aggregate of the 1-minute ones, 09:15-aligned); a candle is used only once
  closed. Day high / low so far come from today's candles.
"""
from datetime import date, datetime, timedelta

from candles import aggregate
from store import IST


def option_expiry(expiries, today):
    """expiries: 'YYYY-MM-DD' strings. The nearest one after today when today is an expiry day, else the nearest from
    today. None when there is none."""
    day = today.isoformat() if isinstance(today, date) else today
    later = sorted(e for e in expiries if e > day)  # strictly after today: an expiry day moves on to the next one
    return later[0] if later else None


def vwap_future(futures, today):
    """futures: [{"securityId", "symbol", "expiry", ...}] (instruments.parse_index_futures). The NIFTY future whose
    VWAP the algo uses today (see the module doc), or None."""
    nifty = sorted((f for f in futures if f["symbol"] == "NIFTY" and f["expiry"] >= today.isoformat()),
                   key=lambda f: f["expiry"])
    if not nifty:
        return None
    current = nifty[0]
    expiry = date.fromisoformat(current["expiry"])
    roll_from = expiry - timedelta(days=expiry.weekday())  # Monday of the expiry week
    if today >= roll_from and len(nifty) > 1:
        return nifty[1]
    return current


def five_min(one_min, interval=5):
    """1-minute candles -> interval-minute candles (09:15-aligned, per IST day)."""
    return aggregate(one_min, interval)


def closed(candles, now, interval=5):
    """Candles whose interval has ended by `now` (the last one is still forming until its end)."""
    end = int(now.timestamp())
    return [c for c in candles if c["time"] + interval * 60 <= end]


def today_only(candles, day):
    return [c for c in candles if datetime.fromtimestamp(c["time"], IST).date() == day]


def day_range(candles, day, ltp=None):
    """(low, high) of today's candles so far, with the live LTP; (None, None) before the first candle."""
    today = today_only(candles, day)
    lows = [c["low"] for c in today] + ([ltp] if ltp is not None else [])
    highs = [c["high"] for c in today] + ([ltp] if ltp is not None else [])
    return (min(lows), max(highs)) if lows else (None, None)
