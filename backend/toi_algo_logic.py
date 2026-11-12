"""
toi_algo_logic.py - the Trending OI Algo's rules (docs/strategies/trending-oi-algo.md) as a state machine. Pure: no
clock, no I/O, no orders. The runner (toi_algo_service.py) feeds it closed index candles (3 minutes by default) and index ticks with
their indicator values, and carries out the actions it returns; every decision also comes back as an event for the
decision log. `s` is the settings dict (trending_oi_algo_config.merged); NIFTY only.

State (a plain dict stored as JSON, so a restart resumes exactly where it was):
  day, levels {"R1".."S3"} locked at 09:30, trades (entries today), stopped ["CE" | "PE"] (directions whose stop loss
  was hit today: no new entry that way), noTrade (the current no-trade reason or None = clear, logged when it
  changes; the day's first verdict is always logged), direction
  (the last direction verdict, for the page), open (the open trade or None), closed (today's closed trades).
Open trade: {side, lots, entrySpot, entryAt, stop: {"dir", "price"}, initialStop, risk (index points to the stop),
  targets [partial-exit levels], partials (done), breakeven / trailing (flags), adds {"avg", "pyr"}, extreme (highest high
  (CE) / lowest low (PE) since the entry), swing (a new swing high / low waiting for its pullback), strike?, avg?}.
  The runner fills strike / avg once the paper order fills (on_filled), or undoes the entry (on_entry_failed); adds and
  partial exits are pending until their fills come back (on_add_filled / on_partial_filled).

Adds (rules 7-11), on a closed candle that holds (rule 3) while Trending OI still gives this direction, before the first
partial exit and inside the entry hours: averaging when the index is on the losing side of the entry (+avgAddLots up to
avgMaxLots), pyramiding after a new swing high / low since the entry (+pyrAddLots up to pyrMaxLots), never past maxLots,
and only when the loss if the stop hits now (new lots included) stays within addRiskMax.
Exits (rules 12-15): partial exits at the targets (ticks), then breakeven on the option average (ticks) and the
Supertrend trail (closed candles); with no target, breakeven + trail once the index is breakevenAtR x risk in favour.
The stop loss and the 15:15 square-off exit everything.
"""
from datetime import datetime, timedelta

from trending_oi_algo_config import hhmm

SIDE_OF = {"Bullish": "CE", "Bearish": "PE"}


def new_state(day):
    return {"day": day, "levels": None, "levelsAt": None, "trades": 0, "stopped": [], "noTrade": "not checked yet",
            "direction": None, "open": None, "closed": []}


def event(kind, message, **data):
    return {"type": "event", "kind": kind, "message": message, "data": data}


def action(do, **data):
    return {"type": "action", "do": do, **data}


def fmt(x):
    return "-" if x is None else f"{x:,.2f}".rstrip("0").rstrip(".")


def strength_dots(pct):
    """Dots on the Trending OI strength pill (trending-oi/logic/api.ts strengthDots): >=60 3, >=40 2, >=20 1."""
    a = abs(pct)
    return 3 if a >= 60 else 2 if a >= 40 else 1 if a >= 20 else 0


def _ts(row):
    return datetime.fromisoformat(row["ts"].replace(" ", "T"))


# ---------------------------------------------------------------- rule 1 / 2: direction, no-trade filters
def direction(rows, now, s):
    """rows: today's Trending OI rows (calc.py) of the candle timeframe, oldest first. Returns {"side": "CE" | "PE" | None,
    "sentiment", "strength", "dots", "flipAt": "HH:MM" | None, "reason": "" | why there is no direction}."""
    if not rows:
        return {"side": None, "sentiment": None, "strength": None, "dots": 0, "flipAt": None, "reason": "no Trending OI data yet"}
    last = rows[-1]
    strength, sentiment = float(last["strengthPct"]), last["sentiment"]
    dots = strength_dots(strength)
    flip_at = None
    for prev, row in zip(rows, rows[1:]):
        if row["sentiment"] != prev["sentiment"]:
            flip_at = _ts(row)
    out = {"side": None, "sentiment": sentiment, "strength": round(strength, 2), "dots": dots,
           "flipAt": flip_at.strftime("%H:%M") if flip_at else None, "reason": ""}
    naive_now = now.replace(tzinfo=None)
    if abs(strength) < s["toiStrengthMin"] or dots < s["toiDotsMin"]:
        out["reason"] = f"unclear: Trending OI {sentiment} {abs(strength):.1f}% with {dots} dot(s) (need >= {s['toiStrengthMin']:g}% and {s['toiDotsMin']} dots)"
    elif flip_at and naive_now - flip_at < timedelta(minutes=s["flipLookbackMin"]):
        out["reason"] = f"unclear: Trending OI turned {sentiment} at {out['flipAt']} (less than {s['flipLookbackMin']} min ago)"
    else:
        out["side"] = SIDE_OF.get(sentiment)
    return out


def no_trade_reasons(side, c, s):
    """Weak day and over-extended checks for a direction. c: {now, spot, vwap, rsi, dayLow, dayHigh}. [] = clear."""
    out = []
    if c["vwap"] is None or c.get("st") is None or c["rsi"] is None:
        out.append("indicators not ready (Supertrend / VWAP / RSI)")
        return out
    spot = c["spot"]
    if c["now"].time() >= hhmm(s["weakDayFrom"]) and c["dayLow"] is not None:
        rng = (c["dayHigh"] - c["dayLow"]) / spot * 100
        if rng < s["weakDayRangePct"]:
            out.append(f"weak day: range {fmt(c['dayHigh'] - c['dayLow'])} pts = {rng:.2f}% of spot (< {s['weakDayRangePct']:g}%)")
    dist = abs(spot - c["vwap"]) / spot * 100
    if dist > s["maxVwapDistPct"]:
        out.append(f"over-extended: {dist:.2f}% from VWAP {fmt(c['vwap'])} (> {s['maxVwapDistPct']:g}%)")
    if side == "CE" and c["rsi"] > s["rsiMaxCE"]:
        out.append(f"over-extended: RSI {c['rsi']:.1f} > {s['rsiMaxCE']:g} for CE")
    if side == "PE" and c["rsi"] < s["rsiMinPE"]:
        out.append(f"over-extended: RSI {c['rsi']:.1f} < {s['rsiMinPE']:g} for PE")
    return out


# ---------------------------------------------------------------- rule 3: the pullback that holds
def holds(side, candle, st, vwap, touch):
    """CE: the candle's low came within `touch` points of Supertrend or VWAP (or through it) and it closed above both.
    PE mirrors with the high and below both. Returns (bool, which level was touched or '')."""
    st_v = st["value"]
    if side == "CE":
        near = [n for n, lv in (("Supertrend", st_v), ("VWAP", vwap)) if candle["low"] <= lv + touch]
        ok = bool(near) and candle["close"] > st_v and candle["close"] > vwap
    else:
        near = [n for n, lv in (("Supertrend", st_v), ("VWAP", vwap)) if candle["high"] >= lv - touch]
        ok = bool(near) and candle["close"] < st_v and candle["close"] < vwap
    return ok, " / ".join(near)


# ---------------------------------------------------------------- rule 4: strike
def strike_ladder(strikes, spot, side, order=("1ITM", "ATM", "2ITM")):
    """[(label, strike)] in the order to try: 1 ITM (CE one strike below ATM, PE one above), then the fallbacks."""
    ks = sorted(strikes)
    if not ks:
        return []
    atm = min(ks, key=lambda k: (abs(k - spot), k))
    i = ks.index(atm)
    step = -1 if side == "CE" else 1  # in the money: CE below spot, PE above
    pick = {"ATM": i, "1ITM": i + step, "2ITM": i + 2 * step}
    return [(lb, ks[j]) for lb, j in ((lb, pick[lb]) for lb in order) if 0 <= j < len(ks)]


def choose_strike(strikes, spot, side, why_not, fallback=("ATM", "2ITM")):
    """The first liquid strike of 1 ITM, then `fallback` (why_not(strike) = '' when liquid, else the reason).
    Returns (label, strike, note) or (None, None, why none)."""
    tried = []
    for label, k in strike_ladder(strikes, spot, side, ("1ITM", *fallback)):
        why = why_not(k)
        if not why:
            note = "" if label == "1ITM" else f"1 ITM not liquid ({'; '.join(tried)}): using {label} {fmt(k)} {side}"
            return label, k, note
        tried.append(f"{fmt(k)} {side} {why}")
    return None, None, "no liquid strike: " + "; ".join(tried) if tried else "no strikes"


# ---------------------------------------------------------------- the candle step
def on_candle(state, c, s):
    """A closed candle. c: {now (candle close, IST), candle, spot (= close), st {"value", "up"} | None,
    vwap (index terms) | None, rsi | None, rows (today's Trending OI rows), dayLow, dayHigh, dayPnl, capital,
    stale (feed stale: no entries)}. Returns events and actions."""
    out = []
    d = direction(c["rows"], c["now"], s)
    state["direction"] = {k: d[k] for k in ("side", "sentiment", "strength", "dots", "flipAt")}
    side = d["side"]
    reasons = [d["reason"]] if d["reason"] else no_trade_reasons(side, c, s)
    reason = "; ".join(reasons) or None
    if reason != state["noTrade"]:
        out.append(event("noTrade" if reason else "clear", f"No trade: {reason}" if reason
                         else f"Conditions clear: {d['sentiment']} {abs(d['strength']):.1f}% ({d['dots']} dots) -> {side} only"))
        state["noTrade"] = reason
    if state["open"]:
        return out + open_candle(state, c, d, s)
    if not side or reason:
        return out
    ok, near = holds(side, c["candle"], c["st"], c["vwap"], s["touchPts"])
    if not ok:
        return out
    what = (f"{side} pullback held at {near}: low {fmt(c['candle']['low'])} high {fmt(c['candle']['high'])}, "
            f"close {fmt(c['candle']['close'])} vs Supertrend {fmt(c['st']['value'])} / VWAP {fmt(c['vwap'])}")
    gate = entry_gate(state, side, c, s)
    if gate:
        out.append(event("skip", f"{what}; no entry: {gate}", side=side))
        return out
    stop = c["dayLow"] if side == "CE" else c["dayHigh"]
    dist = abs(c["spot"] - stop)
    if dist / c["spot"] * 100 > s["maxStopPct"]:
        out.append(event("skip", f"{what}; no entry: stop at the day {'low' if side == 'CE' else 'high'} {fmt(stop)} is "
                                 f"{fmt(dist)} pts = {dist / c['spot'] * 100:.2f}% away (> {s['maxStopPct']:g}%)", side=side))
        return out
    stop_dir = "below" if side == "CE" else "above"
    targets = partial_targets(state.get("levels"), side, c["spot"], s["partialMinPts"])
    state["open"] = {"side": side, "lots": s["entryLots"], "entrySpot": c["spot"], "entryAt": c["now"].strftime("%H:%M"),
                     "stop": {"dir": stop_dir, "price": stop}, "initialStop": stop, "risk": dist, "targets": targets,
                     "partials": 0, "breakeven": False, "trailing": False, "adds": {"avg": 0, "pyr": 0},
                     "extreme": c["candle"]["high"] if side == "CE" else c["candle"]["low"], "swing": False}
    state["trades"] += 1
    tgt = (" / ".join(f"{n} {fmt(v)}" for n, v in targets) if targets
           else f"none {s['partialMinPts']:g}+ pts beyond: breakeven at {s['breakevenAtR']:g}R")
    out.append(event("entry", f"{what}; enter {side} {s['entryLots']} lots at the next open, stop: index {stop_dir} "
                              f"{fmt(stop)} ({fmt(dist)} pts); partial exits: {tgt}", side=side))
    out.append(action("enter", side=side, lots=s["entryLots"], spot=c["spot"], stop=state["open"]["stop"]))
    return out


def entry_gate(state, side, c, s):
    """Why no new entry now ('' = allowed): the kill switch, entry hours, trades today, a stopped direction, the day
    loss, the feed."""
    if c.get("halted"):
        return "stopped by the kill switch"
    t = c["now"].time()
    if not hhmm(s["entryFrom"]) <= t <= hhmm(s["entryTo"]):
        return f"entries only {s['entryFrom']}-{s['entryTo']}"
    if state["trades"] >= s["maxTrades"]:
        return f"{s['maxTrades']} trades already today"
    if side in state["stopped"]:
        return f"the {side} stop loss was hit today: no new {side} entry"
    limit = s["dayLossStopPct"] / 100 * c["capital"]
    if c["dayPnl"] <= -limit:
        return f"day loss {fmt(c['dayPnl'])} reached -{s['dayLossStopPct']:g}% of capital"
    if c.get("stale"):
        return "live feed stale"
    return ""


# ---------------------------------------------------------------- rule 12: partial-exit targets
def partial_targets(levels, side, entry, min_pts):
    """The first two locked levels beyond the entry in the trade direction (CE: R levels above, PE: S levels below),
    counting only those at least min_pts beyond it: [("R1", 23300.0), ...] nearest first."""
    if not levels:
        return []
    if side == "CE":
        lv = sorted((v, n) for n, v in levels.items() if n.startswith("R") and v is not None and v >= entry + min_pts)
    else:
        lv = sorted(((v, n) for n, v in levels.items() if n.startswith("S") and v is not None and v <= entry - min_pts),
                    reverse=True)
    return [(n, v) for v, n in lv[:2]]


def favour(side, spot, ref):
    """Index points in the trade's favour from ref."""
    return spot - ref if side == "CE" else ref - spot


# ---------------------------------------------------------------- rules 7-11: adds (closed candles)
def open_candle(state, c, d, s):
    """A closed candle while a trade is open: the Supertrend trail, then an add on a pullback that holds.
    c also carries optionLtp, delta and lotSize (the open strike's, for the risk guard)."""
    o = state["open"]
    if o.get("exiting") or o.get("partialPending") or o.get("adding"):
        return []
    side, cd, st = o["side"], c["candle"], c["st"]
    if o["trailing"] and st and (cd["close"] < st["value"] if side == "CE" else cd["close"] > st["value"]):
        return _exit_all(o, f"Supertrend trail: close {fmt(cd['close'])} {'below' if side == 'CE' else 'above'} "
                            f"Supertrend {fmt(st['value'])}: exit the last {o['lots']} lots", "Supertrend trail", c["spot"])
    out = []
    swing_before = o["swing"]
    new_extreme = cd["high"] > o["extreme"] if side == "CE" else cd["low"] < o["extreme"]
    if c["vwap"] is not None and st is not None:
        ok, near = holds(side, cd, st, c["vwap"], s["touchPts"])
        if ok:
            out += _maybe_add(state, c, d, s, near, swing_before)
    if new_extreme:
        o["extreme"] = cd["high"] if side == "CE" else cd["low"]
        o["swing"] = True
    return out


def _maybe_add(state, c, d, s, near, swing):
    o, side = state["open"], state["open"]["side"]
    against = favour(side, c["spot"], o["entrySpot"]) < 0
    kind = "avg" if against else "pyr" if swing else None
    if kind is None:
        return []  # in favour without a new swing high / low since the last add: nothing to add
    name = "Averaging" if kind == "avg" else "Pyramiding"
    add = s["avgAddLots"] if kind == "avg" else s["pyrAddLots"]
    cap = min(s["avgMaxLots"] if kind == "avg" else s["pyrMaxLots"], s["maxLots"])
    head = f"{name} pullback held at {near} (close {fmt(c['candle']['close'])})"
    why = ""
    if c.get("halted"):
        why = "stopped by the kill switch"
    elif o["partials"]:
        why = "no adds after a partial exit"
    elif d["side"] != side:
        why = f"Trending OI no longer supports {side} ({d['reason'] or d['sentiment']})"
    elif not hhmm(s["entryFrom"]) <= c["now"].time() <= hhmm(s["entryTo"]):
        why = f"adds only {s['entryFrom']}-{s['entryTo']}"
    elif o["lots"] + add > cap:
        why = f"{o['lots']} lots open + {add} would pass the {cap}-lot {name.lower()} cap"
    elif o.get("avg") is None or c.get("optionLtp") is None:
        why = "no option price yet"
    else:
        loss = loss_at_stop(o, c["optionLtp"], c.get("delta") or s["deltaFallback"], c["spot"], add, c.get("lotSize") or 65)
        if loss > s["addRiskMax"]:
            why = f"risk guard: loss if the stop hits now would be {fmt(round(loss))} (> {fmt(s['addRiskMax'])})"
    if kind == "pyr":
        o["swing"] = False  # this swing's pullback is used, added or not
    if why:
        return [event("skip", f"{head}; no add: {why}", side=side)]
    o["adding"] = kind
    return [event("add", f"{head}: add {add} lot{'s' if add > 1 else ''} ({name.lower()}) -> {o['lots'] + add} lots; "
                         f"stop stays {o['stop']['dir']} {fmt(o['stop']['price'])}", side=side),
            action("add", side=side, lots=add, kind=kind, spot=c["spot"])]


def loss_at_stop(o, ltp, delta, spot, add_lots, lot_size):
    """Rupees lost if the stop hits now, the add included: option price at the stop = LTP - |delta| x (index points to
    the stop), at least 0.05; loss = (average after the add - that price) x quantity after the add."""
    to_stop = abs(spot - o["stop"]["price"])
    at_stop = max(0.05, ltp - abs(delta) * to_stop)
    qty_now, qty_add = o["lots"] * lot_size, add_lots * lot_size
    avg_after = (o["avg"] * qty_now + ltp * qty_add) / (qty_now + qty_add)
    return (avg_after - at_stop) * (qty_now + qty_add)


# ---------------------------------------------------------------- ticks: stop, partial exits, breakeven, 15:15
def on_tick(state, spot, now, s, option_ltp=None):
    """Index tick (with the open option's LTP): square-off, stop loss, the breakeven exit, partial exits, the 1R
    breakeven."""
    o = state["open"]
    if not o or o.get("exiting"):
        return []
    side = o["side"]
    if now.time() >= hhmm(s["squareOff"]):
        return _exit_all(o, f"{s['squareOff']} square-off: exit all {o['lots']} lots", "square-off", spot)
    st = o["stop"]
    if st["dir"] == "below" and spot < st["price"] or st["dir"] == "above" and spot > st["price"]:
        if side not in state["stopped"]:
            state["stopped"].append(side)
        return _exit_all(o, f"Stop loss: index {fmt(spot)} {st['dir']} {fmt(st['price'])}: exit all {o['lots']} lots",
                         "stop loss", spot)
    if o["breakeven"] and option_ltp is not None and o.get("avg") is not None and option_ltp <= o["avg"]:
        return _exit_all(o, f"Breakeven: option {fmt(option_ltp)} back to the average {fmt(o['avg'])}: exit the last "
                            f"{o['lots']} lots", "breakeven", spot)
    if o.get("partialPending") or o.get("adding"):
        return []
    if o["partials"] < len(o["targets"]):
        name, level = o["targets"][o["partials"]]
        if favour(side, spot, level) >= 0:
            n = max(1, o["lots"] // 2)
            if n >= o["lots"]:  # half of the last lot is the last lot: an ordinary exit closes the trade
                return _exit_all(o, f"{name} {fmt(level)} reached (index {fmt(spot)}): exit the last {o['lots']} lot",
                                 f"{name} partial", spot)
            o["partialPending"] = n
            first = o["partials"] == 0
            return [event("partial", f"{name} {fmt(level)} reached (index {fmt(spot)}): sell {n} of {o['lots']} lots"
                                     + ("; the stop for the rest moves to breakeven, then the Supertrend trail" if first else ""),
                          side=side),
                    action("partial", side=side, lots=n, level=name, spot=spot)]
    elif not o["targets"] and not o["breakeven"] and favour(side, spot, o["entrySpot"]) >= s["breakevenAtR"] * o["risk"]:
        o["breakeven"] = o["trailing"] = True
        return [event("stopMove", f"{s['breakevenAtR']:g}R in favour (index {fmt(spot)}, R = {fmt(o['risk'])} pts) with no "
                                  f"level to book: stop to breakeven {fmt(o.get('avg'))}, then the Supertrend trail", side=side)]
    return []


def _exit_all(o, message, reason, spot):
    o["exiting"] = True
    return [event("exit", message, side=o["side"]),
            action("exit", side=o["side"], lots=o["lots"], reason=reason, spot=spot)]


def on_filled(state, strike, security_id, avg, note=""):
    o = state["open"]
    o.update(strike=strike, securityId=security_id, avg=avg)
    return [event("info", f"Entry filled: {o['lots']} lots {fmt(strike)} {o['side']} @ {fmt(avg)}" + (f" ({note})" if note else ""),
                  side=o["side"])]


def on_add_filled(state, lots, price):
    o = state["open"]
    kind = o.pop("adding")
    qty_old = o["lots"]
    o["avg"] = round((o["avg"] * qty_old + price * lots) / (qty_old + lots), 4)
    o["lots"] += lots
    o["adds"][kind] += 1
    return [event("info", f"Add filled: {lots} lot{'s' if lots > 1 else ''} @ {fmt(price)}; {o['lots']} lots, average "
                          f"{fmt(o['avg'])}", side=o["side"])]


def on_add_failed(state, why):
    o = state["open"]
    o.pop("adding", None)
    return [event("skip", f"Add not placed: {why}", side=o["side"])]


def on_partial_filled(state, lots, price, pnl):
    """Sold `lots` at a partial exit. The first one moves the stop to breakeven and starts the Supertrend trail."""
    o = state["open"]
    o.pop("partialPending", None)
    o["lots"] -= lots
    o["partials"] += 1
    o["booked"] = round(o.get("booked", 0.0) + pnl, 2)
    o["breakeven"] = o["trailing"] = True
    return [event("info", f"Partial exit filled: {lots} lot{'s' if lots > 1 else ''} @ {fmt(price)} ({fmt(pnl)}); "
                          f"{o['lots']} lots left, stop at breakeven {fmt(o['avg'])}", side=o["side"])]


def on_partial_failed(state, why):
    o = state["open"]
    o.pop("partialPending", None)
    return [event("skip", f"Partial exit not filled: {why} (tried again on the next tick)", side=o["side"])]


def on_entry_failed(state, why):
    """The paper order could not fill (no liquid strike, no depth, funds): the entry is undone and not counted."""
    o = state["open"]
    state["open"] = None
    state["trades"] = max(0, state["trades"] - 1)
    return [event("skip", f"Entry not placed: {why}", side=o["side"] if o else None)]


def on_exited(state, exit_spot, pnl, now):
    """The runner sold every open lot: the trade is closed."""
    o = state["open"]
    state["open"] = None
    state["closed"].append({**{k: v for k, v in o.items() if k != "exiting"}, "exitSpot": exit_spot, "pnl": pnl,
                            "exitAt": now.strftime("%H:%M")})
    return [event("info", f"Trade closed: {o['side']} P&L {fmt(pnl)}", side=o["side"])]
