"""
sig_rebound.py - the "Rebound Call" rule (BankNifty Rebound Call), found by the 5-year strategy search of 27-Oct-2026 and
approved by the owner for PAPER trading on its own Rs 1 lakh "rebound" account (strategy_books.py). Internal id: reboundCall.
docs/strategies/rebound-call.md is the written rule; this file must match it.

BANKNIFTY only, 5-minute index candles (09:15-aligned, IST), evaluated after every 5-minute close (sig_service.run_once).
CALL only, the first candle of the day that meets all three (one trade a day):
    deep fall   close <= EMA 200 - 4.09 x ATR 14              (EMA and ATR on 5-minute closes, across sessions)
    down today  close <= today's open - 0.11 x average daily range (high - low) of the 10 sessions before today
    bouncing    close >= VWAP - 0.38 x ATR 14                 (VWAP = running mean of (H + L + C) / 3 of today's 5-minute
                                                                candles; no volume, as in the backtest)
    window      candle closing 09:20 to 14:30
Buy the ATM call at the next minute; stop -25 %, target +50 % (autopaper.json reboundCall), otherwise the 15:14 time exit.
Thresholds are the 20th / 40th / 40th percentiles of 2021-24 BANKNIFTY candles (strategy search, research thread).
Pure functions; build_state_rebound wires them to the backend's candle cache (no Dhan calls of its own).
"""
from datetime import datetime

from candles import aggregate
from sig_indicators import IST, atr, ema
from sig_rules import FAIL, NOT_CHECKED, PASS, check, gates

RULE = "reboundCall"
INTERVAL = 5
SYMBOLS = ("BANKNIFTY",)
EMA_LEN, ATR_LEN = 200, 14
DEEP_ATR = 4.09  # close at least this many ATRs below EMA 200
DOWN_RANGE = 0.11  # close below today's open by this share of the 10-session average daily range
BOUNCE_ATR = 0.38  # close no more than this many ATRs below VWAP
RANGE_DAYS = 10
FIRST_CLOSE, LAST_CLOSE = (9, 20), (14, 30)
SESSIONS = RANGE_DAYS + 2  # 10 earlier sessions for the daily range (+ today, + one spare); 900 candles warm EMA 200


def closed_bars(one_min, now):
    """1-minute -> 5-minute candles that have closed by `now`; complete = the last one has its final minute."""
    now_s = now.timestamp()
    bars = [b for b in aggregate(one_min, INTERVAL) if b["time"] + INTERVAL * 60 <= now_s]
    if not bars:
        return bars, False
    last = bars[-1]["time"]
    return bars, any(m["time"] == last + (INTERVAL - 1) * 60 for m in one_min)


def _day(t):
    return datetime.fromtimestamp(t, IST).date()


def indicators(bars):
    """Values on the last bar: EMA 200, ATR 14, today's open and VWAP, and the 10-session average daily range."""
    h, lo, c = [b["high"] for b in bars], [b["low"] for b in bars], [b["close"] for b in bars]
    today = _day(bars[-1]["time"])
    tb = [b for b in bars if _day(b["time"]) == today]
    vwap = sum((b["high"] + b["low"] + b["close"]) / 3 for b in tb) / len(tb)
    ranges = {}
    for b in bars:
        d = _day(b["time"])
        if d < today:
            hi, low = ranges.get(d, (b["high"], b["low"]))
            ranges[d] = (max(hi, b["high"]), min(low, b["low"]))
    days = sorted(ranges)[-RANGE_DAYS:]
    avg_range = sum(ranges[d][0] - ranges[d][1] for d in days) / RANGE_DAYS if len(days) == RANGE_DAYS else None
    return {"ema200": ema(c, EMA_LEN)[-1], "atr": atr(h, lo, c, ATR_LEN)[-1], "dayOpen": tb[0]["open"], "vwap": vwap,
            "avgRange": avg_range}


def build_state_rebound(symbol, now, src, max_age=None):
    """Returns (state, problems). src: sig_service.MarketSources (candles_v2; only the index candles are used)."""
    problems = []
    try:
        sessions, one_min, _fut, last_err = src.candles_v2(symbol, max_age=max_age, n=SESSIONS)
    except Exception as e:
        return None, [f"{symbol} Rebound Call candles: {e}"]
    if last_err:
        problems.append(f"{symbol} candles: {last_err}")
    bars, complete = closed_bars(one_min, now)
    if not bars or _day(bars[-1]["time"]) != now.date():
        return None, problems + [f"{symbol}: no completed 5-minute candle today yet"]
    close_t = datetime.fromtimestamp(bars[-1]["time"] + INTERVAL * 60, IST)
    state = {"symbol": symbol, "marketOpen": src.market_open(), "positions": src.positions(symbol),
             "hm": (close_t.hour, close_t.minute), "signalTime": datetime.fromtimestamp(bars[-1]["time"], IST).strftime("%H:%M"),
             "complete": complete, "interval": INTERVAL, "bar": bars[-1], "ind": indicators(bars), "spot": bars[-1]["close"]}
    return state, problems


def _f(x, d=2):
    return "—" if x is None else f"{x:,.{d}f}"


def checks(state):
    c, ind = state["bar"]["close"], state["ind"]
    e, a, o, vw, rng = ind["ema200"], ind["atr"], ind["dayOpen"], ind["vwap"], ind["avgRange"]
    out = []
    if e is None or a is None:
        out.append(check("deepFall", f"Close {DEEP_ATR} ATR below EMA 200", NOT_CHECKED, "Not enough candles yet", True))
    else:
        lvl = e - DEEP_ATR * a
        out.append(check("deepFall", f"Close {DEEP_ATR} ATR below EMA 200", PASS if c <= lvl else FAIL,
                         f"Close {c:,.2f}, needs {lvl:,.2f} or lower (EMA 200 {e:,.2f}, ATR {a:,.2f})", True))
    if rng is None:
        out.append(check("downToday", "Down from today's open", NOT_CHECKED, f"Needs {RANGE_DAYS} earlier sessions", True))
    else:
        lvl = o - DOWN_RANGE * rng
        out.append(check("downToday", "Down from today's open", PASS if c <= lvl else FAIL,
                         f"Close {c:,.2f}, needs {lvl:,.2f} or lower (open {o:,.2f}, {RANGE_DAYS}-day range {rng:,.2f})", True))
    if a is None:
        out.append(check("bounce", "Back near VWAP", NOT_CHECKED, "Not enough candles yet", True))
    else:
        lvl = vw - BOUNCE_ATR * a
        out.append(check("bounce", "Back near VWAP", PASS if c >= lvl else FAIL,
                         f"Close {c:,.2f}, needs {lvl:,.2f} or higher (VWAP {vw:,.2f})", True))
    ok = FIRST_CLOSE <= tuple(state["hm"]) <= LAST_CLOSE
    out.append(check("window", "Entry window", PASS if ok else FAIL, "5-minute candle closing 09:20 to 14:30", True))
    return out


def rebound_rule(state):
    """GO = all checks pass, no position on the account, and no Rebound Call trade or signal earlier today
    (state["tradedToday"], set by sig_service: the backtest took only the day's first signal)."""
    cs = checks(state)
    green = all(c["state"] == PASS for c in cs)
    blocked = [b for b in gates(state, RULE, LAST_CLOSE) if not b.startswith("No new entries")]
    if state.get("tradedToday"):
        blocked.append("Already had today's signal (one a day)")
    score = sum(c["state"] == PASS for c in cs if c["id"] != "window")
    return {
        "rule": RULE, "name": "REBOUND CALL", "setup": "Rebound Call", "account": "Rebound Call book",
        "symbol": state["symbol"], "side": "CE", "go": green and not blocked, "grade": "A" if green else None,
        "checks": cs, "blocked": blocked, "tags": [], "at": state.get("signalTime"),
        "score": score, "total": 3, "interval": INTERVAL,
    }
