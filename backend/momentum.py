"""
momentum.py - "Momentum 20" monthly stock screener (docs/strategies/momentum-20.md), pure rules. PAPER ONLY.

Owner approved 28-Oct-2026 after Claude's 2012-2026 backtest (Claude Doc "Stock momentum strategy test 28 Oct 2026",
scripts in project files research/stock-momentum/). This module ports that backtest's screener (engine.scores) and
month-end rebalance to plain Python so the app needs no pandas. momentum_book.py runs it on two Rs 5 lakh books.

Prices: Yahoo Finance daily bars (free, same source as the backtest). A bar = {"d": "YYYY-MM-DD", "o", "c", "a", "v"}
(open, close, dividend/split-adjusted close, volume). Momentum uses adjusted prices; the Rs 20 floor and traded value
use the raw close.
"""
import math
from statistics import median

# ---- delivery charges (Dhan: zero brokerage on delivery), same as the backtest ----
STT = 0.001          # buy and sell
STAMP_BUY = 0.00015
EXCH = 0.0000297     # NSE transaction charge
SEBI = 0.000001
GST = 0.18           # on exchange + SEBI charges
DP_PER_SELL = 15.93  # depository charge per stock per sell (incl. GST)
SLIP = 0.001         # 0.1 % worse than the open, each side

UNIVERSE = 500       # most traded stocks considered
TOP = 20             # stocks held
KEEP = 40            # a holding stays while it ranks in the top KEEP
MIN_PRICE = 20
REGIME_DAYS = 200


def aligned(bars, cal):
    """Adjusted closes on the trading calendar `cal` (dates). A missing day repeats the last close for up to 5 days
    (as the backtest did); longer gaps stay None."""
    by = {b["d"]: b for b in bars}
    out, last, gap = [], None, 0
    for d in cal:
        b = by.get(d)
        if b and b.get("a"):
            last, gap = b["a"], 0
            out.append(last)
        elif last is not None and gap < 5:
            gap += 1
            out.append(last)
        else:
            out.append(None)
    return out


def _std(xs):
    xs = [x for x in xs if x is not None and not math.isnan(x)]
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def stock_score(bars, cal):
    """(traded value, score) for one stock at the last date of `cal`, or None when it is not eligible.
    cal = the last 253+ trading dates up to the signal day."""
    if len(cal) < 260:
        return None
    by = {b["d"]: b for b in bars}
    today = by.get(cal[-1])
    if not today or not today.get("c") or today["c"] < MIN_PRICE:
        return None  # must trade on the signal day, price >= Rs 20
    p = aligned(bars, cal)
    if p[-1] is None or sum(x is not None for x in p[-252:]) < 240:
        return None  # at least 240 prices in the last year
    last252 = p[-253:]
    for x0, x1 in zip(last252, last252[1:]):  # skip names with a suspect data jump (backtest rule)
        if x0 and x1 and (x1 / x0 > 1.8 or x1 / x0 < 0.45):
            return None
    vals = [by[d]["c"] * by[d]["v"] for d in cal[-126:] if d in by and by[d].get("c") and by[d].get("v") is not None]
    if not vals:
        return None
    value = median(vals)
    end, start = p[-1 - 21], p[-1 - 252]
    if not end or not start:
        return {"value": value, "score": None}
    ret = end / start - 1
    logs = [math.log(b / a) if a and b else None for a, b in zip(p[-253:], p[-252:])]
    vol = _std(logs)
    ma = [x for x in p[-REGIME_DAYS:] if x is not None]
    if not vol or not ma or p[-1] <= sum(ma) / len(ma):
        return {"value": value, "score": None}  # below its own 200-day average: not picked
    return {"value": value, "score": ret / (vol * math.sqrt(252)), "ret": ret}


def rank(prices, cal):
    """prices = {symbol: bars}. Returns [(symbol, score)] best first: the UNIVERSE most traded eligible stocks,
    scored by 12-month return (skipping the last month) / yearly volatility, above their 200-day average."""
    rows = {}
    for sym, bars in prices.items():
        s = stock_score(bars, cal)
        if s is not None:
            rows[sym] = s
    uni = sorted(rows, key=lambda k: -rows[k]["value"])[:UNIVERSE]
    scored = [(k, rows[k]["score"]) for k in uni if rows[k]["score"] is not None]
    return sorted(scored, key=lambda kv: -kv[1])


def regime_ok(nifty_closes):
    """Nifty 50 above its 200-day average (closes up to the signal day)."""
    xs = [x for x in nifty_closes[-REGIME_DAYS:] if x]
    return bool(xs) and len(xs) >= REGIME_DAYS * 0.9 and nifty_closes[-1] > sum(xs) / len(xs)


def target(ranked, holdings, use_switch, regime):
    """Stocks to hold after the month-end check. Holdings still in the top KEEP stay; the best new names fill up to TOP.
    With the Nifty switch and Nifty below its 200-day average: hold nothing."""
    if use_switch and not regime:
        return []
    names = [s for s, _ in ranked]
    keep = [s for s in holdings if s in names[:KEEP]]
    tgt = keep + [s for s in names[:TOP] if s not in keep]
    return tgt[:max(TOP, len(keep))]


def sell_charges(gross):
    """Delivery charges on a sale worth `gross` rupees."""
    return gross * (STT + EXCH + SEBI) + gross * (EXCH + SEBI) * GST + DP_PER_SELL


def buy_qty(money, open_px):
    """(fill price, shares, charges) spending `money` at the open. Paper books use fractional shares like the backtest;
    whole shares are shown in the alert for real use."""
    px = open_px * (1 + SLIP)
    spend = money / (1 + STT + STAMP_BUY + (EXCH + SEBI) * (1 + GST))
    return px, spend / px, money - spend
