"""
sig_orb.py - the "Box Pullback" rule (15-min opening box + 5-min close outside + buy the pullback), from a YouTube video
the owner shared. Owner asked for PAPER trading on 29-Oct-2026 although Claude's 5-year test lost money (project files
research/orb-pullback/: this exact version about -25 k to -30 k a year per index on 1 lot after costs). Internal id:
orbPullback, own Rs 1 lakh "orb" book. docs/strategies/box-pullback.md is the written rule; this file must match it.

NIFTY and BANKNIFTY, today's 1-minute index candles (09:15-aligned, IST), checked every minute (sig_service.run_orb).
    box       high / low of 09:15-09:29 (the first 15-minute candle)
    break     the first 5-minute candle (09:30 onwards) that CLOSES above the box high (call) or below the box low (put);
              only the day's first break counts
    pullback  after that candle, the first 1-minute candle whose low touches the box high (call) / whose high touches the
              box low (put): buy the ATM option at the next minute. No pullback by 13:30: no trade today.
    stop      index back to the middle of the box
    target    index 2 x (box edge - middle) beyond the box edge (2R)
    time      15:14 time exit (autopaper timeExit)
Pure functions; build_state_orb wires them to the backend's candle cache (no Dhan calls of its own).
"""
from datetime import datetime

from candles import aggregate
from sig_indicators import IST
from sig_rules import FAIL, NOT_CHECKED, PASS, check, gates

RULE = "orbPullback"
SYMBOLS = ("NIFTY", "BANKNIFTY")
BOX_MIN, BREAK_TF = 15, 5
R_MULT = 2.0
LAST_ENTRY = (13, 30)  # pullback must come before this (backtest "dead" = 13:30)


def _hm(t):
    d = datetime.fromtimestamp(t, IST)
    return d.hour, d.minute


def today_minutes(one_min, now):
    """Today's 1-minute candles that have closed by `now`, oldest first."""
    now_s = now.timestamp()
    out = [m for m in one_min if datetime.fromtimestamp(m["time"], IST).date() == now.date() and m["time"] + 60 <= now_s]
    return sorted(out, key=lambda m: m["time"])


def evaluate(mins):
    """Walks today's closed 1-minute candles. Returns a dict: phase (box / break / pullback / signal / none), the box,
    and for a signal: side, entry minute time, index stop and target."""
    out = {"phase": "box", "high": None, "low": None}
    if len(mins) < BOX_MIN or _hm(mins[0]["time"]) != (9, 15):
        return out
    box = mins[:BOX_MIN]
    hi, lo = max(m["high"] for m in box), min(m["low"] for m in box)
    out.update(high=hi, low=lo, mid=(hi + lo) / 2, phase="break")
    if hi <= lo:
        out["phase"] = "none"
        return out
    rest = mins[BOX_MIN:]
    bars = aggregate(rest, BREAK_TF)
    for b in bars:
        n = sum(1 for m in rest if b["time"] <= m["time"] < b["time"] + BREAK_TF * 60)
        if n < BREAK_TF and b is bars[-1]:
            return out  # the 5-minute candle is still forming
        if _hm(b["time"] + BREAK_TF * 60) > LAST_ENTRY:
            out["phase"] = "none"
            return out
        up, dn = b["close"] > hi, b["close"] < lo
        if not (up or dn):
            continue
        side = "CE" if up else "PE"
        lvl = hi if up else lo
        risk = abs(lvl - out["mid"])
        out.update(phase="pullback", side=side, breakAt=_hm(b["time"] + BREAK_TF * 60), level=lvl,
                   stop=out["mid"], target=lvl + R_MULT * risk if up else lvl - R_MULT * risk)
        for m in rest:
            if m["time"] < b["time"] + BREAK_TF * 60:
                continue
            if _hm(m["time"] + 60) > LAST_ENTRY:
                out["phase"] = "none"
                return out
            if (up and m["low"] <= lvl) or (dn and m["high"] >= lvl):
                out.update(phase="signal", touchAt=_hm(m["time"]), signalTime=m["time"])
                return out
        return out
    return out


def build_state_orb(symbol, now, src, max_age=None):
    """Returns (state, problems). src: sig_service.MarketSources (candles_v2; only the index candles are used)."""
    problems = []
    try:
        _sessions, one_min, _fut, last_err = src.candles_v2(symbol, max_age=max_age, n=2)
    except Exception as e:
        return None, [f"{symbol} Box Pullback candles: {e}"]
    if last_err:
        problems.append(f"{symbol} candles: {last_err}")
    mins = today_minutes(one_min, now)
    if not mins:
        return None, problems + [f"{symbol}: no 1-minute candle today yet"]
    ev = evaluate(mins)
    state = {"symbol": symbol, "marketOpen": src.market_open(), "positions": src.positions(symbol),
             "hm": (now.hour, now.minute), "signalTime": datetime.fromtimestamp(mins[-1]["time"], IST).strftime("%H:%M"),
             "bar": mins[-1], "spot": mins[-1]["close"], "orb": ev}
    return state, problems


def _f(x):
    return "—" if x is None else f"{x:,.2f}"


def checks(state):
    ev = state["orb"]
    out = []
    if ev["high"] is None:
        out.append(check("box", "15-min box", NOT_CHECKED, "Waiting for 09:15-09:29", True))
        return out
    out.append(check("box", "15-min box", PASS, f"High {_f(ev['high'])}, low {_f(ev['low'])}", True))
    if ev["phase"] in ("pullback", "signal"):
        word = "above the high" if ev["side"] == "CE" else "below the low"
        out.append(check("break", "5-min close outside", PASS, f"Closed {word} at {ev['breakAt'][0]:02d}:{ev['breakAt'][1]:02d}", True))
    else:
        out.append(check("break", "5-min close outside", FAIL, "No 5-minute close outside the box yet", True))
    if ev["phase"] == "signal":
        out.append(check("pullback", "Pullback to the box", PASS,
                         f"Touched {_f(ev['level'])} at {ev['touchAt'][0]:02d}:{ev['touchAt'][1]:02d}; stop {_f(ev['stop'])}, "
                         f"target {_f(ev['target'])}", True))
    else:
        out.append(check("pullback", "Pullback to the box", FAIL,
                         f"Waiting for price back to {_f(ev.get('level'))}" if ev["phase"] == "pullback" else "—", True))
    return out


def orb_rule(state):
    """GO = signal on this minute's walk, no position on the account, and no Box Pullback signal earlier today
    (state["tradedToday"], set by sig_service: one trade a day, the backtest took only the first break)."""
    cs = checks(state)
    ev = state["orb"]
    green = ev["phase"] == "signal"
    blocked = [b for b in gates(state, RULE, (15, 14)) if not b.startswith("No new entries")]
    if state.get("tradedToday"):
        blocked.append("Already had today's signal (one a day)")
    if ev["phase"] == "none":
        blocked.append("No trade today (no break, or no pullback by 13:30)")
    return {
        "rule": RULE, "name": "BOX PULLBACK", "setup": "Box Pullback", "account": "Box Pullback book",
        "symbol": state["symbol"], "side": ev.get("side") or "CE", "go": green and not blocked, "grade": "A" if green else None,
        "checks": cs, "blocked": blocked, "tags": [], "at": state.get("signalTime"),
        "score": sum(c["state"] == PASS for c in cs), "total": 3, "interval": 1,
        "indexStop": ev.get("stop"), "indexTarget": ev.get("target"), "noTarget": True,
    }


def orb_exit(trade, bar):
    """Index stop / target on a closed 1-minute candle (stop checked first, like the backtest). None = stay in."""
    st, tg = trade.get("indexStop"), trade.get("indexTarget")
    if st is None or tg is None:
        return None
    if trade["side"] == "CE":
        if bar["low"] <= st:
            return f"Index stop {st:,.2f} (box middle)"
        if bar["high"] >= tg:
            return f"Index target {tg:,.2f} (2R)"
    else:
        if bar["high"] >= st:
            return f"Index stop {st:,.2f} (box middle)"
        if bar["low"] <= tg:
            return f"Index target {tg:,.2f} (2R)"
    return None
