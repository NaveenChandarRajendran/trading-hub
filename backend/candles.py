"""
candles.py - index candles for the Dashboard chart. Pure: no network, no clock of its own.

- Buckets are IST and aligned to the 09:15 open: a 3-min candle starts at 09:15, 09:18, 09:21 ...; the last one of the
  session starts before 15:30 (15:29 for 1-min). Ticks outside 09:15-15:30 IST are ignored.
- Times are epoch seconds (UTC) of the bucket start, as TradingView Lightweight Charts expects.
- Live candles are built from index ticks bucketed by the backend's IST receive time (the feed's own tick time zone
  is not verified yet), see CandleBuilder.
"""
from datetime import date, datetime, time, timedelta

from holidays import NSE_HOLIDAYS
from store import IST

SESSION_OPEN = time(9, 15)
SESSION_CLOSE = time(15, 30)
INTERVALS = (1, 3, 5, 15)  # minutes


def in_session(t: datetime) -> bool:
    return SESSION_OPEN <= t.astimezone(IST).time() < SESSION_CLOSE


def bucket_start(t: datetime, interval: int) -> datetime:
    """Start of the interval-minute bucket holding t (IST), counted from 09:15. t must be inside the session."""
    t = t.astimezone(IST)
    open_ = t.replace(hour=SESSION_OPEN.hour, minute=SESSION_OPEN.minute, second=0, microsecond=0)
    minutes = int((t - open_).total_seconds() // 60)
    return open_ + timedelta(minutes=minutes - minutes % interval)


def epoch(t: datetime) -> int:
    return int(t.timestamp())


class CandleBuilder:
    """Keeps the current 1-minute candle per instrument and updates it from ticks."""

    def __init__(self):
        self._current = {}  # key -> candle dict

    def on_tick(self, key, ltp, now: datetime):
        """Returns the updated candle {time, open, high, low, close}, or None for a tick outside the session."""
        if not ltp or not in_session(now):
            return None
        start = epoch(bucket_start(now, 1))
        c = self._current.get(key)
        if c is None or c["time"] != start:
            c = {"time": start, "open": ltp, "high": ltp, "low": ltp, "close": ltp}
            self._current[key] = c
        else:
            c["high"], c["low"], c["close"] = max(c["high"], ltp), min(c["low"], ltp), ltp
        return dict(c)


def aggregate(candles, interval: int):
    """1-minute candles (ascending) -> interval-minute candles aligned to 09:15 IST, per day."""
    if interval == 1:
        return [dict(c) for c in candles]
    out = []
    for c in candles:
        start = epoch(bucket_start(datetime.fromtimestamp(c["time"], IST), interval))
        if out and out[-1]["time"] == start:
            o = out[-1]
            o["high"], o["low"], o["close"] = max(o["high"], c["high"]), min(o["low"], c["low"]), c["close"]
        else:
            out.append({"time": start, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"]})
    return out


def parse_intraday(payload):
    """Dhan /charts/intraday response -> ascending 1-minute candles inside the session."""
    p = payload or {}
    cols = [p.get(k) or [] for k in ("timestamp", "open", "high", "low", "close")]
    out = []
    for ts, o, h, l, c in zip(*cols):
        try:
            t = datetime.fromtimestamp(int(ts), IST)
            row = {"time": int(ts), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
        except (TypeError, ValueError):
            continue
        if in_session(t):
            out.append(row)
    out.sort(key=lambda r: r["time"])
    return out


def is_trading_day(d: date, holidays=NSE_HOLIDAYS) -> bool:
    return d.weekday() < 5 and d.isoformat() not in holidays


def recent_sessions(today: date, n=2, holidays=NSE_HOLIDAYS):
    """The last n trading days up to and including today, oldest first (today only if it is a trading day)."""
    days, d = [], today
    while len(days) < n:
        if is_trading_day(d, holidays):
            days.append(d)
        d -= timedelta(days=1)
    return days[::-1]
