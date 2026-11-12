"""
sig_gap.py - the "Big Gap Buy" rule (Bank Nifty), from the Shiva (OI Pulse) video tested on 28-Oct-2026 (project files
research/shiva-gap/: 13,440 versions; Bank Nifty with a gap of 0.6 % or more passed, Nifty did not). Owner OK'd PAPER
trading on 12-Nov-2026 on its own Rs 50,000 book "gap" (the Option Buy spare money). Internal id: gapBuy.
docs/strategies/big-gap-buy.md is the written rule; this file must match it.

BANKNIFTY only, 1-minute index candles. One check, on the first candle of the day (09:15-09:16):
    gap up     today's open >= yesterday's close x 1.006   and the 09:15 candle closes ABOVE yesterday's high -> CALL
    gap down   today's open <= yesterday's close x 0.994   and the 09:15 candle closes BELOW yesterday's low  -> PUT
Buy the ATM option at 09:16 (late start: up to 09:18, else no trade). Exit: premium stop -20 %, target +80 %, or after 60
minutes (autopaper.json gapBuy.maxHoldMin), else the 15:14 time exit. One trade a day at most.
Backtest (1 lot, Dhan costs + 0.5 % slippage): Nov 2021-Dec 2024 +49.1k (123 trades), 2025-Oct 2026 +59.2k (60 trades),
every year positive, worst drop 20.8k.
"""
from datetime import datetime

from sig_indicators import IST
from sig_rules import FAIL, NOT_CHECKED, PASS, check, gates

RULE = "gapBuy"
SYMBOLS = ("BANKNIFTY",)
GAP_PCT = 0.6
LAST_ENTRY = (9, 18)
NAME = "Big Gap Buy"


def _date(t):
    return datetime.fromtimestamp(t, IST).date()


def evaluate(one_min, now):
    """yesterday's high / low / close, today's open and the 09:15 candle; side 'CE' / 'PE' when the rule fires."""
    now_s = now.timestamp()
    closed = sorted((m for m in one_min if m["time"] + 60 <= now_s), key=lambda m: m["time"])
    today = [m for m in closed if _date(m["time"]) == now.date()]
    prev_days = sorted({_date(m["time"]) for m in closed if _date(m["time"]) < now.date()})
    out = {"first": None, "prev": None, "side": None}
    if prev_days:
        p = [m for m in closed if _date(m["time"]) == prev_days[-1]]
        out["prev"] = {"high": max(m["high"] for m in p), "low": min(m["low"] for m in p), "close": p[-1]["close"]}
    if today:
        f = today[0]
        if datetime.fromtimestamp(f["time"], IST).strftime("%H:%M") == "09:15":
            out["first"] = f
    pv, f = out["prev"], out["first"]
    if pv and f:
        gap = (f["open"] / pv["close"] - 1) * 100
        out["gapPct"] = gap
        if gap >= GAP_PCT and f["close"] > pv["high"]:
            out["side"] = "CE"
        elif gap <= -GAP_PCT and f["close"] < pv["low"]:
            out["side"] = "PE"
    return out


def build_state_gap(symbol, now, src, max_age=None):
    """Returns (state, problems). src: sig_service.MarketSources (candles_v2; only the index candles are used)."""
    try:
        _sessions, one_min, _fut, last_err = src.candles_v2(symbol, max_age=max_age, n=2)
    except Exception as e:
        return None, [f"{symbol} Big Gap Buy candles: {e}"]
    problems = [f"{symbol} candles: {last_err}"] if last_err else []
    ev = evaluate(one_min, now)
    if ev["first"] is None:
        return None, problems + [f"{symbol}: no 09:15 candle today yet"]
    state = {"symbol": symbol, "marketOpen": src.market_open(), "positions": src.positions(symbol),
             "hm": (now.hour, now.minute), "signalTime": "09:15", "bar": ev["first"], "spot": ev["first"]["close"], "gap": ev}
    return state, problems


def _f(x):
    return "—" if x is None else f"{x:,.2f}"


def checks(state):
    ev = state["gap"]
    pv, f = ev["prev"], ev["first"]
    if not pv:
        return [check("gap", f"Gap {GAP_PCT}% or more", NOT_CHECKED, "No candles from yesterday", True)]
    g = ev.get("gapPct", 0.0)
    out = [check("gap", f"Gap {GAP_PCT}% or more", PASS if abs(g) >= GAP_PCT else FAIL,
                 f"Opened {g:+.2f}% from yesterday's close {_f(pv['close'])}", True)]
    if g >= 0:
        out.append(check("beyond", "9:15 candle closes above yesterday's high", PASS if f["close"] > pv["high"] else FAIL,
                         f"Close {_f(f['close'])}, yesterday's high {_f(pv['high'])}", True))
    else:
        out.append(check("beyond", "9:15 candle closes below yesterday's low", PASS if f["close"] < pv["low"] else FAIL,
                         f"Close {_f(f['close'])}, yesterday's low {_f(pv['low'])}", True))
    return out


def gap_rule(state):
    """GO = both checks pass, by 09:18, no position, and no Big Gap Buy signal earlier today (state["tradedToday"])."""
    cs = checks(state)
    side = state["gap"]["side"]
    green = side is not None
    blocked = gates(state, RULE, LAST_ENTRY)
    if state.get("tradedToday"):
        blocked.append("Already had today's signal (one a day)")
    return {
        "rule": RULE, "name": NAME.upper(), "setup": NAME, "account": f"{NAME} book",
        "symbol": state["symbol"], "side": side or ("CE" if state["gap"].get("gapPct", 0) >= 0 else "PE"),
        "go": green and not blocked, "grade": "A" if green else None,
        "checks": cs, "blocked": blocked, "tags": [], "at": state.get("signalTime"),
        "score": sum(c["state"] == PASS for c in cs), "total": 2, "interval": 1,
    }
