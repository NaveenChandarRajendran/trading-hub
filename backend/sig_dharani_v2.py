"""
sig_dharani_v2.py - the "Dharani" rule: the teacher's tuned Quantman setups, copied as taught (owner, 25-Oct-2026).
Traded on the app's own Rs 1 lakh "dharani" paper account (strategy_books.py). Internal id: dharaniV2.
docs/strategies/dharani-v2.md is the written rule; this file must match it.

NIFTY and BANKNIFTY (owner 25-Oct-2026; the teacher tested NIFTY), 3-minute candles (09:15-aligned, IST), evaluated
after every 3-minute close.
CALL ("L1 08 FINAL CE"), index candles:
    close > SuperTrend (10, 2)   RSI (14) > 70   close > R1 (Traditional, previous day)
    close > upper Bollinger (15, 3)   Williams %R (14) > -30
PUT ("L1 10 PE ALT"), the index's near-month FUTURES candles (the teacher's "Fields: Future"):
    close < SuperTrend (10, 2)   close < EMA 200   RSI (20) < 30   CCI (20) < -200   Williams %R (14) < -85
    close < CPR S1 (futures' previous day)   CPR is narrow (width < 0.2 %)   close < lower Bollinger (20, 2)
Exit: a candle closing back through the SuperTrend line (call: below it, put: above it), on the same data as the entry.
Pure functions; build_state_v2 wires them to the backend's caches (no Dhan calls of its own apart from those caches).
"""
from datetime import datetime

from candles import aggregate
from sig_indicators import IST, bollinger, cci, cpr, ema, pivots, rsi, supertrend, williams_r
from sig_market import previous_session
from sig_rules import FAIL, MB_LAST_ENTRY, NOT_CHECKED, PASS, check, gates

INTERVAL = 3
FIRST_CLOSE = (9, 18)  # the first 3-minute candle (09:15-09:18); the teacher trades from 09:15
CALL = {"rsi": (14, 70.0), "bb": (15, 3.0), "wr": (14, -30.0)}
PUT = {"ema": 200, "rsi": (20, 30.0), "cci": (20, -200.0), "wr": (14, -85.0), "cprNarrowPct": 0.2, "bb": (20, 2.0)}
ST = (10, 2.0)
SESSIONS = 4  # history for EMA 200 on 3-minute candles
# option bought: CE / PE whose premium is nearest this (teacher's "Premium near 250" on NIFTY weeklies; BANKNIFTY has
# monthly expiries only, so its options cost more: 500, owner 25-Oct-2026). Overridable in autopaper.json dharaniV2.premiumNear.
PREMIUM_NEAR = {"NIFTY": 250, "BANKNIFTY": 500}


def closed_bars(one_min, now):
    """1-minute -> 3-minute candles that have closed by `now`; complete = the last one has its final minute."""
    now_s = now.timestamp()
    bars = [b for b in aggregate(one_min, INTERVAL) if b["time"] + INTERVAL * 60 <= now_s]
    if not bars:
        return bars, False
    last = bars[-1]["time"]
    return bars, any(m["time"] == last + (INTERVAL - 1) * 60 for m in one_min)


def call_indicators(bars):
    h, lo, c = [b["high"] for b in bars], [b["low"] for b in bars], [b["close"] for b in bars]
    line, d = supertrend(h, lo, c, *ST)
    _b, up, _l = bollinger(c, *CALL["bb"])
    return {"st_line": line, "st_dir": d, "rsi": rsi(c, CALL["rsi"][0]), "bb_upper": up, "wr": williams_r(h, lo, c, CALL["wr"][0])}


def put_indicators(bars):
    h, lo, c = [b["high"] for b in bars], [b["low"] for b in bars], [b["close"] for b in bars]
    line, d = supertrend(h, lo, c, *ST)
    _b, _u, low = bollinger(c, *PUT["bb"])
    return {"st_line": line, "st_dir": d, "ema": ema(c, PUT["ema"]), "rsi": rsi(c, PUT["rsi"][0]),
            "cci": cci(h, lo, c, PUT["cci"][0]), "wr": williams_r(h, lo, c, PUT["wr"][0]), "bb_lower": low}


def _last(series):
    return series[-1] if series else None


def build_state_v2(symbol, now, src, max_age=None):
    """Returns (state, problems). src: sig_service.MarketSources (needs candles_v2)."""
    problems = []
    try:
        sessions, one_min, fut_min, last_err = src.candles_v2(symbol, max_age=max_age, n=SESSIONS)
    except Exception as e:
        return None, [f"{symbol} 3-min candles: {e}"]
    if last_err:
        problems.append(f"{symbol} candles: {last_err}")
    bars, complete = closed_bars(one_min, now)
    if not bars:
        return None, problems + [f"{symbol}: no completed 3-minute candle yet"]
    close_t = datetime.fromtimestamp(bars[-1]["time"] + INTERVAL * 60, IST)
    state = {"symbol": symbol, "marketOpen": src.market_open(), "positions": src.positions(symbol),
             "hm": (close_t.hour, close_t.minute), "signalTime": datetime.fromtimestamp(bars[-1]["time"], IST).strftime("%H:%M"),
             "complete": complete, "interval": INTERVAL,
             "idx": {"bar": bars[-1], "ind": {k: _last(v) for k, v in call_indicators(bars).items()}}}
    prev = previous_session(one_min, sessions[-2:])
    state["piv"] = pivots(prev["high"], prev["low"], prev["close"]) if prev else None
    state["spot"] = bars[-1]["close"]
    fbars, fcomplete = closed_bars(fut_min or [], now)
    if fbars and fbars[-1]["time"] == bars[-1]["time"]:
        fprev = previous_session(fut_min, sessions[-2:])
        state["fut"] = {"bar": fbars[-1], "ind": {k: _last(v) for k, v in put_indicators(fbars).items()},
                        "piv": pivots(fprev["high"], fprev["low"], fprev["close"]) if fprev else None,
                        "cpr": cpr(fprev["high"], fprev["low"], fprev["close"]) if fprev else None}
        state["complete"] = complete and fcomplete
    else:
        state["fut"] = None
        problems.append(f"{symbol} futures 3-min candles: not available for the {state['signalTime']} candle")
    return state, problems


def _cmp(id_, label, value, ok, detail):
    if value is None:
        return check(id_, label, NOT_CHECKED, "Not enough data yet", True)
    return check(id_, label, PASS if ok else FAIL, detail, True)


def call_checks(state):
    x = state["idx"]
    c, ind, piv = x["bar"]["close"], x["ind"], state.get("piv")
    r1 = piv["R1"] if piv else None
    out = [
        _cmp("supertrend", "SuperTrend (10, 2)", ind["st_line"], ind["st_line"] is not None and c > ind["st_line"],
             f"Close {c:,.2f} {'above' if ind['st_line'] is not None and c > ind['st_line'] else 'below'} {_f(ind['st_line'])}"),
        _cmp("rsi", "RSI 14 above 70", ind["rsi"], ind["rsi"] is not None and ind["rsi"] > CALL["rsi"][1], f"{_f(ind['rsi'], 1)}"),
        _cmp("pivot", "Close above R1", r1, r1 is not None and c > r1, f"R1 {_f(r1)}"),
        _cmp("bollinger", "Close above upper Bollinger (15, 3)", ind["bb_upper"], ind["bb_upper"] is not None and c > ind["bb_upper"],
             f"Upper {_f(ind['bb_upper'])}"),
        _cmp("williams", "Williams %R 14 above -30", ind["wr"], ind["wr"] is not None and ind["wr"] > CALL["wr"][1], f"{_f(ind['wr'], 1)}"),
    ]
    out.append(window_check(state))
    return out


def put_checks(state):
    f = state.get("fut")
    if not f:
        return [check("futures", "Futures data", NOT_CHECKED, "Futures 3-minute candles not available", True),
                window_check(state)]
    c, ind, cp, piv = f["bar"]["close"], f["ind"], f.get("cpr"), f.get("piv")
    s1 = piv["S1"] if piv else None
    w = cp["widthPct"] if cp else None
    out = [
        _cmp("supertrend", "SuperTrend (10, 2), futures", ind["st_line"], ind["st_line"] is not None and c < ind["st_line"],
             f"Close {c:,.2f} {'below' if ind['st_line'] is not None and c < ind['st_line'] else 'above'} {_f(ind['st_line'])}"),
        _cmp("ema", "Close below EMA 200", ind["ema"], ind["ema"] is not None and c < ind["ema"], f"EMA {_f(ind['ema'])}"),
        _cmp("rsi", "RSI 20 below 30", ind["rsi"], ind["rsi"] is not None and ind["rsi"] < PUT["rsi"][1], f"{_f(ind['rsi'], 1)}"),
        _cmp("cci", "CCI 20 below -200", ind["cci"], ind["cci"] is not None and ind["cci"] < PUT["cci"][1], f"{_f(ind['cci'], 0)}"),
        _cmp("williams", "Williams %R 14 below -85", ind["wr"], ind["wr"] is not None and ind["wr"] < PUT["wr"][1], f"{_f(ind['wr'], 1)}"),
        _cmp("pivot", "Close below CPR S1", s1, s1 is not None and c < s1, f"S1 {_f(s1)}"),
        _cmp("cprNarrow", "CPR is narrow", w, w is not None and w < PUT["cprNarrowPct"], f"Width {_f(w, 3)}% (narrow below {PUT['cprNarrowPct']}%)"),
        _cmp("bollinger", "Close below lower Bollinger (20, 2)", ind["bb_lower"], ind["bb_lower"] is not None and c < ind["bb_lower"],
             f"Lower {_f(ind['bb_lower'])}"),
    ]
    out.append(window_check(state))
    return out


def window_check(state):
    ok = FIRST_CLOSE <= tuple(state["hm"]) <= MB_LAST_ENTRY
    return check("window", "Entry window", PASS if ok else FAIL, "3-minute candle closing 09:18 to 15:00", True)


def _f(x, d=2):
    return "—" if x is None else f"{x:,.{d}f}"


def dharani_v2_rule(state):
    both = {"CE": call_checks(state), "PE": put_checks(state)}
    score = {s: sum(c["state"] == PASS for c in both[s] if c["id"] != "window") for s in both}
    total = {s: sum(1 for c in both[s] if c["id"] != "window") for s in both}
    side = max(("CE", "PE"), key=lambda s: (score[s] / total[s], s == ("CE" if state["idx"]["ind"]["st_dir"] == -1 else "PE")))
    checks = both[side]
    green = all(c["state"] == PASS for c in checks)
    blocked = [b for b in gates(state, "dharaniV2", MB_LAST_ENTRY) if not b.startswith("No new entries")]
    return {
        "rule": "dharaniV2", "name": "DHARANI RULES", "setup": "Dharani Rules", "account": "Dharani (app paper)",
        "symbol": state["symbol"], "side": side, "go": green and not blocked, "grade": "A" if green else None,
        "checks": checks, "blocked": blocked, "tags": [], "at": state.get("signalTime"),
        "score": score[side], "total": total[side], "interval": INTERVAL, "noTarget": True,
        "premiumNear": state.get("premiumNear") or PREMIUM_NEAR.get(state["symbol"], 250),
    }


def dharani_v2_exit(state, side):
    """SuperTrend exit on a completed 3-minute candle (call: index closes below the line; put: futures close above)."""
    if side == "CE":
        c, line = state["idx"]["bar"]["close"], state["idx"]["ind"]["st_line"]
        if line is not None and c < line:
            return f"Closed below SuperTrend ({c:,.2f} < {line:,.2f})"
        return None
    f = state.get("fut")
    if not f:
        return None
    c, line = f["bar"]["close"], f["ind"]["st_line"]
    if line is not None and c > line:
        return f"Futures closed above SuperTrend ({c:,.2f} > {line:,.2f})"
    return None
