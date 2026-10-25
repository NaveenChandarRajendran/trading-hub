"""
algo_logic.py - the OI breakout algo's rules as a state machine (docs/strategies/oi-breakout.md). Pure: no clock, no
I/O, no orders. The runner (algo_service.py) feeds it closed 5-minute candles and live ticks and carries out the
"enter" / "exit" actions it returns; every decision also comes back as an "event" for the decision log.

State is a plain dict (stored as JSON, so a restart resumes exactly where it was):
  levels      {"R1": 22800, ..., "S3": 22200} locked at 09:30, levelsAt "HH:MM"
  trades      entries taken today
  won         a trade closed in profit today (STOP_AFTER_WIN: no more entries for this index)
  open        the open trade or None: {side, setup, entrySpot, entryAt, target, stop: {"dir", "price"}, entryPrice?}
  setup       an armed breakout waiting for its pullback, or None: {side, level, breakAt, count, filters} (variant A)
  setups      variants B-D: armed setups per level slot {"S1": {...}, "S2": {...}}, armedLv per slot
  armed       {"CE": bool, "PE": bool}: a new break needs a close back on the other side of R1 / S1 first
  rangeArmed  {"R1": bool, "S1": bool}: a new range touch needs a candle that did not touch the level first
Sides: CE (bullish: breakout above R1, range bounce at S1), PE (bearish: breakdown below S1, range rejection at R1).
"""
from datetime import datetime

import algo_config as cfg
from paper_charges import order_charges

LEVEL_SLOTS = ("R1", "R2", "R3", "S1", "S2", "S3")


def new_state(symbol, day):
    return {"symbol": symbol, "day": day, "levels": None, "levelsAt": None, "trades": 0, "won": False, "open": None, "setup": None,
            "armed": {"CE": True, "PE": True}, "rangeArmed": {"R1": True, "S1": True}, "stopped": False,
            "setups": {}, "armedLv": {}}  # setups / armedLv: variants B-D (a setup per level slot)


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
    if f.get("oiChecked") is False:  # replay of a day without OI history: price + RSI only
        nc = "not checked (no OI history)"
        checks = [{"name": "Trending OI", "ok": True, "value": nc}, {"name": "OI change", "ok": True, "value": nc},
                  {"name": "RSI", "ok": r is not None and lo <= r <= hi,
                   "value": f"{r:.1f} (need {lo:.0f}-{hi:.0f})" if r is not None else "no data"},
                  {"name": "Components", "ok": True, "value": nc}]
        return all(c["ok"] for c in checks), checks
    if f.get("componentsChecked") is False:  # replay with saved OI snapshots: no stock-quote history
        comp = {"verdict": "Neutral", "indexMove": 0.0, "priced": 0, "total": 0, "notChecked": True}
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
         "value": "not checked (no history)" if comp and comp.get("notChecked") else
         f"{comp['verdict']} ({comp['indexMove']:+.2f}%, need not {'Bearish' if bull else 'Bullish'})"
         if comp and comp.get("verdict") else f"not ready ({comp['priced']}/{comp['total']} priced)" if comp else "no data"},
    ]
    return all(c["ok"] for c in checks), checks


def checks_text(checks):
    return "; ".join(f"{c['name']} {'OK' if c['ok'] else 'FAIL'}: {c['value']}" for c in checks)


def no_room(side, close, target):
    """True when spot is already at or through the target zone: no move left to capture (every variant skips)."""
    return target is not None and ((side == "CE" and close >= target) or (side == "PE" and close <= target))


def no_room_text(close, target, side, slot):
    return (f"no room: spot {fmt(close)} is already {'at or above' if side == 'CE' else 'at or below'} the {slot} "
            f"target zone {fmt(target)}")


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
    if cfg.STOP_AFTER_WIN and state.get("won"):
        return f"a trade closed in profit: done for {state['symbol']} today"
    if state["trades"] >= cfg.MAX_TRADES_PER_INDEX:
        return f"max {cfg.MAX_TRADES_PER_INDEX} trades for {state['symbol']} today"
    return ""


def round_trip_charges(entry_price, exit_price, qty):
    """Paper-engine charges for buying and selling qty units (used where no real fills exist: shadows, replay)."""
    return round(order_charges("BUY", entry_price * qty).total + order_charges("SELL", exit_price * qty).total, 2)


def note_result(state, pnl, charges):
    """Record a closed trade's result. Profit = P&L after charges above 0; an unknown P&L counts as no profit.
    Returns the net P&L (None when unknown)."""
    net = None if pnl is None else round(pnl - (charges or 0), 2)
    if net is not None and net > 0:
        state["won"] = True
    return net


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


def on_candle(state, c, now, filters, block="", variant=None):
    """One closed 5-minute candle {time, open, high, low, close} (now = its close time). Returns actions.
    variant: "A" (default, cfg.RULE_VARIANT) | "B" | "C" | "D" (docs/strategies/oi-breakout.md)."""
    variant = (variant or cfg.RULE_VARIANT).upper()
    if not state["levels"]:
        return []
    if variant == "A":
        return _on_candle_a(state, c, now, filters, block)
    return _on_candle_v(state, c, now, filters, block, variant)


def _ctx(state, c, now):
    candle = f"{hm(now)} candle O {fmt(c['open'])} H {fmt(c['high'])} L {fmt(c['low'])} C {fmt(c['close'])}"
    base = {"candle": {k: c[k] for k in ("open", "high", "low", "close")}, "candleEnd": hm(now)}
    return candle, base


def _spot_stop(state, c, candle, base, out):
    """Open trade: spot stop on the close."""
    o = state["open"]
    if o and not o.get("exiting"):
        st = o["stop"]
        if (st["dir"] == "below" and c["close"] < st["price"]) or (st["dir"] == "above" and c["close"] > st["price"]):
            o["exiting"] = True
            out.append({"type": "exit", "reason": f"Spot stop: {candle} closed {st['dir']} {fmt(st['price'])}",
                        "data": base})


def _range(state, c, now, filters, block, candle, base, out):
    """Range: rejection at R1 (PE) / bounce at S1 (CE). Returns True when it entered."""
    L, sym, buf = state["levels"], state["symbol"], cfg.BUFFER[state["symbol"]]
    r1, s1 = L.get("R1"), L.get("S1")
    if r1 is None or s1 is None:
        return False
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
        if no_room(side, c["close"], target):
            out.append(event("skip", f"{name} {no_room_text(c['close'], target, side, 'S1' if key == 'R1' else 'R1')}. {touch}", **base))
            continue
        toi_txt = (f"{toi['sentiment']} {abs(toi['strength']):.1f}%" if toi
                   else "not checked" if filters.get("oiChecked") is False else "no data")
        reason = f"{name}: {touch}. Range R1 - S1 = {fmt(width)}. Trending OI {toi_txt} (not blocking)"
        out.append(_enter(state, side, name, target, stop_dir, stop_price, reason, c, now, base))
        return True
    return False


def _on_candle_a(state, c, now, filters, block=""):
    """Variant A: filters checked only on the break candle."""
    L = state["levels"]
    buf = cfg.BUFFER[state["symbol"]]
    r1, s1, r2, s2 = L.get("R1"), L.get("S1"), L.get("R2"), L.get("S2")
    out = []
    candle, base = _ctx(state, c, now)

    # 1. open trade: spot stop on the close
    _spot_stop(state, c, candle, base, out)

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
            bull = s["side"] == "CE"
            target = r2 if bull else s2
            target = None if target is None else target - buf if bull else target + buf
            if why:
                out.append(event("skip", f"{name} pullback at {hm(now)} but no entry: {why}", **base))
            elif no_room(s["side"], c["close"], target):
                out.append(event("skip", f"{name} pullback at {hm(now)} but "
                                          f"{no_room_text(c['close'], target, s['side'], 'R2' if bull else 'S2')}", **base))
            else:
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
    if not entered and not had_setup and not state["setup"] and not state["open"]:
        _range(state, c, now, filters, block, candle, base, out)
    return out


# ---------------------------------------------------------------- variants B, C, D
LADDER = {"CE": ("R1", "R2", "R3"), "PE": ("S1", "S2", "S3")}


def next_slot(slot):
    """The target level of a breakout at `slot`: R1 -> R2, S2 -> S3, R3 / S3 -> None."""
    seq = LADDER["CE" if slot[0] == "R" else "PE"]
    i = seq.index(slot)
    return seq[i + 1] if i + 1 < len(seq) else None


def setup_name(side, slot):
    base = "Breakout CE" if side == "CE" else "Breakdown PE"
    return base if slot in ("R1", "S1") else f"{base} {slot}"


def _on_candle_v(state, c, now, filters, block, v):
    """Variants B, C, D (filters re-checked on every candle while a setup is armed).
    B: armed for PULLBACK_CANDLES after a break of R1 / S1; enter on a pullback candle if the filters pass then;
       a close back through the level (by the buffer) cancels.
    C: B + continuation: after CONTINUATION_AFTER candles without a pullback, a candle that passes the filters and closes
       beyond the break candle's high (CE) / low (PE) enters.
    D: B + level ladder: R1..R3 / S1..S3 are all breakout levels (target: the next one); a broken level stays armed
       until a close back through it (no 6-candle expiry), so a later retest from the other side is a pullback."""
    L = state["levels"]
    buf = cfg.BUFFER[state["symbol"]]
    setups = state.setdefault("setups", {})
    armed = state.setdefault("armedLv", {})
    out = []
    candle, base = _ctx(state, c, now)

    _spot_stop(state, c, candle, base, out)

    # re-arming per level (a close back on the other side), range as in A
    for side, slots in LADDER.items():
        for slot in slots:
            lvl = L.get(slot)
            if lvl is not None and ((side == "CE" and c["close"] <= lvl) or (side == "PE" and c["close"] >= lvl)):
                armed[slot] = True
    r1, s1 = L.get("R1"), L.get("S1")
    if r1 is not None and c["high"] < r1:
        state["rangeArmed"]["R1"] = True
    if s1 is not None and c["low"] > s1:
        state["rangeArmed"]["S1"] = True

    had_setup = bool(setups)
    entered = False
    ok, checks = breakout_checks("CE", filters)
    checks_by_side = {"CE": (ok, checks), "PE": breakout_checks("PE", filters)}

    # armed setups: cancel / pullback / continuation / expiry
    for slot in sorted(setups):
        s = setups[slot]
        s["count"] += 1
        side, lvl, name = s["side"], s["level"], s["name"]
        bull = side == "CE"
        ok, checks = checks_by_side[side]
        if bull:
            cancel = c["close"] < lvl - buf
            pull = c["low"] <= lvl + buf and c["close"] > lvl
            pull_txt = f"low {fmt(c['low'])} within {buf} of {slot} {fmt(lvl)} and closed {fmt(c['close'])} above it"
            cancel_txt = f"closed {fmt(c['close'])} back below {slot} {fmt(lvl)} - {buf}"
        else:
            cancel = c["close"] > lvl + buf
            pull = c["high"] >= lvl - buf and c["close"] < lvl
            pull_txt = f"high {fmt(c['high'])} within {buf} of {slot} {fmt(lvl)} and closed {fmt(c['close'])} below it"
            cancel_txt = f"closed {fmt(c['close'])} back above {slot} {fmt(lvl)} + {buf}"
        if cancel:
            del setups[slot]
            out.append(event("cancel", f"{name} cancelled: {candle} {cancel_txt}", setupName=name, **base))
            continue
        if entered:
            continue
        cont = (v == "C" and not pull and s["count"] > cfg.CONTINUATION_AFTER and ok
                and ((bull and c["close"] > s["breakHigh"]) or (not bull and c["close"] < s["breakLow"])))
        if pull or cont:
            how = (f"pullback {candle}: {pull_txt}" if pull else
                   f"continuation {candle}: no pullback in {cfg.CONTINUATION_AFTER} candles, closed "
                   f"{fmt(c['close'])} {'above' if bull else 'below'} the break candle's "
                   f"{'high ' + fmt(s['breakHigh']) if bull else 'low ' + fmt(s['breakLow'])}")
            if not ok:
                out.append(event("skip", f"{name} {'pullback' if pull else 'continuation'} at {hm(now)} but filters "
                                          f"fail now: {checks_text(checks)}", setupName=name, checks=checks, **base))
                continue
            why = entry_block(state, now, block)
            if why:
                out.append(event("skip", f"{name} {'pullback' if pull else 'continuation'} at {hm(now)} but no entry: "
                                          f"{why}", setupName=name, **base))
                if v != "D":
                    del setups[slot]
                continue
            nxt = next_slot(slot)
            target = L.get(nxt) if nxt else None
            target = None if target is None else target - buf if bull else target + buf
            if no_room(side, c["close"], target):
                out.append(event("skip", f"{name} {'pullback' if pull else 'continuation'} at {hm(now)} but "
                                          f"{no_room_text(c['close'], target, side, nxt)}", setupName=name, **base))
                if v != "D":
                    del setups[slot]
                continue
            reason = (f"{name} [{v}]: break {s['breakText']}; {how}. Filters now: {checks_text(checks)}")
            out.append(_enter(state, side, name, target, "below" if bull else "above",
                              lvl - buf if bull else lvl + buf, reason, c, now, {**base, "checks": checks, "variant": v}))
            del setups[slot]
            entered = True
            continue
        if v != "D" and s["count"] >= cfg.PULLBACK_CANDLES:
            del setups[slot]
            out.append(event("expire", f"{name} expired: no entry within {cfg.PULLBACK_CANDLES} candles", setupName=name,
                             **base))

    # new breaks: R1 / S1 (B, C); every ladder level (D)
    for side, slots in LADDER.items():
        bull = side == "CE"
        for slot in (slots if v == "D" else slots[:1]):
            lvl = L.get(slot)
            if lvl is None or slot in setups or not armed.get(slot, True):
                continue
            if not ((bull and c["close"] > lvl + buf) or (not bull and c["close"] < lvl - buf)):
                continue
            armed[slot] = False
            name = setup_name(side, slot)
            break_text = f"{candle} closed {'above' if bull else 'below'} {slot} {fmt(lvl)} {'+' if bull else '-'} {buf}"
            if v != "D" and (setups or state["open"] or entered):
                why = "setup armed" if setups else "position open"
                out.append(event("skip", f"{name} break ignored ({why}): {break_text}", setupName=name, **base))
                continue
            ok, checks = checks_by_side[side]
            setups[slot] = {"side": side, "slot": slot, "name": name, "level": lvl, "breakAt": hm(now), "count": 0,
                            "breakHigh": c["high"], "breakLow": c["low"], "breakText": break_text}
            until = ("until a close back through it" if v == "D" else f"for up to {cfg.PULLBACK_CANDLES} candles")
            extra = (f"; continuation after {cfg.CONTINUATION_AFTER} candles beyond the break candle's "
                     f"{'high' if bull else 'low'}" if v == "C" else "")
            out.append(event("armed", f"{name} armed [{v}]: {break_text}. Filters now: {checks_text(checks)}. "
                                      f"Re-checked every candle {until}; entry on a pullback to {slot} while they pass"
                                      f"{extra}", setupName=name, checks=checks, **base))

    if not entered and not had_setup and not setups and not state["open"]:
        _range(state, c, now, filters, block, candle, base, out)
    return out


# ---------------------------------------------------------------- ticks
def on_tick(state, spot, ltp, ltp_high=None):
    """Live spot / option price: target zone reached, premium target or premium stop, whichever comes first.
    Returns an exit action or None. ltp_high: the minute's high premium in a replay (live: the LTP itself)."""
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
    high = ltp if ltp_high is None else ltp_high
    if entry and high is not None and high >= entry * (1 + cfg.PREMIUM_TARGET_PCT / 100):
        o["exiting"] = True
        return {"type": "exit", "reason": f"Premium target: LTP {fmt(high)} >= entry {fmt(entry)} + "
                                          f"{cfg.PREMIUM_TARGET_PCT:g}%", "data": {"ltp": high}}
    if entry and ltp is not None and ltp <= entry * (1 - cfg.PREMIUM_STOP_PCT / 100):
        o["exiting"] = True
        return {"type": "exit", "reason": f"Premium stop: LTP {fmt(ltp)} <= entry {fmt(entry)} - {cfg.PREMIUM_STOP_PCT:g}%",
                "data": {"ltp": ltp}}
    return None
