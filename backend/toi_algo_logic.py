"""
toi_algo_logic.py - the Trending OI Algo's rules (docs/strategies/trending-oi-algo.md) as a state machine. Pure: no
clock, no I/O, no orders. The runner (toi_algo_service.py) feeds it closed 5-minute index candles and index ticks with
their indicator values, and carries out the actions it returns; every decision also comes back as an event for the
decision log. `s` is the settings dict (trending_oi_algo_config.merged); NIFTY only.

State (a plain dict stored as JSON, so a restart resumes exactly where it was):
  day, levels {"R1".."S3"} locked at 09:30, trades (entries today), stopped ["CE" | "PE"] (directions whose stop loss
  was hit today: no new entry that way), noTrade (the current no-trade reason or None = clear, logged when it
  changes; the day's first verdict is always logged), direction
  (the last direction verdict, for the page), open (the open trade or None), closed (today's closed trades).
Open trade: {side, lots, entrySpot, entryAt, stop: {"dir": "below" | "above", "price"}, strike?, avg?} - the runner
  fills strike / avg once the paper order fills (on_filled), or undoes the entry (on_entry_failed).
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
    """rows: today's 5-minute Trending OI rows (calc.py), oldest first. Returns {"side": "CE" | "PE" | None,
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
    """A closed 5-minute candle. c: {now (candle close, IST), candle, spot (= close), st {"value", "up"} | None,
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
        return out  # adds and exits on candles: step 3
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
    state["open"] = {"side": side, "lots": s["entryLots"], "entrySpot": c["spot"], "entryAt": c["now"].strftime("%H:%M"),
                     "stop": {"dir": stop_dir, "price": stop}, "initialStop": stop, "risk": dist}
    state["trades"] += 1
    out.append(event("entry", f"{what}; enter {side} {s['entryLots']} lots at the next open, stop: index {stop_dir} "
                              f"{fmt(stop)} ({fmt(dist)} pts)", side=side))
    out.append(action("enter", side=side, lots=s["entryLots"], spot=c["spot"], stop=state["open"]["stop"]))
    return out


def entry_gate(state, side, c, s):
    """Why no new entry now ('' = allowed): entry hours, trades today, a stopped direction, the day loss, the feed."""
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


# ---------------------------------------------------------------- ticks, fills
def on_tick(state, spot, now):
    """Index tick: the stop loss (rule 6 / 14) exits every open lot."""
    o = state["open"]
    if not o or o.get("exiting"):
        return []
    st = o["stop"]
    if st["dir"] == "below" and spot < st["price"] or st["dir"] == "above" and spot > st["price"]:
        o["exiting"] = True
        if o["side"] not in state["stopped"]:
            state["stopped"].append(o["side"])
        return [event("exit", f"Stop loss: index {fmt(spot)} {st['dir']} {fmt(st['price'])}: exit all {o['lots']} lots",
                      side=o["side"]),
                action("exit", side=o["side"], lots=o["lots"], reason="stop loss", spot=spot)]
    return []


def on_filled(state, strike, security_id, avg, note=""):
    o = state["open"]
    o.update(strike=strike, securityId=security_id, avg=avg)
    return [event("info", f"Entry filled: {o['lots']} lots {fmt(strike)} {o['side']} @ {fmt(avg)}" + (f" ({note})" if note else ""),
                  side=o["side"])]


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
