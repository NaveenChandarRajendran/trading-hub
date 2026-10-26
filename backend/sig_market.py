"""
sig_market.py - builds the `state` the rules read (sig_rules.py) from the backend's existing data. No Dhan calls of its
own: candles come from the dashboard's CandleService, the option chain from the shared chain cache, Trending OI rows
from the tracker, India VIX from one index-LTP call.

Pure helpers (tested): five_minute_bars, previous_session, indicators. build_state() wires them to the services.
"""
from datetime import date, datetime

from candles import aggregate
from holidays import next_trading_day
from sig_indicators import IST, bollinger, ema, pivots, rsi, supertrend, vwap

INTERVAL = 5
ST_PERIOD, ST_FACTOR = 10, 2.0
BB_PERIOD, BB_MULT = 20, 2.0
EMA_PERIOD, RSI_PERIOD = 20, 14


def five_minute_bars(one_min, now):
    """1-minute candles -> 5-minute candles, keeping only the ones that have CLOSED by `now` (IST datetime).
    Returns (bars, complete): complete is False when the last closed bar is missing its final minute (Dhan's intraday
    data can trail by a minute; the watcher then retries)."""
    now_s = now.timestamp()
    bars = [b for b in aggregate(one_min, INTERVAL) if b["time"] + INTERVAL * 60 <= now_s]
    if not bars:
        return bars, False
    last = bars[-1]["time"]
    complete = any(m["time"] == last + (INTERVAL - 1) * 60 for m in one_min)
    return bars, complete


def previous_session(one_min, sessions):
    """High / low / close of the earlier session from the 1-minute candles (sessions = (previous, today))."""
    if len(sessions) < 2:
        return None
    day = sessions[0]
    rows = [m for m in one_min if datetime.fromtimestamp(m["time"], IST).date() == day]
    if not rows:
        return None
    return {"high": max(m["high"] for m in rows), "low": min(m["low"] for m in rows), "close": rows[-1]["close"],
            "date": day.isoformat()}


def indicators(bars):
    t = [b["time"] for b in bars]
    h = [b["high"] for b in bars]
    lo = [b["low"] for b in bars]
    c = [b["close"] for b in bars]
    v = [b.get("volume") or 0 for b in bars]
    st_line, st_dir = supertrend(h, lo, c, ST_PERIOD, ST_FACTOR)
    basis, upper, lower = bollinger(c, BB_PERIOD, BB_MULT)
    return {"st_line": st_line, "st_dir": st_dir, "bb_basis": basis, "bb_upper": upper, "bb_lower": lower,
            "ema20": ema(c, EMA_PERIOD), "vwap": vwap(t, h, lo, c, v), "rsi": rsi(c, RSI_PERIOD)}


def today_range(one_min, today):
    rows = [m for m in one_min if datetime.fromtimestamp(m["time"], IST).date() == today]
    if not rows:
        return None
    return {"high": max(m["high"] for m in rows), "low": min(m["low"] for m in rows), "last": rows[-1]["close"]}


def expiry_phase(expiry, today):
    """"expiry" when today IS the nearest expiry, "eve" when the next trading day is, else None (Trend Rules skips
    both; owner 26-Oct-2026). expiry = "YYYY-MM-DD" from Dhan, today = the session's date."""
    if not expiry or not today:
        return None
    try:
        exp = date.fromisoformat(expiry) if isinstance(expiry, str) else expiry
    except ValueError:
        return None
    if exp == today:
        return "expiry"
    return "eve" if exp == next_trading_day(today) else None


def build_state(symbol, now, src):
    """src: sig_service.MarketSources (candles, chain, trending rows, VIX, open positions). Never raises for a
    missing section: the rule shows that check as "not checked" instead. Returns (state, problems)."""
    problems = []
    state = {"symbol": symbol, "marketOpen": src.market_open(), "positions": src.positions(symbol)}
    try:
        _fetched, sessions, one_min, _fut, vol_err, last_err = src.candles(symbol)
    except Exception as e:
        return None, [f"{symbol} candles: {e}"]
    if last_err:
        problems.append(f"{symbol} candles: {last_err}")
    bars, complete = five_minute_bars(one_min, now)
    if not bars:
        return None, problems + [f"{symbol}: no completed 5-minute candle yet"]
    state.update(bars=bars, i=len(bars) - 1, complete=complete, ind=indicators(bars), volumeError=vol_err)
    close_t = datetime.fromtimestamp(bars[-1]["time"] + INTERVAL * 60, IST)
    state["hm"] = (close_t.hour, close_t.minute)
    state["signalTime"] = datetime.fromtimestamp(bars[-1]["time"], IST).strftime("%H:%M")
    prev = previous_session(one_min, sessions)
    state["prev"] = prev
    state["piv"] = pivots(prev["high"], prev["low"], prev["close"]) if prev else None
    state["today"] = today_range(one_min, sessions[-1])

    expiry, body = None, None
    try:
        expiry = src.expiry(symbol)
        body = src.chain(symbol, expiry)
    except Exception as e:
        problems.append(f"{symbol} option chain: {e}")
    state["expiry"] = expiry
    state["expiryPhase"] = expiry_phase(expiry, sessions[-1])
    if body:
        from sig_oi import oi_change_view, sensibull_view, sr_view
        state["oi"], state["sb"], state["sr"] = oi_change_view(body), sensibull_view(body), sr_view(body)
        state["pcr"] = state["oi"]["pcr"] if state["oi"] else None
        state["spot"] = body["meta"]["spot"]
    else:
        state.update(oi=None, sb=None, sr=None, pcr=None, spot=bars[-1]["close"])
    try:
        state["toiAll"] = src.trending(symbol, expiry) if expiry else []
    except Exception as e:
        problems.append(f"{symbol} Trending OI: {e}")
        state["toiAll"] = []
    state["toi"] = [r for r in state["toiAll"] if not r.get("live")]
    try:
        state["vix"] = src.vix()
    except Exception as e:
        problems.append(f"India VIX: {e}")
        state["vix"] = None
    return state, problems
