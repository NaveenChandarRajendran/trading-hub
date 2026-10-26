"""
bt_variants.py - stop / target and expiry-day test of the auto rules (owner, 26-Oct-2026). PAPER ANALYSIS ONLY: no
orders, no rule change. Runs the SAME backtest as backtest.py (live rule functions, Dhan's past data, costs and 0.5 %
slippage) with other stop / target pairs and expiry-day handling, so the owner can choose; the live settings
(autopaper.json) are not touched.

Stop / target pairs (fractions of the entry premium): -10/+20, -15/+20, -10/+15, -20/+30.
Expiry handling:  all days | skip expiry day | skip expiry day and the day before |
                  wider stop on expiry day and the day before (stop 10 points wider, target unchanged).
Strategies: Trend Rules (approximate, as in backtest.py; live: -15/+20), 4 Pillar Rules and SuperTrend Rules
(live: -10/+20). Both indices.

Expiry days are read from the data itself: the nearest-expiry ATM call's premium jumps (x2 or more) from one day's close
to the next day's open only when the series rolls to the next expiry, so the day before the jump was an expiry day.

Run (backend folder): python bt_variants.py    Writes data/backtest/variants.json and variants.csv.
"""
import csv
import json
import os
import sys
from datetime import datetime

import backtest as bt
import bt_data
from sig_indicators import IST

PAIRS = [(0.10, 0.20), (0.15, 0.20), (0.10, 0.15), (0.20, 0.30)]
LIVE = {"Trend Rules": (0.15, 0.20), "4 Pillar Rules": (0.10, 0.20), "SuperTrend Rules": (0.10, 0.20)}
MODES = ["All days", "Skip expiry day", "Skip expiry day + day before", "Wider stop on expiry day + day before"]
WIDER = 0.10


def pair_name(p):
    return f"-{p[0] * 100:.0f}/+{p[1] * 100:.0f}"


def trading_days(m):
    days, last = {}, {}
    for t in m["t"]:
        dt = datetime.fromtimestamp(t, IST)
        if 555 <= dt.hour * 60 + dt.minute < 930:
            d = dt.date()
            days.setdefault(d, t)
            last[d] = t
    return sorted(days), days, last


def atm_price(prices, day, ts, side="CE", look=5, step=60):
    """Premium of the ATM row (offset 0) at ts, looking up to `look` minutes away (step -60 = earlier)."""
    for k in range(look):
        rows = prices.at(day, side, ts + k * step)
        for v in rows.values():
            if v[4] == 0:
                return v[3]
    return None


def expiry_days(sym, m, prices=None):
    """{day: "expiry" | "eve"}: expiry days found from the roll of the nearest-expiry series, and the trading day
    before each one."""
    prices = prices or bt_data.OptionPrices(sym)
    order, first, last = trading_days(m)
    out = {}
    for a, b in zip(order, order[1:]):
        close_a = atm_price(prices, a, last[a] - 60, step=-60)
        ce_b = atm_price(prices, b, first[b] + 60)
        pe_a = atm_price(prices, a, last[a] - 60, "PE", step=-60)
        pe_b = atm_price(prices, b, first[b] + 60, "PE")
        if None in (close_a, ce_b, pe_a, pe_b):
            continue
        # straddle: one side alone can jump on a big gap; both together only roll on a new expiry
        if (ce_b + pe_b) >= 2.0 * (close_a + pe_a):
            out[a] = "expiry"
    for k, d in enumerate(order):
        if out.get(d) == "expiry" and k > 0 and order[k - 1] not in out:
            out[order[k - 1]] = "eve"
    return out


def day_rule_for(mode, tags):
    if mode == "Wider stop on expiry day + day before":
        return lambda day, stop, target: (stop + WIDER, target) if day in tags else (stop, target)
    return None


def keep(mode, tag):
    """Skipping whole days = leaving out that day's trades (a rule's position never runs past the day)."""
    if mode == "Skip expiry day":
        return tag != "expiry"
    if mode == "Skip expiry day + day before":
        return not tag
    return True


def stats(ts):
    s = bt.stats(sorted(ts, key=lambda t: t["entry_ts"]))
    wins = sum(t["net"] for t in ts if t["net"] > 0)
    loss = -sum(t["net"] for t in ts if t["net"] <= 0)
    s["profitFactor"] = round(wins / loss, 2) if loss else None
    s["net2025_26"] = round(sum(t["net"] for t in ts if t["day"] >= "2025-01-01"), 2)
    return s


def run(log=print, symbols=("NIFTY", "BANKNIFTY")):
    vix = bt.minute_close_map(bt_data.index_minutes("VIX"))
    rows, tag_count = [], {}
    all_trades = {}  # (strategy, pair, wider?) -> trades of both indices
    for sym in symbols:
        m = bt_data.index_minutes(sym)
        if not m["t"]:
            log(f"{sym}: no data downloaded yet")
            continue
        tags = expiry_days(sym, m)
        tag_count[sym] = {"expiry": sum(v == "expiry" for v in tags.values()), "eve": sum(v == "eve" for v in tags.values())}
        log(f"{sym}: {tag_count[sym]['expiry']} expiry days found")
        toi_cache = {}
        for p in PAIRS:
            for wider in (False, True):
                rule = day_rule_for(MODES[3], tags) if wider else None
                book = bt.Book(sym)
                mb = bt.megabull_trades(sym, m, vix, book, stop=p[0], target=p[1], day_rule=rule)
                tr = bt.trend_trades(sym, m, bt.Book(sym), stop=p[0], target=p[1], day_rule=rule, toi_cache=toi_cache)
                for t in mb + tr:
                    t["expiryTag"] = tags.get(datetime.strptime(t["day"], "%Y-%m-%d").date(), "")
                    all_trades.setdefault((t["strategy"], p, wider), []).append(t)
                log(f"  {sym} {pair_name(p)}{' wider on expiry' if wider else ''}: {len(mb)} 4 Pillar + SuperTrend, {len(tr)} Trend")
    for strat in LIVE:
        for p in PAIRS:
            for mode in MODES:
                wider = mode == MODES[3]
                ts = [t for t in all_trades.get((strat, p, wider), []) if keep(mode, t["expiryTag"])]
                s = stats(ts)
                rows.append({"strategy": strat, "stopTarget": pair_name(p), "live": p == LIVE[strat], "expiry": mode,
                             "trades": s["trades"], "net": s["net"], "winRate": s["winRate"], "maxDrawdown": s["maxDrawdown"],
                             "profitFactor": s["profitFactor"], "net2025_26": s["net2025_26"], "worstLosingStreak": s["worstLosingStreak"],
                             "exits": s["exits"], "years": s["years"]})
        # where the losses come from: the live pair split by day type
        live_ts = all_trades.get((strat, LIVE[strat], False), [])
        for tag, label in (("expiry", "Expiry day only"), ("eve", "Day before expiry only"), ("", "Other days only")):
            s = stats([t for t in live_ts if t["expiryTag"] == tag])
            rows.append({"strategy": strat, "stopTarget": pair_name(LIVE[strat]), "live": True, "expiry": label,
                         "trades": s["trades"], "net": s["net"], "winRate": s["winRate"], "maxDrawdown": s["maxDrawdown"],
                         "profitFactor": s["profitFactor"], "net2025_26": s["net2025_26"], "worstLosingStreak": s["worstLosingStreak"],
                         "exits": s["exits"], "years": s["years"]})
    res = {"ranAt": datetime.now(IST).isoformat(timespec="seconds"), "slippagePct": bt.SLIPPAGE * 100, "expiryDays": tag_count,
           "widerStopPoints": WIDER * 100, "rows": rows}
    os.makedirs(bt_data.ROOT, exist_ok=True)
    json.dump(res, open(os.path.join(bt_data.ROOT, "variants.json"), "w", encoding="utf-8"), indent=1, default=str)
    cols = ["strategy", "stopTarget", "live", "expiry", "trades", "net", "winRate", "maxDrawdown", "profitFactor", "net2025_26", "worstLosingStreak"]
    with open(os.path.join(bt_data.ROOT, "variants.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    for r in rows:
        log(f"{r['strategy']:<17} {r['stopTarget']:<8} {r['expiry']:<38} {r['trades']:>5} trades  net Rs {r['net']:>10,.0f}  "
            f"win {r['winRate']}%  max DD Rs {r['maxDrawdown']:,.0f}  PF {r['profitFactor']}")
    return res


if __name__ == "__main__":
    run(symbols=tuple(sys.argv[1:]) or ("NIFTY", "BANKNIFTY"))
