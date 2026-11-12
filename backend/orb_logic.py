"""
orb_logic.py - the ORB Algo's rules (docs/strategies/orb.md), pure: no I/O, no clock, no orders. PAPER TRADING ONLY.

orb_service.py feeds it closed NIFTY 1-minute candles (and the 15:25 time); it returns events (the decision log) and
actions (enter / exit), which the service turns into paper orders and answers with on_filled / on_entry_failed /
on_exited. orb_replay.py runs the same rules over Dhan's history in spot points.

Three independent setups, each at most one trade a day, each with its own opening range (OR) from 09:15:
  b60  "60m Breakout"  OR 60 min, size > orSizePct of the day's open; a close above the OR high -> long (below the low
                       -> short); the signal candle starts before entryBefore (12:00). Stop: the other side.
  r30  "30m Retest"    OR 30 min, size <= orSizePct; the first close beyond a side, a close back inside, then a close
                       beyond the SAME side again within retestWithinMin (60) of the first breakout. Stop: the other side.
  v5   "5m Reversal"   OR 5 min; the first close beyond a side, a close back inside, then a close beyond the OTHER side
                       -> enter that way (stop: the first side); the signal candle starts before entryBefore.
Stops trigger on a 1-minute CLOSE beyond the stop level. No target. Every open trade is sold at squareOff (15:25).
Long = buy CE, short = buy PE (1 ITM). Each trade records its entry / exit index levels and the spot points.

state (JSON, saved after every change):
  day, dayOpen, lastMinute (epoch start of the newest candle evaluated), trades, halted (kill switch),
  ors {"5" | "30" | "60": {minutes, high, low, sizePct, done}},
  setups {key: {key, name, orMin, status: waiting | armed | in trade | done | filtered | off, reason, first, inside,
                open: trade | None}},
  closed [trade]   trade: {setup, name, dir, side, strike, securityId, lots, entryAt, entrySpot, entryPrice, stop,
                           exitAt, exitSpot, exitPrice, exitReason, points, pnl, charges}
"""
from datetime import datetime, timedelta

from orb_config import SETUPS, hhmm
from store import IST

OPEN_MIN = 9 * 60 + 15


def fmt(x):
    if x is None:
        return "–"
    return f"{x:,.2f}".rstrip("0").rstrip(".")


def event(kind, message, setup="", side=None):
    return {"type": "event", "kind": kind, "message": message, "data": {"setup": setup, "side": side}}


def action(do, **kw):
    return {"type": "action", "do": do, **kw}


def new_state(day):
    return {"day": day, "dayOpen": None, "lastMinute": 0, "trades": 0, "halted": False,
            "ors": {str(n): {"minutes": n, "high": None, "low": None, "sizePct": None, "done": False} for n in (5, 30, 60)},
            "setups": {k: {"key": k, "name": name, "orMin": n, "status": "waiting", "reason": f"{n}-minute OR forming",
                           "first": None, "inside": False, "open": None} for k, (name, n) in SETUPS.items()},
            "closed": []}


def minute_of(epoch_start):
    """Minutes since 09:15 of a candle start, and its IST datetime."""
    t = datetime.fromtimestamp(epoch_start, IST)
    return t.hour * 60 + t.minute - OPEN_MIN, t


def side_of(direction):
    return "CE" if direction == "long" else "PE"


def size_ok(key, size_pct, s):
    """The OR size filter of a setup: (passes, why)."""
    lim = s["orSizePct"]
    if key == "b60":
        return size_pct > lim, f"OR size {size_pct:.2f}% {'>' if size_pct > lim else '<='} {lim:g}% of the open"
    if key == "r30":
        return size_pct <= lim, f"OR size {size_pct:.2f}% {'<=' if size_pct <= lim else '>'} {lim:g}% of the open"
    return True, f"OR size {size_pct:.2f}% (no size filter)"


def _or_step(state, c, mins, out):
    """Extends the ORs with the candle (when inside them) and closes the ones that end with it."""
    for key, o in state["ors"].items():
        if o["done"]:
            continue
        n = o["minutes"]
        if mins < n:
            o["high"] = c["high"] if o["high"] is None else max(o["high"], c["high"])
            o["low"] = c["low"] if o["low"] is None else min(o["low"], c["low"])
        if mins >= n - 1 and o["high"] is not None:
            o["done"] = True
            o["sizePct"] = round((o["high"] - o["low"]) / state["dayOpen"] * 100, 3) if state["dayOpen"] else None
            out.append(event("or", f"{n}m OR locked: high {fmt(o['high'])}, low {fmt(o['low'])}, size "
                                   f"{fmt(o['high'] - o['low'])} pts = {o['sizePct']:.2f}% of the open {fmt(state['dayOpen'])}"))


def on_minute(state, c, s, ctx):
    """A closed 1-minute NIFTY candle {time (start, epoch), open, high, low, close}.
    ctx: {live: entries allowed (False while catching up), stale, dayPnl, capital}. Returns events and actions."""
    out = []
    mins, start = minute_of(c["time"])
    if mins < 0 or c["time"] <= state.get("lastMinute", 0):
        return out
    state["lastMinute"] = c["time"]
    if state["dayOpen"] is None:
        state["dayOpen"] = c["open"]
        out.append(event("info", f"Day's open {fmt(c['open'])} (the {start:%H:%M} candle)"))
    _or_step(state, c, mins, out)
    close, hm = c["close"], start.strftime("%H:%M")
    for k, st in state["setups"].items():
        o = st["open"]
        if o:
            if not o.get("exiting") and not o.get("pending") and (
                    (o["dir"] == "long" and close < o["stop"]) or (o["dir"] == "short" and close > o["stop"])):
                o["exiting"] = True
                why = f"Stop: the {hm} candle closed {fmt(close)} {'below' if o['dir'] == 'long' else 'above'} {fmt(o['stop'])}"
                out += [event("exit", f"{st['name']}: {why}; exit {o['side']}", k, o["side"]),
                        action("exit", setup=k, reason=why, spot=close)]
            continue
        if st["status"] in ("done", "filtered", "off"):
            continue
        orr = state["ors"][str(st["orMin"])]
        if not orr["done"]:
            continue
        if not s[f"{k}On"]:
            st["status"], st["reason"] = "off", "switched off in Settings"
            out.append(event("skip", f"{st['name']}: switched off in Settings", k))
            continue
        if st["status"] == "waiting":
            ok, why = size_ok(k, orr["sizePct"], s)
            if not ok:
                st["status"], st["reason"] = "filtered", why
                out.append(event("skip", f"{st['name']}: filtered out, {why}", k))
                continue
            st["status"], st["reason"] = "armed", f"{why}; watching for a close beyond {fmt(orr['low'])} / {fmt(orr['high'])}"
            out.append(event("signal", f"{st['name']}: armed, {st['reason']}", k))
        if mins < st["orMin"]:  # the candle that locked the OR is not a signal candle
            continue
        sig = _setup_step(k, st, orr, c, start, s, out)
        if sig:
            out += _enter(state, k, st, sig, c, start, s, ctx)
    return out


def _setup_step(k, st, orr, c, start, s, out):
    """The setup's state machine on one candle. Returns the entry signal {dir, stop, why} or None."""
    hi, lo, close, hm = orr["high"], orr["low"], c["close"], start.strftime("%H:%M")
    beyond = "high" if close > hi else "low" if close < lo else None
    before = start.time() < hhmm(s["entryBefore"])
    if k == "b60":
        if not before:
            st["status"], st["reason"] = "done", f"no breakout before {s['entryBefore']}"
            out.append(event("skip", f"{st['name']}: {st['reason']}", k))
            return None
        if beyond:
            d = "long" if beyond == "high" else "short"
            return {"dir": d, "stop": lo if d == "long" else hi,
                    "why": f"the {hm} candle closed {fmt(close)} {'above the OR high' if d == 'long' else 'below the OR low'} "
                           f"{fmt(hi if d == 'long' else lo)}"}
        return None
    if k == "v5" and not before:
        st["status"], st["reason"] = "done", f"no reversal before {s['entryBefore']}"
        out.append(event("skip", f"{st['name']}: {st['reason']}", k))
        return None
    first = st["first"]
    if first is None:
        if beyond:
            st["first"] = {"side": beyond, "time": c["time"], "at": hm}
            st["reason"] = (f"first breakout {'above' if beyond == 'high' else 'below'} the OR at {hm} (close {fmt(close)}); "
                            "waiting for a close back inside")
            out.append(event("signal", f"{st['name']}: {st['reason']}", k))
        return None
    if k == "r30":
        elapsed = (c["time"] - first["time"]) / 60
        if elapsed > s["retestWithinMin"]:
            st["status"], st["reason"] = "done", f"no retest within {s['retestWithinMin']} min of the {first['at']} breakout"
            out.append(event("skip", f"{st['name']}: {st['reason']}", k))
            return None
    if not st["inside"]:
        if beyond is None:
            st["inside"] = True
            want = first["side"] if k == "r30" else ("low" if first["side"] == "high" else "high")
            st["reason"] = (f"closed back inside at {hm} ({fmt(close)}); waiting for a close "
                            f"{'above' if want == 'high' else 'below'} {fmt(hi if want == 'high' else lo)}")
            out.append(event("signal", f"{st['name']}: {st['reason']}", k))
        return None
    if k == "r30" and beyond == first["side"]:
        d = "long" if beyond == "high" else "short"
        return {"dir": d, "stop": lo if d == "long" else hi,
                "why": f"retest: back inside, then the {hm} candle closed {fmt(close)} beyond the same side "
                       f"({fmt(hi if d == 'long' else lo)}), {int((c['time'] - first['time']) / 60)} min after the {first['at']} breakout"}
    if k == "v5" and beyond and beyond != first["side"]:
        d = "long" if beyond == "high" else "short"
        return {"dir": d, "stop": hi if first["side"] == "high" else lo,
                "why": f"reversal: broke {'above' if first['side'] == 'high' else 'below'} at {first['at']}, back inside, "
                       f"then the {hm} candle closed {fmt(close)} beyond the other side"}
    return None


def _enter(state, k, st, sig, c, start, s, ctx):
    hm, side = start.strftime("%H:%M"), side_of(sig["dir"])
    loss_cap = ctx.get("capital", 0) * s["dayLossStopPct"] / 100
    skip = None
    if not ctx.get("live", True):
        skip = f"missed: the algo was not running at {hm} (caught up from history, not traded)"
    elif state.get("halted"):
        skip = "skipped: stopped by the kill switch"
    elif ctx.get("stale"):
        skip = "skipped: the live feed is stale"
    elif loss_cap and (ctx.get("dayPnl") or 0) <= -loss_cap:
        skip = f"skipped: day loss {fmt(ctx.get('dayPnl'))} reached {s['dayLossStopPct']:g}% of capital"
    if skip:
        st["status"], st["reason"] = "done", f"{sig['why']}; {skip}"
        return [event("skip", f"{st['name']}: {st['reason']}", k, side)]
    end = start + timedelta(minutes=1)
    st["status"], st["reason"] = "in trade", sig["why"]
    st["open"] = {"setup": k, "name": st["name"], "dir": sig["dir"], "side": side, "lots": s["lots"], "pending": True,
                  "entryAt": end.strftime("%H:%M"), "entrySpot": c["close"], "stop": sig["stop"]}
    state["trades"] += 1
    return [event("entry", f"{st['name']}: {sig['why']} -> buy {side} {s['lots']} lot{'s' if s['lots'] != 1 else ''} "
                           f"(1 ITM); stop: a close {'below' if sig['dir'] == 'long' else 'above'} {fmt(sig['stop'])}", k, side),
            action("enter", setup=k, side=side, dir=sig["dir"], lots=s["lots"], spot=c["close"], stop=sig["stop"])]


# ---------------------------------------------------------------- answers from the service (orders)
def on_filled(state, k, strike, security_id, price, note=""):
    st = state["setups"][k]
    o = st["open"]
    o.pop("pending", None)
    o.update(strike=strike, securityId=security_id, entryPrice=price)
    return [event("info", f"{st['name']}: bought {o['lots']} lot{'s' if o['lots'] != 1 else ''} NIFTY {fmt(strike)} {o['side']} "
                          f"@ {fmt(price)}" + (f" ({note})" if note else ""), k, o["side"])]


def on_entry_failed(state, k, why):
    st = state["setups"][k]
    side = (st["open"] or {}).get("side")
    st["open"] = None
    st["status"], st["reason"] = "done", f"entry not placed: {why}"
    state["trades"] = max(0, state["trades"] - 1)
    return [event("skip", f"{st['name']}: entry not placed: {why}", k, side)]


def points(o, exit_spot):
    if exit_spot is None or o.get("entrySpot") is None:
        return None
    return round((exit_spot - o["entrySpot"]) * (1 if o["dir"] == "long" else -1), 2) + 0.0


def on_exited(state, k, exit_spot, price, pnl, charges, now, reason):
    st = state["setups"][k]
    o = st["open"]
    trade = {**{x: v for x, v in o.items() if x not in ("exiting", "pending")}, "exitAt": now.strftime("%H:%M"),
             "exitSpot": exit_spot, "exitPrice": price, "exitReason": reason, "points": points(o, exit_spot),
             "pnl": pnl, "charges": charges}
    state["closed"].append(trade)
    st["open"] = None
    st["status"], st["reason"] = "done", f"closed: {reason}"
    return [event("info", f"{st['name']}: sold {o['side']} @ {fmt(price)}, spot {fmt(exit_spot)} ({trade['points']:+.2f} pts), "
                          f"P&L {fmt(pnl)}. Why: {reason}", k, o["side"])]


def on_exit_failed(state, k, why):
    o = state["setups"][k]["open"]
    if o:
        o.pop("exiting", None)
    return [event("error", f"{state['setups'][k]['name']}: exit not filled ({why}); retrying", k, (o or {}).get("side"))]


def square_off(state, spot, now, s):
    """At squareOff: exit every open trade (those still being entered are left to the entry answer)."""
    out = []
    for k, st in state["setups"].items():
        o = st["open"]
        if o and not o.get("exiting") and not o.get("pending"):
            o["exiting"] = True
            why = f"{s['squareOff']} exit"
            out += [event("exit", f"{st['name']}: {why}", k, o["side"]), action("exit", setup=k, reason=why, spot=spot)]
    return out


def setup_view(state):
    """For the Overview: each OR and each setup's state."""
    return {"ors": state["ors"], "setups": state["setups"], "dayOpen": state["dayOpen"]}


def replay_day(candles, s):
    """The rules over one day of 1-minute candles (Dhan history), in spot points: entries fill at the signal close,
    stops at the stop candle's close, open trades at the close of the candle ending at squareOff. Returns the trades."""
    day = datetime.fromtimestamp(candles[0]["time"], IST).date().isoformat() if candles else ""
    state, last = new_state(day), None
    sq = hhmm(s["squareOff"])
    for c in sorted(candles, key=lambda x: x["time"]):
        mins, start = minute_of(c["time"])
        if mins < 0:
            continue
        end = start + timedelta(minutes=1)
        if end.time() >= sq:  # the candle closing at squareOff is not a signal: its close is the exit price
            last = (c, end) if start.time() < sq else last
            break
        for a in on_minute(state, c, s, {"live": True, "capital": 0}):
            if a["type"] != "action":
                continue
            if a["do"] == "enter":
                on_filled(state, a["setup"], None, None, None)
            else:
                on_exited(state, a["setup"], a["spot"], None, None, None, end, a["reason"])
        last = (c, end)
    if last:
        for k, st in state["setups"].items():
            if st["open"]:
                on_exited(state, k, last[0]["close"], None, None, None, last[1], f"{s['squareOff']} exit")
    return state["closed"]
