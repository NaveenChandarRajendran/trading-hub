"""
backtest.py - 5-year backtest of the auto rules on Dhan's past data (owner, 25-Oct-2026). PAPER ANALYSIS ONLY: no
orders. Uses the SAME rule functions the live watcher uses (sig_rules.megabull_rule, sig_dharani_v2.dharani_v2_rule),
fed with past candles, so the backtest and the live auto trader read the rules identically.

Strategies
  MegaBull  4 Pillar (BANKNIFTY) and SuperTrend Nifty (NIFTY), 5-minute candles, ATM option, -10 % stop, +20 % target,
            time exit 15:14. Not in past data, so left out of the check: PCR (4 Pillar pillar 4), the OI-wall room
            filter and OI R1/S1 as trigger levels; cumulative delta is "not checked" live as well. VWAP uses the index's
            typical price per minute (equal weights) because past futures volume per minute is not available.
  Dharani   NIFTY and BANKNIFTY, 3-minute candles, all conditions; the put side reads the INDEX (live: futures; past
            futures minute data does not exist). Option premium nearest Rs 250 (NIFTY) / 500 (BANKNIFTY); -10 % safety
            stop; exit when a 3-minute candle closes back through SuperTrend; time exit 15:14.
  Trend     not backtested: its must-have (Trending OI 3 rows + Dhan OI view) needs the whole option chain's OI every
            minute, which past data does not give.
Fills: buy at the option's open in the minute the signal candle closes (live: ~35 s later); stop / target when a
minute's low / high crosses them (a gap fills at that minute's open); both in one minute = stop first. Costs: Dhan's
charges (paper_charges.py, today's rates) on both orders, plus slippage (default 0.5 % of premium per order). One lot
at today's lot size (NIFTY 65, BANKNIFTY 30) in every year, so years compare. Limits: 6 trades a day per rule and index.

Run (backend folder): python backtest.py download   then   python backtest.py run
Writes data/backtest/results.json and data/backtest/trades.csv.
"""
import csv
import json
import os
import sys
from datetime import date, datetime, timedelta

import bt_data
from paper_charges import order_charges
from sig_dharani_v2 import PREMIUM_NEAR, call_indicators, dharani_v2_exit, dharani_v2_rule, put_indicators
from sig_indicators import IST, cpr, pivots
from sig_market import indicators as indicators_5m
from sig_rules import NOT_CHECKED, PASS, megabull_rule

LOT = {"NIFTY": 65, "BANKNIFTY": 30}
SLIPPAGE = 0.005
MAX_TRADES_DAY = 6
TIME_EXIT = (15, 14)


# ------------------------------------------------------------------ candles
def bars_from_minutes(m, interval):
    """Index 1-minute arrays -> interval-minute candles aligned to 09:15 IST, per day. Volume: 1 per minute when the
    index has none, so VWAP becomes the day's average typical price."""
    out = []
    cur_key = None
    for i, t in enumerate(m["t"]):
        dt = datetime.fromtimestamp(t, IST)
        mins = dt.hour * 60 + dt.minute - 555
        if mins < 0 or dt.hour * 60 + dt.minute >= 930:
            continue
        start = int(dt.replace(hour=9, minute=15, second=0).timestamp()) + (mins // interval) * interval * 60
        key = (dt.date(), start)
        v = m["v"][i] or 1
        if key != cur_key:
            out.append({"time": start, "day": dt.date(), "open": m["o"][i], "high": m["h"][i], "low": m["l"][i], "close": m["c"][i], "volume": v})
            cur_key = key
        else:
            b = out[-1]
            b["high"], b["low"], b["close"], b["volume"] = max(b["high"], m["h"][i]), min(b["low"], m["l"][i]), m["c"][i], b["volume"] + v
    return out


def daily_hlc(bars):
    days = {}
    for b in bars:
        d = days.setdefault(b["day"], {"high": b["high"], "low": b["low"], "close": b["close"]})
        d["high"], d["low"], d["close"] = max(d["high"], b["high"]), min(d["low"], b["low"]), b["close"]
    return days


def minute_close_map(m):
    return dict(zip(m["t"], m["c"]))


# ------------------------------------------------------------------ fills
class Book:
    """Option fills for one symbol: fixed-strike prices rebuilt from the ATM-relative series."""

    def __init__(self, sym, prices=None):
        self.sym = sym
        self.prices = prices or bt_data.OptionPrices(sym)

    def pick(self, day, side, ts, premium_near=None):
        rows = self.prices.at(day, side, ts)
        if not rows:
            return None, None
        if premium_near is None:
            k = next((k for k, v in rows.items() if v[4] == 0), None)
            if k is None:
                return None, None
        else:
            k = min(rows, key=lambda s: (abs(rows[s][0] - premium_near), s))
        return k, rows[k][0]

    def bar(self, day, side, ts, strike):
        v = self.prices.at(day, side, ts).get(strike)
        return v[:4] if v else None


def cost(entry, exit_, qty, slip):
    buy_v, sell_v = entry * qty, exit_ * qty
    charges = order_charges("BUY", buy_v).total + order_charges("SELL", sell_v).total
    return charges, (buy_v + sell_v) * slip


def run_trade(book, day, side, strike, entry_ts, entry_px, qty, stop_pct, target_pct, signal_exit, slip, last_ts):
    """Walks minute by minute from entry. signal_exit(ts) -> reason or None (checked at each minute start).
    Returns the trade dict."""
    stop = entry_px * (1 - stop_pct)
    target = entry_px * (1 + target_pct) if target_pct else None
    hi = lo = entry_px
    ts, last_px = entry_ts, entry_px
    end_ts = int(datetime.combine(day, datetime.min.time()).replace(hour=TIME_EXIT[0], minute=TIME_EXIT[1], tzinfo=IST).timestamp())
    exit_px, reason, exit_ts = None, None, None
    while ts <= min(end_ts, last_ts):
        if ts > entry_ts:
            why = signal_exit(ts) if signal_exit else None
            if why:
                b = book.bar(day, side, ts, strike)
                exit_px, reason, exit_ts = (b[0] if b else last_px), why, ts
                break
        b = book.bar(day, side, ts, strike)
        if b:
            o, h, l, c = b
            if ts > entry_ts and o <= stop:
                exit_px, reason, exit_ts = o, "Stop (gap)", ts
                break
            if l <= stop:
                exit_px, reason, exit_ts = stop, "Stop", ts
                break
            if target and ts > entry_ts and o >= target:
                exit_px, reason, exit_ts = o, "Target (gap)", ts
                break
            if target and h >= target:
                exit_px, reason, exit_ts = target, "Target", ts
                break
            hi, lo, last_px = max(hi, h), min(lo, l), c
        ts += 60
    if exit_px is None:
        b = book.bar(day, side, min(end_ts, last_ts), strike)
        exit_px, reason, exit_ts = (b[0] if b else last_px), "Time", min(end_ts, last_ts)
    kind = reason.split(" ")[0] if reason.split(" ")[0] in ("Stop", "Target", "Time") else "Signal"
    gross = (exit_px - entry_px) * qty
    charges, slip_cost = cost(entry_px, exit_px, qty, slip)
    return {"exit_ts": exit_ts, "exit": round(exit_px, 2), "reason": reason, "kind": kind, "high": hi, "low": lo, "gross": round(gross, 2),
            "charges": round(charges, 2), "slippage": round(slip_cost, 2), "net": round(gross - charges - slip_cost, 2)}


# ------------------------------------------------------------------ strategies
def megabull_trades(sym, m, vix, book, slip=SLIPPAGE, log=None):
    bars = bars_from_minutes(m, 5)
    ind = indicators_5m(bars)
    days = daily_hlc(bars)
    order = sorted(days)
    prev = {order[k]: days[order[k - 1]] for k in range(1, len(order))}
    trades, busy_until, per_day = [], 0, {}
    last_ts_of_day = {}
    for t, b in zip(m["t"], m["c"]):
        d = datetime.fromtimestamp(t, IST).date()
        last_ts_of_day[d] = max(last_ts_of_day.get(d, 0), t)
    for i, bar in enumerate(bars):
        day = bar["day"]
        if day not in prev:
            continue
        close_ts = bar["time"] + 300
        ct = datetime.fromtimestamp(close_ts, IST)
        if close_ts <= busy_until:
            continue
        p = prev[day]
        state = {"symbol": sym, "bars": bars, "i": i, "ind": ind, "prev": p, "piv": pivots(p["high"], p["low"], p["close"]),
                 "sr": None, "vix": vix.get(close_ts - 60), "pcr": None, "hm": (ct.hour, ct.minute), "marketOpen": True,
                 "positions": {}, "signalTime": datetime.fromtimestamp(bar["time"], IST).strftime("%H:%M")}
        r = megabull_rule(state)
        ignore = {"room", "pillar4"} if r["setup"] == "4 Pillar" else {"room"}  # pillar4 = PCR only in 4 Pillar
        if not all(c["state"] == PASS or (c["state"] == NOT_CHECKED and c.get("exempt")) or c["id"] in ignore for c in r["checks"]):
            continue
        if r["blocked"] or per_day.get(day, 0) >= MAX_TRADES_DAY:
            continue
        strike, px = book.pick(day, r["side"], close_ts)
        if not px:
            continue
        res = run_trade(book, day, r["side"], strike, close_ts, px, LOT[sym], 0.10, 0.20, None, slip, last_ts_of_day.get(day, close_ts))
        trades.append({"strategy": "MegaBull " + r["setup"], "index": sym, "day": str(day), "signal": state["signalTime"],
                       "side": r["side"], "strike": strike, "entry": round(px, 2), "entry_ts": close_ts, **res})
        per_day[day] = per_day.get(day, 0) + 1
        busy_until = res["exit_ts"]
    return trades


def dharani_trades(sym, m, book, slip=SLIPPAGE):
    bars = bars_from_minutes(m, 3)
    ci, pi = call_indicators(bars), put_indicators(bars)
    days = daily_hlc(bars)
    order = sorted(days)
    prev = {order[k]: days[order[k - 1]] for k in range(1, len(order))}
    last_ts_of_day = {}
    for t in m["t"]:
        d = datetime.fromtimestamp(t, IST).date()
        last_ts_of_day[d] = max(last_ts_of_day.get(d, 0), t)
    by_close = {b["time"] + 180: i for i, b in enumerate(bars)}

    def state_at(i):
        bar = bars[i]
        p = prev[bar["day"]]
        ct = datetime.fromtimestamp(bar["time"] + 180, IST)
        idx = {"bar": bar, "ind": {k: v[i] for k, v in ci.items()}}
        fut = {"bar": bar, "ind": {k: v[i] for k, v in pi.items()},  # index in place of futures (no past futures minutes)
               "piv": pivots(p["high"], p["low"], p["close"]), "cpr": cpr(p["high"], p["low"], p["close"])}
        return {"symbol": sym, "hm": (ct.hour, ct.minute), "signalTime": datetime.fromtimestamp(bar["time"], IST).strftime("%H:%M"),
                "marketOpen": True, "positions": {}, "idx": idx, "fut": fut, "piv": fut["piv"], "spot": bar["close"]}

    trades, busy_until, per_day = [], 0, {}
    for i, bar in enumerate(bars):
        day = bar["day"]
        if day not in prev:
            continue
        close_ts = bar["time"] + 180
        if close_ts <= busy_until:
            continue
        st = state_at(i)
        r = dharani_v2_rule(st)
        if not r["go"] or per_day.get(day, 0) >= MAX_TRADES_DAY:
            continue
        strike, px = book.pick(day, r["side"], close_ts, PREMIUM_NEAR.get(sym, 250))
        if not px:
            continue
        side = r["side"]

        def signal_exit(ts, side=side):
            j = by_close.get(ts)
            if j is None or bars[j]["day"] != day:
                return None
            return dharani_v2_exit(state_at(j), side)
        res = run_trade(book, day, side, strike, close_ts, px, LOT[sym], 0.10, None, signal_exit, slip, last_ts_of_day.get(day, close_ts))
        trades.append({"strategy": "Dharani", "index": sym, "day": str(day), "signal": st["signalTime"], "side": side,
                       "strike": strike, "entry": round(px, 2), "entry_ts": close_ts, **res})
        per_day[day] = per_day.get(day, 0) + 1
        busy_until = res["exit_ts"]
    return trades


# ------------------------------------------------------------------ report
def summary(trades, key="net"):
    out = {}
    groups = {}
    for t in trades:
        groups.setdefault((t["strategy"], t["index"]), []).append(t)
    for (s, idx), ts in sorted(groups.items()):
        ts.sort(key=lambda t: t["entry_ts"])
        out[f"{s} · {idx}"] = stats(ts, key)
    for s in sorted({t["strategy"] for t in trades}):
        ts = sorted((t for t in trades if t["strategy"] == s), key=lambda t: t["entry_ts"])
        out[f"{s} · both indices"] = stats(ts, key)
    return out


def stats(ts, key="net"):
    pnl = [t[key] for t in ts]
    wins = [x for x in pnl if x > 0]
    losses = [x for x in pnl if x <= 0]
    eq = peak = dd = 0.0
    for x in pnl:
        eq += x
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    years = {}
    for t in ts:
        y = years.setdefault(t["day"][:4], {"trades": 0, "net": 0.0, "wins": 0})
        y["trades"] += 1
        y["net"] = round(y["net"] + t[key], 2)
        y["wins"] += t[key] > 0
    streak = cur = 0
    for x in pnl:
        cur = cur + 1 if x <= 0 else 0
        streak = max(streak, cur)
    return {"trades": len(ts), "net": round(sum(pnl), 2), "gross": round(sum(t["gross"] for t in ts), 2),
            "charges": round(sum(t["charges"] for t in ts), 2), "slippage": round(sum(t["slippage"] for t in ts), 2),
            "winRate": round(len(wins) / len(pnl) * 100, 1) if pnl else None,
            "avgWin": round(sum(wins) / len(wins), 2) if wins else None, "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
            "maxDrawdown": round(dd, 2), "worstLosingStreak": streak, "years": years,
            "exits": {r: sum(1 for t in ts if t.get("kind") == r) for r in ("Target", "Stop", "Signal", "Time")}}


def run(today=None, log=print, symbols=("NIFTY", "BANKNIFTY")):
    vix_m = bt_data.index_minutes("VIX")
    vix = minute_close_map(vix_m)
    trades = []
    for sym in symbols:
        m = bt_data.index_minutes(sym)
        if not m["t"]:
            log(f"{sym}: no data downloaded yet")
            continue
        log(f"{sym}: {len(m['t']):,} minutes from {datetime.fromtimestamp(m['t'][0], IST):%d %b %Y} to {datetime.fromtimestamp(m['t'][-1], IST):%d %b %Y}")
        book = Book(sym)
        mb = megabull_trades(sym, m, vix, book)
        log(f"  MegaBull rule: {len(mb)} trades")
        dh = dharani_trades(sym, m, Book(sym))
        log(f"  Dharani: {len(dh)} trades")
        trades += mb + dh
    res = {"ranAt": datetime.now(IST).isoformat(timespec="seconds"), "slippagePct": SLIPPAGE * 100, "lots": LOT,
           "summary": summary(trades), "summaryNoSlippage": summary([{**t, "net0": t["gross"] - t["charges"]} for t in trades], "net0")}
    os.makedirs(bt_data.ROOT, exist_ok=True)
    json.dump(res, open(os.path.join(bt_data.ROOT, "results.json"), "w", encoding="utf-8"), indent=1, default=str)
    with open(os.path.join(bt_data.ROOT, "trades.csv"), "w", newline="", encoding="utf-8") as f:
        cols = ["strategy", "index", "day", "signal", "side", "strike", "entry", "exit", "reason", "kind", "high", "low", "gross", "charges", "slippage", "net"]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for t in sorted(trades, key=lambda t: t["entry_ts"]):
            w.writerow(t)
    for k, v in res["summary"].items():
        log(f"{k}: {v['trades']} trades, net Rs {v['net']:,.0f}, win {v['winRate']}%, max drawdown Rs {v['maxDrawdown']:,.0f}")
    return res


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "download":
        from dhan_client import DhanClient
        print("Downloading past data from Dhan (read only). First time takes about 1-2 hours; it resumes if stopped.")
        n, skipped = bt_data.download(DhanClient(), date.today())
        print(f"Done: {n} pieces downloaded, {skipped} already saved.")
    else:
        run()
