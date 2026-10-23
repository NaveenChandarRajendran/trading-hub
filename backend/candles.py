"""
candles.py - index candles for the Dashboard chart. Pure: no network, no clock of its own.

- Buckets are IST and aligned to the 09:15 open: a 3-min candle starts at 09:15, 09:18, 09:21 ...; the last one of the
  session starts before 15:30 (15:29 for 1-min). Ticks outside 09:15-15:30 IST are ignored.
- Times are epoch seconds (UTC) of the bucket start, as TradingView Lightweight Charts expects.
- Live candles are built from index ticks bucketed by the backend's IST receive time (the feed's own tick time zone
  is not verified yet), see CandleBuilder.
- Volume: an index has none, so candles carry the near-month index future's volume for the same minute
  (merge_volume for history, VolumeBuilder for the live minute from the feed's running day volume).
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


class VolumeBuilder:
    """Per-minute volume from the feed's running day volume (Full packets carry the day's total so far):
    a minute's volume = total now - total at the end of the previous minute. The first minute seen after connecting
    (or on a new day) starts from 0, so the whole day so far is never put into one bar."""

    def __init__(self):
        self._state = {}  # key -> {"day", "minute", "base", "last"}

    def on_volume(self, key, day_volume, now: datetime):
        """Returns {"time": minute start (epoch s), "volume": volume in that minute so far}, or None."""
        if day_volume is None or not in_session(now):
            return None
        minute, day = epoch(bucket_start(now, 1)), now.astimezone(IST).date()
        st = self._state.get(key)
        if st is None or st["day"] != day or day_volume < st["last"]:  # first sighting, new day or feed reset
            st = self._state[key] = {"day": day, "minute": minute, "base": day_volume, "last": day_volume}
        elif minute != st["minute"]:
            st["minute"], st["base"] = minute, st["last"]
        st["last"] = day_volume
        return {"time": minute, "volume": max(0, day_volume - st["base"])}


def aggregate(candles, interval: int):
    """1-minute candles (ascending) -> interval-minute candles aligned to 09:15 IST, per day. Volume adds up."""
    if interval == 1:
        return [dict(c) for c in candles]
    out = []
    for c in candles:
        start = epoch(bucket_start(datetime.fromtimestamp(c["time"], IST), interval))
        if out and out[-1]["time"] == start:
            o = out[-1]
            o["high"], o["low"], o["close"] = max(o["high"], c["high"]), min(o["low"], c["low"]), c["close"]
            if "volume" in c:
                o["volume"] = o.get("volume", 0) + c["volume"]
        else:
            out.append({k: c[k] for k in ("open", "high", "low", "close", "volume") if k in c} | {"time": start})
    return out


def merge_volume(index_candles, future_candles):
    """Adds each minute's futures volume to the index candle of the same minute (0 when the future has none)."""
    vol = {c["time"]: c.get("volume", 0) for c in future_candles}
    return [{**c, "volume": vol.get(c["time"], 0)} for c in index_candles]


def parse_intraday(payload):
    """Dhan /charts/intraday response -> ascending 1-minute candles inside the session (with volume when sent)."""
    p = payload or {}
    cols = [p.get(k) or [] for k in ("timestamp", "open", "high", "low", "close")]
    volume = p.get("volume") or []  # empty for an index
    out = []
    for i, (ts, o, h, l, c) in enumerate(zip(*cols)):
        try:
            t = datetime.fromtimestamp(int(ts), IST)
            row = {"time": int(ts), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
            if i < len(volume):
                row["volume"] = float(volume[i])
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
