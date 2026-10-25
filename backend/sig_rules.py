"""
sig_rules.py - the two written rules, evaluated on the last completed 5-minute candle. Pure: no clock, no I/O.

Specs (the code must match them exactly; change the doc first):
    Trading Hub rule  docs/strategies/trading-hub-trend.md
    MegaBull rule     docs/strategies/megabull.md (4 Pillar = BANKNIFTY, Dharani = NIFTY)

Input is a `state` dict built by sig_market.build_state():
    symbol        "NIFTY" | "BANKNIFTY"
    bars          5-minute candles oldest first (previous session + today): {time, open, high, low, close, volume}
    i             index of the last COMPLETED candle in bars (the signal candle)
    ind           indicator lists aligned with bars: st_line, st_dir, bb_basis, bb_upper, bb_lower, ema20, vwap, rsi
    prev          previous session {high, low, close}; piv = sig_indicators.pivots(prev)
    oi            sig_oi.oi_change_view (Dhan OI & OI Change Live), sb = sensibull_view (record only), sr = sr_view
    toi           Trending OI 5-min rows, completed only, newest first: [{time "HH:MM", strengthPct, ...}]
    vix, pcr      India VIX, PCR (OI & OI Change's)
    hm            (hour, minute) IST of the signal candle's CLOSE, i.e. the next candle's open = the entry time

Every check is {"id", "label", "detail", "state", "must"}; state is "pass" | "fail" | "borderline" | "notChecked".
"""
PASS, FAIL, BORDER, NOT_CHECKED = "pass", "fail", "borderline", "notChecked"

# Trading Hub rule (trading-hub-trend.md)
TH_TOI_STRENGTH = 50.0  # %
TH_TOI_ROWS = 3
TH_LAST_ENTRY = (14, 30)
TH_RSI_PUT = (30.0, 45.0)  # green inside, borderline below
TH_RSI_CALL = (55.0, 70.0)  # green inside, borderline above

# MegaBull rule (megabull.md)
MB_FIRST_TRIGGER = (9, 30)  # trigger candle starts at or after
MB_LAST_ENTRY = (15, 0)
MB_RSI_4P = 45.0
MB_VIX_MAX = 14.0
MB_PCR = 0.9  # owner 23-Oct evening: "near 1 or above" = call side, "well below 1" = put side; 0.9 for now
MB_RSI_DHARANI = (45.0, 55.0)  # put below the first, call above the second
MB_PIVOT_ROOM = {"NIFTY": 50.0, "BANKNIFTY": 100.0}  # room to the next pivot level (Dharani is NIFTY only)
MB_WALL_ROOM = {"NIFTY": 50.0, "BANKNIFTY": 200.0}  # room to the nearest OI level in the trade's direction

DELTA_NOTE = "Estimated from Dhan ticks; not used until it matches Dext. Not checked; trade tagged."

# autopaper.json "rules" -> these names (the owner's easy-to-change settings)
SETTINGS = {
    "trendingOiStrength": "TH_TOI_STRENGTH", "trendingOiRows": "TH_TOI_ROWS", "vixMax": "MB_VIX_MAX", "pcr": "MB_PCR",
    "rsi4Pillar": "MB_RSI_4P", "pivotRoom": "MB_PIVOT_ROOM", "wallRoom": "MB_WALL_ROOM",
}


def configure(rules):
    """Applies autopaper.json "rules" (only the names in SETTINGS; anything else is ignored)."""
    g = globals()
    for key, name in SETTINGS.items():
        if key in (rules or {}):
            v = rules[key]
            g[name] = {**g[name], **v} if isinstance(g[name], dict) else type(g[name])(v)


def check(id_, label, state, detail="", must=False, exempt=False):
    """exempt: a delta check that is "not checked" (owner, 23-Oct-2026) never blocks a GO; the trade is tagged."""
    return {"id": id_, "label": label, "state": state, "detail": detail, "must": must, "exempt": exempt}


def _fmt(x, d=2):
    return "—" if x is None else f"{x:,.{d}f}"


def _signed(x, d=0):
    return "—" if x is None else f"{x:+,.{d}f}".replace("-", "−")


def _ago(state, key, k=0):
    i = state["i"] - k
    if i < 0:
        return None
    v = state["ind"][key]
    return v[i] if i < len(v) else None


# ------------------------------------------------------------------ shared checks
def supertrend_check(state, side, must=True):
    line, d = _ago(state, "st_line"), _ago(state, "st_dir")
    close = state["bars"][state["i"]]["close"]
    if line is None:
        return check("supertrend", "SuperTrend (10, 2)", NOT_CHECKED, "Not enough candles yet", must)
    colour = "Green" if d == -1 else "Red"
    if side == "PE":
        ok = d == 1 and close < line
        detail = f"{colour}, {'above' if line > close else 'below'} price"
    else:
        ok = d == -1 and close > line
        detail = f"{colour}, {'below' if line < close else 'above'} price"
    return check("supertrend", "SuperTrend (10, 2)", PASS if ok else FAIL, detail, must)


def rsi_value(state):
    return _ago(state, "rsi")


def side_word(side):
    return "put" if side == "PE" else "call"


# ------------------------------------------------------------------ Trading Hub rule
def trading_hub_checks(state, side):
    bars, i = state["bars"], state["i"]
    close = bars[i]["close"]
    sign = -1 if side == "PE" else 1
    out = [supertrend_check(state, side)]

    rows = state.get("toi") or []
    last = rows[:TH_TOI_ROWS]
    oi = state.get("oi")
    want = "Bearish" if side == "PE" else "Bullish"
    if len(last) < TH_TOI_ROWS or oi is None:
        out.append(check("trendingOi", f"Trending OI {TH_TOI_STRENGTH:.0f}% or more, {TH_TOI_ROWS} rows", NOT_CHECKED,
                         "Not enough Trending OI rows yet" if oi else "Dhan OI & OI Change not available", True))
    else:
        strong = all(sign * r["strengthPct"] >= TH_TOI_STRENGTH for r in last)
        agrees = oi["verdict"] == want
        detail = " / ".join(f"{_signed(r['strengthPct'])}%" for r in last) + f" · Dhan OI {oi['verdict']}"
        out.append(check("trendingOi", f"Trending OI {TH_TOI_STRENGTH:.0f}% or more, {TH_TOI_ROWS} rows + Dhan OI agrees",
                         PASS if strong and agrees else FAIL, detail, True))
    out.append(check("delta", "Cumulative delta agrees", NOT_CHECKED, DELTA_NOTE, True, exempt=True))

    p = state["piv"]["P"] if state.get("piv") else None
    if p is None:
        out.append(check("pivot", "Price vs pivot", NOT_CHECKED, "No previous session"))
    else:
        ok = close < p if side == "PE" else close > p
        out.append(check("pivot", "Price vs pivot", PASS if ok else FAIL, f"{'Below' if close < p else 'Above'} {_fmt(p)}"))

    vw, em = _ago(state, "vwap"), _ago(state, "ema20")
    if vw is None or em is None:
        out.append(check("averages", "Price vs VWAP and EMA 20", NOT_CHECKED, "VWAP needs futures volume" if vw is None else "EMA not ready"))
    else:
        ok = (close < vw and close < em) if side == "PE" else (close > vw and close > em)
        detail = f"{'Below' if close < vw else 'Above'} VWAP {vw:,.2f}, {'below' if close < em else 'above'} EMA {em:,.2f}"
        out.append(check("averages", "Price vs VWAP and EMA 20", PASS if ok else FAIL, detail))

    up, lo, ba = _ago(state, "bb_upper"), _ago(state, "bb_lower"), _ago(state, "bb_basis")
    up1, lo1 = _ago(state, "bb_upper", 1), _ago(state, "bb_lower", 1)
    if None in (up, lo, ba, up1, lo1):
        out.append(check("bbWidening", "Bollinger bands widening", NOT_CHECKED, "Not enough candles yet"))
        out.append(check("bbOuter", "Price in the outer half of the band", NOT_CHECKED, "Not enough candles yet"))
    else:
        w, w1 = up - lo, up1 - lo1
        out.append(check("bbWidening", "Bollinger bands widening", PASS if w > w1 else FAIL,
                         f"Width {_fmt(w, 1)} vs {_fmt(w1, 1)}" + (" (widening)" if w > w1 else " (flat or narrowing)")))
        mid = (ba + lo) / 2 if side == "PE" else (ba + up) / 2
        ok = close <= mid if side == "PE" else close >= mid
        half = "lower" if close < ba else "upper"
        outer = ok
        out.append(check("bbOuter", "Price in the outer half of the band", PASS if outer else FAIL,
                         f"{half.capitalize()} half{', outer part' if outer else ', inner part'}"))

    r = rsi_value(state)
    if r is None:
        out.append(check("rsi", "RSI 14", NOT_CHECKED, "Not enough candles yet"))
    elif side == "PE":
        lo_, hi_ = TH_RSI_PUT
        st = PASS if lo_ <= r <= hi_ else BORDER if r < lo_ else FAIL
        out.append(check("rsi", "RSI 14", st, f"{r:.1f} · put zone {lo_:.0f} to {hi_:.0f}"))
    else:
        lo_, hi_ = TH_RSI_CALL
        st = PASS if lo_ <= r <= hi_ else BORDER if r > hi_ else FAIL
        out.append(check("rsi", "RSI 14", st, f"{r:.1f} · call zone {lo_:.0f} to {hi_:.0f}"))
    return out


def grade(checks):
    """A / B / None from the checks (trading-hub-trend.md, Grade). Delta "not checked" never blocks."""
    musts = [c for c in checks if c["must"] and not c["exempt"]]
    if any(c["state"] != PASS for c in musts):
        return None
    off = [c for c in checks if not c["must"] and c["state"] != PASS]
    return "A" if not off else "B" if len(off) == 1 else None


def pick_side(state, evaluate):
    """The side whose must-haves are green, else the one SuperTrend points to (for the display)."""
    both = {s: evaluate(state, s) for s in ("PE", "CE")}
    for s in ("PE", "CE"):
        if all(c["state"] == PASS for c in both[s] if c["must"] and not c["exempt"]):
            return s, both[s]
    d = _ago(state, "st_dir")
    s = "CE" if d == -1 else "PE"
    return s, both[s]


def gates(state, account, last_entry):
    """Reasons that stop a new entry even when the rule is green."""
    out = []
    if not state.get("marketOpen", True):
        out.append("Market closed")
    if tuple(state["hm"]) > last_entry:
        out.append(f"No new entries after {last_entry[0]:02d}:{last_entry[1]:02d}")
    if state.get("positions", {}).get(account):
        out.append("Position already open on this index")
    return out


def trading_hub_rule(state):
    side, checks = pick_side(state, trading_hub_checks)
    g = grade(checks)
    blocked = gates(state, "tradingHub", TH_LAST_ENTRY)
    go = g is not None and not blocked
    return {
        "rule": "tradingHub", "name": "TRADING HUB RULE", "account": "Trading Hub paper", "symbol": state["symbol"],
        "side": side, "go": go, "grade": g, "checks": checks, "blocked": blocked,
        "tags": ["delta not checked"], "at": state.get("signalTime"),
    }


def trading_hub_exit(state, side):
    """Signal exit on a completed candle (trading-hub-trend.md, Trade). Returns a reason or None."""
    rows = state.get("toi") or []
    if rows:
        s = rows[0]["strengthPct"]
        if (side == "PE" and s > -TH_TOI_STRENGTH) or (side == "CE" and s < TH_TOI_STRENGTH):
            return f"Trending OI strength back inside {TH_TOI_STRENGTH:.0f}% ({_signed(s)}%)"
    line = _ago(state, "st_line")
    close = state["bars"][state["i"]]["close"]
    if line is not None and ((side == "PE" and close > line) or (side == "CE" and close < line)):
        return "5-min candle closed beyond SuperTrend"
    return None


# ------------------------------------------------------------------ MegaBull rule
def levels_for_trigger(state):
    """name -> price: pivot, previous high / low, OI R1 / S1 (owner, 23-Oct-2026)."""
    out = {}
    if state.get("piv"):
        out["Pivot"] = state["piv"]["P"]
    if state.get("prev"):
        out["Prev high"] = state["prev"]["high"]
        out["Prev low"] = state["prev"]["low"]
    sr = state.get("sr")
    if sr:
        if sr["levels"]["R"]:
            out["OI R1"] = sr["levels"]["R"][0]["strike"]
        if sr["levels"]["S"]:
            out["OI S1"] = sr["levels"]["S"][0]["strike"]
    return out


def find_trigger(state, side, supertrend_flip=False):
    """The trigger at candle i-1 (crossed a level from candle i-2) and whether candle i confirms it.
    supertrend_flip (Dharani): a SuperTrend flip on candle i-1 to the trade's side also triggers, at the line's value.
    Returns (trigger dict | None, confirmed bool | None)."""
    bars, i = state["bars"], state["i"]
    if i < 2:
        return None, None
    c2, c1, c0 = bars[i - 2]["close"], bars[i - 1]["close"], bars[i]["close"]
    crossed = []
    for name, lv in levels_for_trigger(state).items():
        if side == "CE" and c2 <= lv < c1:
            crossed.append((lv, name))
        if side == "PE" and c2 >= lv > c1:
            crossed.append((lv, name))
    if supertrend_flip:
        d1, d2, line1 = _ago(state, "st_dir", 1), _ago(state, "st_dir", 2), _ago(state, "st_line", 1)
        want = -1 if side == "CE" else 1
        if line1 is not None and d2 is not None and d1 == want and d2 != want:
            crossed.append((line1, "SuperTrend flip"))
    if not crossed:
        return None, None
    lv, name = max(crossed) if side == "CE" else min(crossed)  # the highest crossed (lowest for puts)
    trig = {"level": lv, "name": name, "time": bars[i - 1]["time"], "close": c1}
    confirmed = c0 > lv if side == "CE" else c0 < lv
    return trig, confirmed


def _hm_of(epoch_s):
    from sig_indicators import IST
    from datetime import datetime
    t = datetime.fromtimestamp(epoch_s, IST)
    return (t.hour, t.minute)


def room_check(state, side):
    sr = state.get("sr")
    close = state["bars"][state["i"]]["close"]
    need = MB_WALL_ROOM[state["symbol"]]
    if not sr:
        return check("room", "Room to the next level", NOT_CHECKED, "OI levels not available")
    if side == "CE":
        walls = sorted(x["strike"] for x in sr["levels"]["R"] if x["strike"] > close)
        nxt = walls[0] if walls else None
        kind = "resistance"
    else:
        walls = sorted((x["strike"] for x in sr["levels"]["S"] if x["strike"] < close), reverse=True)
        nxt = walls[0] if walls else None
        kind = "support"
    if nxt is None:
        return check("room", "Room to the next level", PASS, f"No OI {kind} within 500 pts (needs {need:.0f}+)")
    room = abs(nxt - close)
    return check("room", "Room to the next level", PASS if room >= need else FAIL,
                 f"{room:,.0f} pts to {nxt:,.0f} {kind} (needs {need:.0f}+)")


def flow_checks(state, side, supertrend_flip=False):
    trig, confirmed = find_trigger(state, side, supertrend_flip)
    out = []
    if trig is None:
        out.append(check("trigger", "Trigger candle (level break)", FAIL,
                         "No close beyond pivot / prev high-low / OI R1-S1" + (" / SuperTrend flip" if supertrend_flip else ""), True))
        out.append(check("confirmation", "Confirmation candle", FAIL, "Waiting for a trigger", True))
    else:
        early = _hm_of(trig["time"]) < MB_FIRST_TRIGGER
        word = "above" if side == "CE" else "below"
        out.append(check("trigger", "Trigger candle (level break)", FAIL if early else PASS,
                         f"Closed {word} {trig['name']} {trig['level']:,.2f}" + (" (first 15 min: skipped)" if early else ""), True))
        out.append(check("confirmation", "Confirmation candle", PASS if confirmed else FAIL,
                         f"Held {word} {trig['level']:,.2f}" if confirmed else f"Closed back through {trig['level']:,.2f}: cancelled", True))
    out.append(check("triggerDelta", "Trigger candle delta jump", NOT_CHECKED, DELTA_NOTE, True, exempt=True))
    hm = tuple(state["hm"])
    ok = MB_FIRST_TRIGGER <= hm <= MB_LAST_ENTRY
    out.append(check("window", "Entry window", PASS if ok else FAIL, "09:30 to 15:00, not first or last 15 min", True))
    return out


def four_pillar_checks(state, side):
    bars, i = state["bars"], state["i"]
    close = bars[i]["close"]
    out = flow_checks(state, side)
    vw, em, r = _ago(state, "vwap"), _ago(state, "ema20"), rsi_value(state)
    if None in (vw, em, r):
        out.append(check("pillar1", "Pillar 1: price vs EMA 20 / VWAP, RSI", NOT_CHECKED, "Indicators not ready", True))
    else:
        ok = (close > em and close > vw and r >= MB_RSI_4P) if side == "CE" else (close < em and close < vw and r <= MB_RSI_4P)
        out.append(check("pillar1", "Pillar 1: price vs EMA 20 / VWAP, RSI", PASS if ok else FAIL,
                         f"{'Above' if close > em else 'Below'} EMA, {'above' if close > vw else 'below'} VWAP, RSI {r:.1f}", True))
    out.append(check("pillar2", "Pillar 2: cumulative delta", NOT_CHECKED, DELTA_NOTE, True, exempt=True))
    vix = state.get("vix")
    out.append(check("pillar3", "Pillar 3: India VIX", NOT_CHECKED if vix is None else PASS if vix < MB_VIX_MAX else FAIL,
                     "VIX not available" if vix is None else f"{vix:.2f} (below {MB_VIX_MAX:.0f} = calm)", True))
    pcr = state.get("pcr")
    if pcr is None:
        out.append(check("pillar4", "Pillar 4: PCR", NOT_CHECKED, "PCR not available", True))
    else:
        ok = pcr >= MB_PCR if side == "CE" else pcr < MB_PCR
        out.append(check("pillar4", "Pillar 4: PCR", PASS if ok else FAIL, f"{pcr:.2f} ({'≥' if side == 'CE' else '<'} {MB_PCR:.2f} for a {side_word(side)})", True))
    out.append(room_check(state, side))
    return out


def dharani_checks(state, side):
    bars, i = state["bars"], state["i"]
    bar = bars[i]
    close = bar["close"]
    out = flow_checks(state, side, supertrend_flip=True)
    st = supertrend_check(state, side)
    st.update(id="pillar1", label="Pillar 1: SuperTrend (10, 2)")
    out.append(st)
    r = rsi_value(state)
    lo, hi = MB_RSI_DHARANI
    if r is None:
        out.append(check("pillar2", "Pillar 2: RSI 14", NOT_CHECKED, "Not enough candles yet", True))
    else:
        ok = r > hi if side == "CE" else r < lo
        out.append(check("pillar2", "Pillar 2: RSI 14", PASS if ok else FAIL, f"{r:.1f} (call above {hi:.0f}, put below {lo:.0f})", True))
    up, low = _ago(state, "bb_upper"), _ago(state, "bb_lower")
    if up is None:
        out.append(check("pillar3", "Pillar 3: Bollinger band press", NOT_CHECKED, "Not enough candles yet", True))
    else:
        ok = bar["high"] >= up if side == "CE" else bar["low"] <= low
        out.append(check("pillar3", "Pillar 3: Bollinger band press", PASS if ok else FAIL,
                         ("High reached the upper band" if ok else "Inside the bands") if side == "CE"
                         else ("Low reached the lower band" if ok else "Inside the bands"), True))
    piv = state.get("piv")
    if not piv:
        out.append(check("pillar4", "Pillar 4: pivot", NOT_CHECKED, "No previous session", True))
    else:
        need = MB_PIVOT_ROOM[state["symbol"]]
        names = ("R1", "R2", "R3") if side == "CE" else ("S1", "S2", "S3")
        if side == "CE":
            nxt = min((piv[n] for n in names if piv[n] > close), default=None)
            ok = close > piv["P"] and (nxt is None or nxt - close >= need)
        else:
            nxt = max((piv[n] for n in names if piv[n] < close), default=None)
            ok = close < piv["P"] and (nxt is None or close - nxt >= need)
        room = "—" if nxt is None else f"{abs(nxt - close):,.0f} pts to next level"
        out.append(check("pillar4", "Pillar 4: pivot", PASS if ok else FAIL,
                         f"{'Above' if close > piv['P'] else 'Below'} pivot {piv['P']:,.2f} · {room} (needs {need:.0f}+)", True))
    out.append(room_check(state, side))
    return out


def megabull_rule(state):
    evaluate = four_pillar_checks if state["symbol"] == "BANKNIFTY" else dharani_checks
    both = {s: evaluate(state, s) for s in ("PE", "CE")}
    # the side with a trigger is the one to show; otherwise SuperTrend's direction
    side = next((s for s in ("PE", "CE") if both[s][0]["detail"].startswith("Closed")), None)
    if side is None:
        side = "CE" if _ago(state, "st_dir") == -1 else "PE"
    checks = both[side]
    green = all(c["state"] == PASS or (c["state"] == NOT_CHECKED and c.get("exempt")) for c in checks)
    blocked = gates(state, "megabull", MB_LAST_ENTRY)
    blocked = [b for b in blocked if not b.startswith("No new entries")]  # the entry window check covers it
    return {
        "rule": "megabull", "name": "MEGABULL RULE", "setup": "4 Pillar" if evaluate is four_pillar_checks else "SuperTrend Nifty",
        "account": "MegaBull paper", "symbol": state["symbol"], "side": side, "go": green and not blocked, "grade": "A" if green else None,
        "checks": checks, "blocked": blocked, "tags": ["delta not checked"], "at": state.get("signalTime"),
    }
