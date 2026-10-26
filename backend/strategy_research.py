"""
strategy_research.py - search for new option-BUYING strategies on NIFTY / BANKNIFTY (owner, 26-Oct-2026).
PAPER ANALYSIS ONLY: no orders, no change to the live rules.

Method (fixed before looking at results):
  1. Search period 2021-11 .. 2024-12: every parameter set of each idea below is backtested with costs.
  2. Pick per idea the set with the best net / max drawdown among those that made money in each of 2022, 2023 and 2024,
     with profit factor >= 1.1 and at least 60 trades. Nothing from 2025-2026 is looked at to choose.
  3. Test period 2025-01 .. 2026-10: the picked sets are run once, unchanged. Only these numbers count.
Ideas: four for trending days (opening range breakout, previous-day high / low breakout, trend pull-back, momentum
breakout at a new day high / low; the last two optionally only once the day's range is already wide = a trend-day filter
known at entry) and two for sideways days (Bollinger band reversion, VWAP reversion). Exits: fixed stop / target, or a
trailing exit on the index (SuperTrend 10,2 or EMA 9 close-through) with a safety stop.

Fills and costs as backtest.py: ATM option of the nearest expiry, bought at the option's open in the minute the signal
5-minute candle closes; stop / target on the option's minute low / high (stop first when both), a gap fills at the open;
time exit 15:14; Dhan charges (paper_charges.py) + 0.5 % slippage per order; one lot at today's lot size (NIFTY 65,
BANKNIFTY 30) in every year; one position at a time per idea and index.
Option SELLING (info only, never traded): the same signals, selling the ATM option on the other side (call signal =
sell the put), stop when the premium rises by the stop %, target when it falls by the target %.

Run (backend folder): python strategy_research.py
Writes data/backtest/research_results.json, research_trades.csv and research_report.md.
"""
import csv
import itertools
import json
import os
import sys
from datetime import date, datetime

import numpy as np

import bt_data
import research_data
from paper_charges import order_charges
from sig_indicators import IST, supertrend

LOT = {"NIFTY": 65, "BANKNIFTY": 30}
SLIP = 0.005
TIME_EXIT = 359  # slot of 15:14
SEARCH = (date(2021, 11, 1), date(2024, 12, 31))
TEST = (date(2025, 1, 1), date(2026, 12, 31))
MIN_TRADES = 60
BAR = 5
NB = 75  # 5-minute bars a day


# ------------------------------------------------------------------ bars and indicators
def build_bars(days):
    """Concatenated 5-minute bars of every complete day + per-day info. Returns dict of numpy arrays."""
    order = sorted(days)
    rows, info = [], []
    for d in order:
        a = days[d]["idx"]
        if np.isnan(a[:, 3]).sum() > 30:
            continue
        a = a.copy()
        for k in range(4):  # fill gaps with the last close
            col = a[:, k]
            for s in range(len(col)):
                if np.isnan(col[s]):
                    col[s] = a[s - 1, 3] if s and not np.isnan(a[s - 1, 3]) else np.nan
        if np.isnan(a).any():
            continue
        r = a.reshape(NB, BAR, 4)
        o, h, l, c = r[:, 0, 0], r[:, :, 1].max(1), r[:, :, 2].min(1), r[:, -1, 3]
        rows.append(np.stack([o, h, l, c], 1))
        v = days[d]["vix"]
        info.append({"day": d, "vixOpen": float(np.nanmean(v[:5])) if not np.isnan(v[:5]).all() else np.nan})
    bars = np.concatenate(rows)
    return bars, info


def ema(x, n):
    out = np.empty_like(x)
    k = 2 / (n + 1)
    e = x[:n].mean()
    out[:n] = np.nan
    out[n - 1] = e
    for i in range(n, len(x)):
        e += k * (x[i] - e)
        out[i] = e
    return out


def wilder(x, n):
    out = np.full_like(x, np.nan)
    a = np.nanmean(x[1:n + 1])
    out[n] = a
    for i in range(n + 1, len(x)):
        a = (a * (n - 1) + x[i]) / n
        out[i] = a
    return out


def rsi(c, n=14):
    d = np.diff(c, prepend=c[0])
    g, l = wilder(np.maximum(d, 0), n), wilder(np.maximum(-d, 0), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        return 100 - 100 / (1 + g / l)


def adx(h, l, c, n=14):
    up, dn = np.diff(h, prepend=h[0]), -np.diff(l, prepend=l[0])
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pc = np.roll(c, 1)
    pc[0] = c[0]
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr_, p, m = wilder(tr, n), wilder(pdm, n), wilder(mdm, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi, mdi = 100 * p / atr_, 100 * m / atr_
        dx = 100 * abs(pdi - mdi) / (pdi + mdi)
    return wilder(np.nan_to_num(dx), n), atr_


def rolling_sd(x, n):
    out = np.full_like(x, np.nan)
    cs, cs2 = np.cumsum(np.insert(x, 0, 0)), np.cumsum(np.insert(x * x, 0, 0))
    s, s2 = cs[n:] - cs[:-n], cs2[n:] - cs2[:-n]
    out[n - 1:] = np.sqrt(np.maximum(s2 / n - (s / n) ** 2, 0))
    return out


def features(bars, info):
    o, h, l, c = bars.T
    f = {"o": o, "h": h, "l": l, "c": c}
    f["ema9"], f["ema20"], f["ema21"] = ema(c, 9), ema(c, 20), ema(c, 21)
    f["rsi"] = rsi(c)
    f["adx"], f["atr"] = adx(h, l, c)
    bb_mid = np.convolve(c, np.ones(20) / 20, "full")[:len(c)]
    bb_mid[:19] = np.nan
    sd = rolling_sd(c, 20)
    f["bb_mid"], f["bb_up"], f["bb_lo"] = bb_mid, bb_mid + 2 * sd, bb_mid - 2 * sd
    line, d = supertrend(list(h), list(l), list(c), 10, 2.0)
    f["st_dir"] = np.array([np.nan if x is None else x for x in d])
    # per day: VWAP on the typical price (no volume), bands from the day's running deviation, day levels
    tp = (h + l + c) / 3
    n = len(info)
    tpd = tp.reshape(n, NB)
    cnt = np.arange(1, NB + 1)
    vw = np.cumsum(tpd, 1) / cnt
    vsd = np.sqrt(np.maximum(np.cumsum(tpd ** 2, 1) / cnt - vw ** 2, 0))
    f["vwap"], f["vwap_sd"] = vw.ravel(), vsd.ravel()
    dh, dl, dc, do = h.reshape(n, NB).max(1), l.reshape(n, NB).min(1), c.reshape(n, NB)[:, -1], o.reshape(n, NB)[:, 0]
    f["day_open"], f["day_close"], f["day_high"], f["day_low"] = do, dc, dh, dl
    f["prev_h"], f["prev_l"], f["prev_c"] = np.r_[np.nan, dh[:-1]], np.r_[np.nan, dl[:-1]], np.r_[np.nan, dc[:-1]]
    rng = dh - dl
    f["prev_range"] = np.r_[np.nan, rng[:-1]]
    f["atr_d"] = np.r_[np.nan, np.convolve(rng, np.ones(10) / 10, "full")[:n - 1]]  # 10-day average range up to yesterday
    f["atr_d"][:10] = np.nan
    # day type for the report (known only after the close): trending when the day closed in its outer quarter
    body = abs(dc - do) / np.where(rng > 0, rng, np.nan)
    f["trend_day"] = body >= 0.5
    return f


# ------------------------------------------------------------------ trade simulation
def opt_path(days, d, side, slot):
    atm = days[d]["atm"][side]
    k = atm[slot] if slot < len(atm) else np.nan
    j = slot
    while np.isnan(k) and j > 0:
        j -= 1
        k = atm[j]
    if np.isnan(k):
        return None, None
    return float(k), days[d]["opt"][side].get(float(k))


def charges(entry, exit_, qty):
    return order_charges("BUY", entry * qty).total + order_charges("SELL", exit_ * qty).total


def simulate(path, e, stop, target, exits=(), short=False):
    """path (375, 4) o/h/l/c. Enter at path[e] open. Long: stop below / target above; short: mirrored.
    exits: slots where a signal exit happens (at that slot's open). Returns (entry, exit, exit_slot, kind)."""
    px = float(path[e, 0])
    if not px == px or px <= 0:
        return None
    if short:
        sl, tg = px * (1 + stop), (px * (1 - target) if target else None)
    else:
        sl, tg = px * (1 - stop), (px * (1 + target) if target else None)
    ex = set(exits)
    for s in range(e, TIME_EXIT + 1):
        o, h, lo, c = (float(v) for v in path[s])
        if o != o:
            continue
        if s > e and s in ex:
            return px, o, s, "Signal"
        if s == TIME_EXIT:
            return px, o, s, "Time"
        if not short:
            if s > e and o <= sl:
                return px, o, s, "Stop"
            if lo <= sl:
                return px, sl, s, "Stop"
            if tg and s > e and o >= tg:
                return px, o, s, "Target"
            if tg and h >= tg:
                return px, tg, s, "Target"
        else:
            if s > e and o >= sl:
                return px, o, s, "Stop"
            if h >= sl:
                return px, sl, s, "Stop"
            if tg and s > e and o <= tg:
                return px, o, s, "Target"
            if tg and lo <= tg:
                return px, tg, s, "Target"
    return px, float(path[TIME_EXIT, 0]), TIME_EXIT, "Time"


# ------------------------------------------------------------------ ideas (signal generators)
# Each returns a list of (day_index, bar, side, exit_bars) candidates; bar = the signal candle, entry at its close.
def sig_orb(f, n, p):
    """Opening range breakout: the first `orb` minutes make the range; the first 5-min close beyond it (before
    `last`) is the signal. Optional: narrow range only (range < `narrow` x the 10-day average day range); exit when a
    5-min candle closes back inside the range (`back`)."""
    out = []
    ob = p["orb"] // BAR
    for di in range(n):
        base = di * NB
        hi, lo = f["h"][base:base + ob].max(), f["l"][base:base + ob].min()
        a = f["atr_d"][di]
        if p["narrow"] and (a != a or hi - lo > p["narrow"] * a):
            continue
        for b in range(ob, p["last"]):
            c = f["c"][base + b]
            side = "CE" if c > hi else "PE" if c < lo else None
            if side:
                ex = []
                if p["back"]:
                    ex = [x for x in range(b + 1, NB) if lo <= f["c"][base + x] <= hi]
                out.append((di, b, side, ex))
                break
    return out


def sig_pdhl(f, n, p):
    """Previous-day high / low breakout: first 5-min close above yesterday's high (call) or below its low (put) after
    09:30 and before `last`, with SuperTrend on the same side (`st`) if asked."""
    out = []
    for di in range(1, n):
        base = di * NB
        ph, pl = f["prev_h"][di], f["prev_l"][di]
        if f["o"][base] > ph or f["o"][base] < pl:  # opened beyond the level: not a breakout
            continue
        for b in range(3, p["last"]):
            i = base + b
            side = "CE" if f["c"][i] > ph else "PE" if f["c"][i] < pl else None
            if side and p["st"] and f["st_dir"][i] != (-1 if side == "CE" else 1):
                side = None
            if side:
                out.append((di, b, side, []))
                break
    return out


def sig_pullback(f, n, p):
    """Trend pull-back: ADX >= `adx`, EMA 9 above EMA 21 and close above VWAP (call; put mirrored); the candle dips to
    EMA 21 (low <= EMA 21) and closes back above EMA 9. From 10:15 to `last`, at most 2 a day."""
    out = []
    for di in range(n):
        base, k = di * NB, 0
        for b in range(12, p["last"]):
            i = base + b
            if f["adx"][i] < p["adx"]:
                continue
            if p.get("expand") and not (f["h"][base:i + 1].max() - f["l"][base:i + 1].min() >= p["expand"] * f["atr_d"][di]):
                continue
            up = f["ema9"][i] > f["ema21"][i] and f["c"][i] > f["vwap"][i] and f["l"][i] <= f["ema21"][i] and f["c"][i] > f["ema9"][i]
            dn = f["ema9"][i] < f["ema21"][i] and f["c"][i] < f["vwap"][i] and f["h"][i] >= f["ema21"][i] and f["c"][i] < f["ema9"][i]
            if up or dn:
                out.append((di, b, "CE" if up else "PE", []))
                k += 1
                if k == 2:
                    break
    return out


def sig_bb_revert(f, n, p):
    """Sideways day, Bollinger reversion: ADX < `adx` (no trend); the previous candle closed outside the band and this
    one closes back inside, RSI beyond `rsi` (put side: RSI above 100 - rsi) -> buy toward the middle. Exit when a
    candle closes beyond the band middle. 10:00 to 14:30, at most 2 a day."""
    out = []
    for di in range(n):
        base, k = di * NB, 0
        for b in range(9, 63):
            i = base + b
            if not f["adx"][i] < p["adx"]:
                continue
            side = None
            if f["c"][i - 1] < f["bb_lo"][i - 1] and f["c"][i] > f["bb_lo"][i] and f["rsi"][i - 1] < p["rsi"]:
                side = "CE"
            elif f["c"][i - 1] > f["bb_up"][i - 1] and f["c"][i] < f["bb_up"][i] and f["rsi"][i - 1] > 100 - p["rsi"]:
                side = "PE"
            if side:
                ex = [x for x in range(b + 1, NB) if (f["c"][base + x] >= f["bb_mid"][base + x]) == (side == "CE")] if p["mid"] else []
                out.append((di, b, side, ex[:1]))
                k += 1
                if k == 2:
                    break
    return out


def sig_vwap_revert(f, n, p):
    """Sideways day, VWAP reversion: ADX < `adx`; a candle stretched beyond VWAP +/- `k` day deviations closes back
    toward VWAP (close inside the band and a reversal candle) -> buy toward VWAP; exit when a candle closes across
    VWAP. 10:15 to 14:30, at most 2 a day."""
    out = []
    for di in range(n):
        base, kk = di * NB, 0
        for b in range(12, 63):
            i = base + b
            if not f["adx"][i] < p["adx"]:
                continue
            vw, sd = f["vwap"][i - 1], f["vwap_sd"][i - 1]
            side = None
            if f["l"][i - 1] < vw - p["k"] * sd and f["c"][i] > f["o"][i] and f["c"][i] > f["h"][i - 1]:
                side = "CE"
            elif f["h"][i - 1] > vw + p["k"] * sd and f["c"][i] < f["o"][i] and f["c"][i] < f["l"][i - 1]:
                side = "PE"
            if side:
                ex = [x for x in range(b + 1, NB) if (f["c"][base + x] >= f["vwap"][base + x]) == (side == "CE")]
                out.append((di, b, side, ex[:1]))
                kk += 1
                if kk == 2:
                    break
    return out


def sig_momentum(f, n, p):
    """Momentum breakout: from 10:15 to 13:30 a 5-min candle closes at a new high of the day (call) or low (put) with
    RSI >= `rsi` (put: <= 100 - rsi), ADX >= 20 and, if `bb`, a close outside the Bollinger band. At most 2 a day."""
    out = []
    for di in range(n):
        base, k = di * NB, 0
        for b in range(12, 51):
            i = base + b
            if f["adx"][i] < 20:
                continue
            hi, lo = f["h"][base:i].max(), f["l"][base:i].min()
            if p.get("expand") and not (max(hi, f["h"][i]) - min(lo, f["l"][i]) >= p["expand"] * f["atr_d"][di]):
                continue  # trend-day filter known at entry: the day's range so far is already wide
            up = f["c"][i] > hi and f["rsi"][i] >= p["rsi"] and (not p["bb"] or f["c"][i] > f["bb_up"][i])
            dn = f["c"][i] < lo and f["rsi"][i] <= 100 - p["rsi"] and (not p["bb"] or f["c"][i] < f["bb_lo"][i])
            if up or dn:
                out.append((di, b, "CE" if up else "PE", []))
                k += 1
                if k == 2:
                    break
    return out


IDEAS = {
    "Opening range breakout": {"kind": "trending", "fn": sig_orb,
                               "grid": {"orb": [15, 30], "last": [24, 42], "narrow": [0, 0.35, 0.5], "back": [False, True]}},
    "Previous-day high/low breakout": {"kind": "trending", "fn": sig_pdhl, "grid": {"last": [24, 48], "st": [False, True]}},
    "Trend pull-back": {"kind": "trending", "fn": sig_pullback, "grid": {"adx": [20, 25, 30], "last": [48, 63], "expand": [0, 0.6, 0.8]}},
    "Momentum breakout": {"kind": "trending", "fn": sig_momentum, "grid": {"rsi": [60, 65, 70], "bb": [False, True], "expand": [0, 0.6, 0.8]}},
    "Bollinger reversion": {"kind": "sideways", "fn": sig_bb_revert, "grid": {"adx": [15, 20, 25], "rsi": [30, 35], "mid": [False, True]}},
    "VWAP reversion": {"kind": "sideways", "fn": sig_vwap_revert, "grid": {"adx": [15, 20, 25], "k": [1.5, 2.0]}},
}
# exits: fixed stop / target, or a trailing exit on the index (SuperTrend or EMA 9 close-through) with a safety stop
EXITS = [("fixed", 0.10, 0.20), ("fixed", 0.15, 0.30), ("fixed", 0.20, 0.40), ("fixed", 0.25, 0.50), ("fixed", 0.15, 0.15),
         ("fixed", 0.20, None), ("st", 0.15, None), ("st", 0.25, None), ("ema9", 0.15, None), ("ema9", 0.25, None),
         ("st", 0.15, 0.50)]


def grid(g):
    keys = list(g)
    return [dict(zip(keys, v)) for v in itertools.product(*(g[k] for k in keys))]


def trail_exits(f, di, b, side, mode):
    """Bars after the signal where a trailing exit fires: "st" = a 5-min candle closes through SuperTrend (10, 2),
    "ema9" = a 5-min candle closes back across EMA 9."""
    base = di * NB
    out = []
    for x in range(b + 1, NB):
        i = base + x
        if mode == "st" and f["st_dir"][i] == (1 if side == "CE" else -1):
            out.append(x)
            break
        if mode == "ema9" and ((f["c"][i] < f["ema9"][i]) if side == "CE" else (f["c"][i] > f["ema9"][i])):
            out.append(x)
            break
    return out


def run_idea(sym, days, info, f, cands, stop, target, short=False, mode="fixed"):
    trades, busy = [], (-1, -1)
    qty = LOT[sym]
    for di, b, side, ex in cands:
        if mode != "fixed":
            ex = sorted(set(ex) | set(trail_exits(f, di, b, side, mode)))[:1]
        d = info[di]["day"]
        e = (b + 1) * BAR
        if e >= TIME_EXIT or (di == busy[0] and e <= busy[1]):
            continue
        tside = side if not short else ("PE" if side == "CE" else "CE")
        k, path = opt_path(days, d, tside, e)
        if path is None:
            continue
        r = simulate(path, e, stop, target, [(x + 1) * BAR for x in ex], short)
        if not r:
            continue
        px, xp, xs, kind = r
        gross = (xp - px) * qty * (-1 if short else 1)
        net = gross - charges(px, xp, qty) - (px + xp) * qty * SLIP
        busy = (di, xs)
        trades.append({"index": sym, "day": d, "di": di, "side": tside, "signal": f"{9 + (15 + b * 5) // 60:02d}:{(15 + b * 5) % 60:02d}",
                       "strike": k, "entry": round(px, 2), "exit": round(xp, 2), "kind": kind, "minutes": xs - e,
                       "gross": round(gross, 2), "net": round(net, 2), "vix": info[di]["vixOpen"],
                       "trendDay": bool(f["trend_day"][di])})
    return trades


def stats(ts):
    pnl = [t["net"] for t in sorted(ts, key=lambda t: (t["day"], t["signal"]))]
    if not pnl:
        return {"trades": 0, "net": 0.0, "winRate": None, "profitFactor": None, "maxDrawdown": 0.0, "years": {}}
    eq = np.cumsum(pnl)
    dd = float(np.max(np.maximum.accumulate(np.r_[0, eq])[1:] - eq)) if len(eq) else 0.0
    dd = max(dd, 0.0)
    w = sum(x for x in pnl if x > 0)
    lo = -sum(x for x in pnl if x <= 0)
    years = {}
    for t in ts:
        years[t["day"].year] = round(years.get(t["day"].year, 0) + t["net"], 2)
    return {"trades": len(pnl), "net": round(sum(pnl), 2), "winRate": round(sum(x > 0 for x in pnl) / len(pnl) * 100, 1),
            "profitFactor": round(w / lo, 2) if lo else None, "maxDrawdown": round(dd, 2), "years": years}


def in_period(ts, per):
    return [t for t in ts if per[0] <= t["day"] <= per[1]]


def breakdown(ts, expiry):
    def by(key):
        g = {}
        for t in ts:
            g.setdefault(key(t), []).append(t)
        return {str(k): {"trades": len(v), "net": round(sum(x["net"] for x in v), 2),
                         "winRate": round(sum(x["net"] > 0 for x in v) / len(v) * 100, 1)} for k, v in sorted(g.items())}

    def tod(t):
        h, m = map(int, t["signal"].split(":"))
        x = h * 60 + m
        return "09:15-10:30" if x < 630 else "10:30-12:00" if x < 720 else "12:00-13:30" if x < 810 else "13:30-15:15"

    def vixb(t):
        v = t["vix"]
        return "unknown" if v != v else "VIX < 13" if v < 13 else "VIX 13-16" if v < 16 else "VIX 16-20" if v < 20 else "VIX 20+"
    return {"timeOfDay": by(tod), "weekday": by(lambda t: t["day"].strftime("%a")),
            "expiry": by(lambda t: {"expiry": "Expiry day", "eve": "Day before expiry"}.get(expiry.get(t["index"], {}).get(t["day"]), "Other days")),
            "vix": by(vixb), "dayType": by(lambda t: "Trending day" if t["trendDay"] else "Sideways day")}


def straddle(days, d, slot, last=False):
    tot = 0.0
    for side in ("CE", "PE"):
        atm = days[d]["atm"][side]
        idx = [i for i in range(len(atm)) if atm[i] == atm[i]]
        if not idx:
            return None
        i = idx[-1] if last else idx[0]
        k = float(atm[i])
        a = days[d]["opt"][side].get(k)
        if a is None:
            return None
        tot += float(a[i, 3])
    return tot


def expiry_days(days):
    """{day: "expiry" | "eve"}, as bt_variants.expiry_days (the ATM straddle doubles overnight only when the nearest
    expiry rolls), read from the research arrays."""
    order = sorted(days)
    out = {}
    for a, b in zip(order, order[1:]):
        x, y = straddle(days, a, 0, last=True), straddle(days, b, 0)
        if x and y and y >= 2.0 * x:
            out[a] = "expiry"
    for k, d in enumerate(order):
        if out.get(d) == "expiry" and k > 0 and order[k - 1] not in out:
            out[order[k - 1]] = "eve"
    return out


def score(s):
    ys = s["years"]
    ok = (s["trades"] >= MIN_TRADES and (s["profitFactor"] or 0) >= 1.1 and all(ys.get(y, -1) > 0 for y in (2022, 2023, 2024)))
    return (s["net"] / max(s["maxDrawdown"], 1.0)) if ok else None


def main(log=print, symbols=("NIFTY", "BANKNIFTY")):
    data = {}
    expiry = {}
    for sym in symbols:
        days = research_data.load(sym, log)
        bars, info = build_bars(days)
        f = features(bars, info)
        data[sym] = (days, info, f)
        log(f"{sym}: {len(info)} days ready")
        expiry[sym] = expiry_days(days)
    results = {"ranAt": datetime.now(IST).isoformat(timespec="seconds"), "search": [str(x) for x in SEARCH],
               "test": [str(x) for x in TEST], "ideas": {}}
    all_trades = []
    for name, idea in IDEAS.items():
        tried = []
        for p in grid(idea["grid"]):
            cands = {sym: idea["fn"](data[sym][2], len(data[sym][1]), p) for sym in symbols}
            for mode, stop, target in EXITS:
                per = {s: run_idea(s, *data[s], cands[s], stop, target, mode=mode) for s in symbols}
                for scope in list(symbols) + ["both"]:
                    syms = symbols if scope == "both" else (scope,)
                    ts = [t for s in syms for t in per[s]]
                    st = stats(in_period(ts, SEARCH))
                    tried.append({"params": p, "exit": mode, "stop": stop, "target": target, "index": scope, "search": st,
                                  "score": score(st), "_trades": ts})
        good = sorted([t for t in tried if t["score"] is not None], key=lambda t: -t["score"])
        log(f"{name}: {len(tried)} sets tried, {len(good)} passed the search filter")
        for t in sorted(tried, key=lambda t: -t["search"]["net"])[:3]:
            log(f"    best search net: {t['params']} {t['exit']} {t['stop']}/{t['target']} {t['index']}: {t['search']['net']:,.0f} "
                f"PF {t['search']['profitFactor']} years {t['search']['years']}")
        pick = good[0] if good else max(tried, key=lambda t: t["search"]["net"])
        ts = pick["_trades"]
        test = in_period(ts, TEST)
        syms = symbols if pick["index"] == "both" else (pick["index"],)
        short = [t for s in syms for t in run_idea(s, *data[s], idea["fn"](data[s][2], len(data[s][1]), pick["params"]),
                                                   0.30, 0.30, short=True)]
        results["ideas"][name] = {
            "kind": idea["kind"], "passedSearchFilter": bool(good), "setsTried": len(tried), "setsPassed": len(good),
            "params": pick["params"], "exit": pick["exit"], "stop": pick["stop"], "target": pick["target"], "index": pick["index"],
            "search": pick["search"], "test": stats(test), "all": stats(ts),
            "testBreakdown": breakdown(test, expiry), "allBreakdown": breakdown(ts, expiry),
            "sellingInfo": {"search": stats(in_period(short, SEARCH)), "test": stats(in_period(short, TEST)),
                            "rule": "sell the ATM option on the other side, stop +30 %, target -30 %, 15:14 exit"},
            "runnersUp": [{"params": t["params"], "exit": t["exit"], "stop": t["stop"], "target": t["target"], "index": t["index"],
                           "search": t["search"], "test": stats(in_period(t["_trades"], TEST))} for t in good[1:4]],
        }
        for t in ts:
            all_trades.append({**t, "idea": name})
        r = results["ideas"][name]
        log(f"  pick {pick['params']} exit {pick['exit']} stop {pick['stop']} target {pick['target']} {pick['index']}: search net "
            f"{r['search']['net']:,.0f} PF {r['search']['profitFactor']} | TEST net {r['test']['net']:,.0f} "
            f"PF {r['test']['profitFactor']} win {r['test']['winRate']}% DD {r['test']['maxDrawdown']:,.0f}")
    os.makedirs(bt_data.ROOT, exist_ok=True)
    json.dump(results, open(os.path.join(bt_data.ROOT, "research_results.json"), "w", encoding="utf-8"), indent=1, default=str)
    with open(os.path.join(bt_data.ROOT, "research_trades.csv"), "w", newline="", encoding="utf-8") as fh:
        cols = ["idea", "index", "day", "signal", "side", "strike", "entry", "exit", "kind", "minutes", "gross", "net", "vix", "trendDay"]
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(sorted(all_trades, key=lambda t: (t["idea"], t["day"], t["signal"])))
    report(results)
    return results


def money(x):
    return "-" if x is None else f"Rs {x:,.0f}"


def dharani_years():
    """Dharani Rules' year-by-year net from the last backtest.py run (results.json), both indices."""
    try:
        r = json.load(open(os.path.join(bt_data.ROOT, "results.json"), encoding="utf-8"))
        s = r["summary"]["Dharani Rules · both indices"]
        return {int(y): v["net"] for y, v in s["years"].items()}, s
    except (OSError, ValueError, KeyError):
        return {}, None


def report(results):
    """research_report.md: plain-language summary for the owner."""
    L = ["# New option-buying strategies: search 2021-24, test 2025-26", "",
         f"Run {results['ranAt']}. Paper analysis only. Costs included (Dhan charges + 0.5 % slippage per order). "
         "1 lot (NIFTY 65 / BANKNIFTY 30); yearly return = year's net on a Rs 1 lakh account.", "",
         "| Idea | Day type | Passed the 2021-24 search? | Rules picked | Search net 2021-24 | TEST net 2025-26 | Test win % | Test profit factor | Test max drawdown |",
         "|---|---|---|---|---|---|---|---|---|"]
    for n, i in results["ideas"].items():
        rule = f"{i['params']}, exit {i['exit']}, stop {i['stop']}, target {i['target']}, {i['index']}"
        L.append(f"| {n} | {i['kind']} | {'yes' if i['passedSearchFilter'] else 'no'} ({i['setsPassed']} of {i['setsTried']}) | {rule} | "
                 f"{money(i['search']['net'])} | {money(i['test']['net'])} | {i['test']['winRate']} | {i['test']['profitFactor']} | {money(i['test']['maxDrawdown'])} |")
    dy, ds = dharani_years()
    if ds:
        L += ["", f"Dharani Rules (backtest.py, both indices): 2025 {money(dy.get(2025))}, 2026 {money(dy.get(2026))}; "
              f"5 years {money(ds['net'])}, win {ds['winRate']} %, max drawdown {money(ds['maxDrawdown'])}."]
    L += ["", "## Yearly return on Rs 1 lakh (picked rules)", "", "| Idea | " + " | ".join(str(y) for y in range(2021, 2027)) + " |",
          "|---|" + "---|" * 6]
    for n, i in results["ideas"].items():
        L.append(f"| {n} | " + " | ".join(f"{i['all']['years'].get(y, i['all']['years'].get(str(y), 0)) / 1000:.1f}%" for y in range(2021, 2027)) + " |")
    if dy:
        L.append("| Dharani Rules | " + " | ".join(f"{dy.get(y, 0) / 1000:.1f}%" for y in range(2021, 2027)) + " |")
    L += ["", "## Option selling, same signals (information only, never traded)", "", "| Idea | Search net 2021-24 | Test net 2025-26 | Test win % |", "|---|---|---|---|"]
    for n, i in results["ideas"].items():
        s = i["sellingInfo"]
        L.append(f"| {n} | {money(s['search']['net'])} | {money(s['test']['net'])} | {s['test']['winRate']} |")
    for n, i in results["ideas"].items():
        L += ["", f"## {n}: 2025-26 test split", ""]
        for k, v in i["testBreakdown"].items():
            L.append(f"- {k}: " + "; ".join(f"{g} {x['trades']} trades {money(x['net'])} ({x['winRate']} % win)" for g, x in v.items()))
    open(os.path.join(bt_data.ROOT, "research_report.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")


if __name__ == "__main__":
    main(symbols=tuple(sys.argv[1:]) or ("NIFTY", "BANKNIFTY"))
