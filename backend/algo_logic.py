"""
algo_logic.py - the OI breakout algo's rules as a state machine (docs/strategies/oi-breakout.md). Pure: no clock, no
I/O, no orders. The runner (algo_service.py) feeds it closed 5-minute candles and live ticks and carries out the
"enter" / "exit" actions it returns; every decision also comes back as an "event" for the decision log.

State is a plain dict (stored as JSON, so a restart resumes exactly where it was):
  levels      {"R1": 22800, ..., "S3": 22200} locked at 09:30, levelsAt "HH:MM"
  trades      entries taken today
  open        the open trade or None: {side, setup, entrySpot, entryAt, target, stop: {"dir", "price"}, entryPrice?}
  setup       an armed breakout waiting for its pullback, or None: {side, level, breakAt, count, filters}
  armed       {"CE": bool, "PE": bool}: a new break needs a close back on the other side of R1 / S1 first
  rangeArmed  {"R1": bool, "S1": bool}: a new range touch needs a candle that did not touch the level first
Sides: CE (bullish: breakout above R1, range bounce at S1), PE (bearish: breakdown below S1, range rejection at R1).
"""
from datetime import datetime

import algo_config as cfg

LEVEL_SLOTS = ("R1", "R2", "R3", "S1", "S2", "S3")


def new_state(symbol, day):
    return {"symbol": symbol, "day": day, "levels": None, "levelsAt": None, "trades": 0, "open": None, "setup": None,
            "armed": {"CE": True, "PE": True}, "rangeArmed": {"R1": True, "S1": True}, "stopped": False}


def fmt(x):
    return "-" if x is None else f"{x:,.2f}".rstrip("0").rstrip(".")


def hm(t):
    return t.strftime("%H:%M") if isinstance(t, datetime) else str(t)


def event(kind, message, **data):
    return {"type": "event", "kind": kind, "message": message, "data": data}


# ---------------------------------------------------------------- filters
def breakout_checks(side, f):
    """Filters on the break candle. f: {"toi": {"sentiment", "strength"} | None, "oiChange": {"verdict", "points"} | None,
    "components": {"verdict", "indexMove"} | None, "rsi": float | None}. Returns (all ok, [check]) with each
    check {"name", "ok", "value"}; missing data fails the check."""
    bull = side == "CE"
    want = "Bullish" if bull else "Bearish"
    toi, oic, comp, r = f.get("toi"), f.get("oiChange"), f.get("components"), f.get("rsi")
    lo, hi = cfg.RSI_CE if bull else cfg.RSI_PE
    checks = [
        {"name": "Trending OI", "ok": bool(toi) and toi["sentiment"] == want and abs(toi["strength"]) >= cfg.TOI_STRENGTH_MIN,
         "value": f"{toi['sentiment']} {abs(toi['strength']):.1f}% (need {want} >= {cfg.TOI_STRENGTH_MIN:.0f}%)" if toi
         else "no data"},
        {"name": "OI change", "ok": bool(oic) and oic["verdict"] == want.upper(),
         "value": f"{oic['verdict']} ({oic['points']:+.1f} pts, need {want.upper()})" if oic else "no data"},
        {"name": "RSI", "ok": r is not None and lo <= r <= hi,
         "value": f"{r:.1f} (need {lo:.0f}-{hi:.0f})" if r is not None else "no data"},
        {"name": "Components", "ok": bool(comp) and comp.get("verdict") is not None
         and comp["verdict"] != ("Bearish" if bull else "Bullish"),
         "value": f"{comp['verdict']} ({comp['indexMove']:+.2f}%, need not {'Bearish' if bull else 'Bullish'})"
         if comp and comp.get("verdict") else f"not ready ({comp['priced']}/{comp['total']} priced)" if comp else "no data"},
    ]
    return all(c["ok"] for c in checks), checks


def checks_text(checks):
    return "; ".join(f"{c['name']} {'OK' if c['ok'] else 'FAIL'}: {c['value']}" for c in checks)


def entry_block(state, now, block=""):
    """Why a new entry is not allowed right now ("" = allowed). block: the runner's reason (stopped, stale data,
    token expired, day loss limit, mode)."""
    if block:
        return block
    if state["stopped"]:
        return "algo stopped (kill switch)"
    if not (cfg.ENTRY_FROM <= now.time() <= cfg.ENTRY_TO):
        return f"outside the entry window {cfg.ENTRY_FROM:%H:%M}-{cfg.ENTRY_TO:%H:%M}"
    if state["open"]:
        return f"already {cfg.MAX_OPEN_PER_INDEX} open position on {state['symbol']}"
    if state["trades"] >= cfg.MAX_TRADES_PER_INDEX:
        return f"max {cfg.MAX_TRADES_PER_INDEX} trades for {state['symbol']} today"
    return ""


# ---------------------------------------------------------------- candles
def lock_levels(state, levels, at):
    state["levels"], state["levelsAt"] = dict(levels), hm(at)
    text = " · ".join(f"{s} {fmt(levels.get(s))}" for s in LEVEL_SLOTS)
    return [event("levels", f"Levels locked at {hm(at)}: {text}", levels=dict(levels))]


def _enter(state, side, setup, target, stop_dir, stop_price, reason, c, now, data):
    state["trades"] += 1
    state["open"] = {"side": side, "setup": setup, "entrySpot": c["close"], "entryAt": hm(now), "target": target,
                     "stop": {"dir": stop_dir, "price": stop_price}, "reason": reason}
    return {"type": "enter", "side": side, "setup": setup, "reason": reason, "data": {**data, "target": target,
            "spotStop": f"close {stop_dir} {fmt(stop_price)}"}}


def on_candle(state, c, now, filters, block=""):
    """One closed 5-minute candle {time, open, high, low, close} (now = its close time). Returns actions."""
    L = state["levels"]
    if not L:
        return []
    sym, buf = state["symbol"], cfg.BUFFER[state["symbol"]]
    r1, s1, r2, s2 = L.get("R1"), L.get("S1"), L.get("R2"), L.get("S2")
    out = []
    candle = f"{hm(now)} candle O {fmt(c['open'])} H {fmt(c['high'])} L {fmt(c['low'])} C {fmt(c['close'])}"
    base = {"candle": {k: c[k] for k in ("open", "high", "low", "close")}, "candleEnd": hm(now)}

    # 1. open trade: spot stop on the close
    o = state["open"]
    if o and not o.get("exiting"):
        st = o["stop"]
        if (st["dir"] == "below" and c["close"] < st["price"]) or (st["dir"] == "above" and c["close"] > st["price"]):
            o["exiting"] = True
            out.append({"type": "exit", "reason": f"Spot stop: {candle} closed {st['dir']} {fmt(st['price'])}",
                        "data": base})

    # 2. re-arming: a close back on the other side of the level / a candle that did not touch it
    if r1 is not None and c["close"] <= r1:
        state["armed"]["CE"] = True
    if s1 is not None and c["close"] >= s1:
        state["armed"]["PE"] = True
    if r1 is not None and c["high"] < r1:
        state["rangeArmed"]["R1"] = True
    if s1 is not None and c["low"] > s1:
        state["rangeArmed"]["S1"] = True

    # 3. an armed breakout: cancel / pullback entry / expiry
    s = state["setup"]
    had_setup = bool(s)  # range waits for a candle that starts with no breakout setup
    entered = False
    if s:
        s["count"] += 1
        lvl, name = s["level"], s["name"]
        if s["side"] == "CE":
            cancel, confirm = c["close"] < lvl - buf, c["low"] <= lvl + buf and c["close"] > lvl
            cancel_txt = f"closed {fmt(c['close'])} below R1 {fmt(lvl)} - {buf}"
            confirm_txt = f"low {fmt(c['low'])} within {buf} of R1 {fmt(lvl)} and closed {fmt(c['close'])} above it"
        else:
            cancel, confirm = c["close"] > lvl + buf, c["high"] >= lvl - buf and c["close"] < lvl
            cancel_txt = f"closed {fmt(c['close'])} above S1 {fmt(lvl)} + {buf}"
            confirm_txt = f"high {fmt(c['high'])} within {buf} of S1 {fmt(lvl)} and closed {fmt(c['close'])} below it"
        if cancel:
            state["setup"] = None
            out.append(event("cancel", f"{name} cancelled: {candle} {cancel_txt}", **base))
        elif confirm:
            state["setup"] = None
            why = entry_block(state, now, block)
            if why:
                out.append(event("skip", f"{name} pullback at {hm(now)} but no entry: {why}", **base))
            else:
                bull = s["side"] == "CE"
                target = r2 if bull else s2
                target = None if target is None else target - buf if bull else target + buf
                reason = (f"{name}: break {s['breakText']}; pullback {candle}: {confirm_txt}. "
                          f"Filters at the break: {checks_text(s['checks'])}")
                out.append(_enter(state, s["side"], name, target, "below" if bull else "above",
                                  lvl - buf if bull else lvl + buf, reason, c, now, {**base, "checks": s["checks"]}))
                entered = True
        elif s["count"] >= cfg.PULLBACK_CANDLES:
            state["setup"] = None
            out.append(event("expire", f"{name} expired: no pullback within {cfg.PULLBACK_CANDLES} candles", **base))

    # 4. a new break above R1 / below S1
    for side, lvl, broke, name, txt in (
            ("CE", r1, r1 is not None and c["close"] > r1 + buf, "Breakout CE", f"above R1 {fmt(r1)} + {buf}"),
            ("PE", s1, s1 is not None and c["close"] < s1 - buf, "Breakdown PE", f"below S1 {fmt(s1)} - {buf}")):
        if not broke or not state["armed"][side] or entered:
            continue
        state["armed"][side] = False
        break_text = f"{candle} closed {txt}"
        if state["setup"] or state["open"]:
            out.append(event("skip", f"{name} break ignored ({'setup armed' if state['setup'] else 'position open'}): "
                                      f"{break_text}", **base))
            continue
        ok, checks = breakout_checks(side, filters)
        if not ok:
            out.append(event("skip", f"{name} filters failed: {break_text}. {checks_text(checks)}", checks=checks, **base))
            continue
        state["setup"] = {"side": side, "name": name, "level": lvl, "breakAt": hm(now), "count": 0, "checks": checks,
                          "breakText": break_text}
        out.append(event("armed", f"{name} armed: {break_text}. {checks_text(checks)}. Waiting up to "
                                  f"{cfg.PULLBACK_CANDLES} candles for a pullback to {'R1' if side == 'CE' else 'S1'}",
                         checks=checks, **base))

    # 5. range: rejection at R1 (PE) / bounce at S1 (CE), only with no breakout setup and no position
    if not entered and not had_setup and not state["setup"] and not state["open"] and r1 is not None and s1 is not None:
        width = r1 - s1
        toi = filters.get("toi")
        for key, side, touched, name, target, stop_dir, stop_price, against in (
                ("R1", "PE", c["high"] >= r1 and c["close"] < r1, "Range PE (R1 rejection)", s1 + buf, "above", r1 + buf,
                 "Bullish"),
                ("S1", "CE", c["low"] <= s1 and c["close"] > s1, "Range CE (S1 bounce)", r1 - buf, "below", s1 - buf,
                 "Bearish")):
            if not touched or not state["rangeArmed"][key]:
                continue
            state["rangeArmed"][key] = False
            touch = (f"{candle}: {'high' if key == 'R1' else 'low'} {fmt(c['high'] if key == 'R1' else c['low'])} "
                     f"touched {key} {fmt(r1 if key == 'R1' else s1)}, closed back {'below' if key == 'R1' else 'above'}")
            min_w = cfg.MIN_RANGE_WIDTH[sym]
            if width < min_w:
                out.append(event("skip", f"{name} blocked: R1 - S1 = {fmt(width)} < {min_w}. {touch}", **base))
                continue
            if toi and toi["sentiment"] == against and abs(toi["strength"]) >= cfg.TOI_STRENGTH_MIN:
                out.append(event("skip", f"{name} blocked: Trending OI {toi['sentiment']} {abs(toi['strength']):.1f}% "
                                          f">= {cfg.TOI_STRENGTH_MIN:.0f}% against it. {touch}", **base))
                continue
            why = entry_block(state, now, block)
            if why:
                out.append(event("skip", f"{name} no entry: {why}. {touch}", **base))
                continue
            toi_txt = f"{toi['sentiment']} {abs(toi['strength']):.1f}%" if toi else "no data"
            reason = f"{name}: {touch}. Range R1 - S1 = {fmt(width)}. Trending OI {toi_txt} (not blocking)"
            out.append(_enter(state, side, name, target, stop_dir, stop_price, reason, c, now, base))
            break
    return out


# ---------------------------------------------------------------- ticks
def on_tick(state, spot, ltp):
    """Live spot / option price: target zone reached or premium stop. Returns an exit action or None."""
    o = state["open"]
    if not o or o.get("exiting"):
        return None
    t = o.get("target")
    if t is not None and spot is not None:
        if (o["side"] == "CE" and spot >= t) or (o["side"] == "PE" and spot <= t):
            o["exiting"] = True
            return {"type": "exit", "reason": f"Target zone reached: spot {fmt(spot)} {'>=' if o['side'] == 'CE' else '<='} "
                                              f"{fmt(t)}", "data": {"spot": spot}}
    entry = o.get("entryPrice")
    if entry and ltp is not None and ltp <= entry * (1 - cfg.PREMIUM_STOP_PCT / 100):
        o["exiting"] = True
        return {"type": "exit", "reason": f"Premium stop: LTP {fmt(ltp)} <= entry {fmt(entry)} - {cfg.PREMIUM_STOP_PCT:g}%",
                "data": {"ltp": ltp}}
    return None
