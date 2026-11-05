"""
clenow.py - Clenow "Stocks on the Move" weekly stock book, Rs 5 lakh PAPER (owner approved 5-Nov-2026 after the
2012-2026 test in project files research/stock-rules/: about 17 %/yr over the last 5 years, worst fall -21 %).
PAPER ONLY: prices from Yahoo Finance daily bars, like the Momentum 20 books (momentum_book.py runs the schedule).

Rules (research/stock-rules/strats.py "Clenow Stocks on the Move top20 weekly"):
- Universe: the 200 most traded NSE stocks (median traded value of the last 126 days), price >= Rs 20, at least 240
  prices in the last year.
- Score: 90-day exponential regression of the adjusted close: (e^(slope x 250) - 1) x R squared.
- A stock qualifies only above its 100-day average and with no daily move of 15 % or more in the last 90 days.
- Every week, after the close of the week's last trading day: hold the top 20 (equal money, about 1/20 of the book each).
  If Nifty 50 is below its 200-day average, hold nothing (sell all, cash) until it is back above.
- Trades at the next trading day's open, 0.1 % slippage, delivery charges (same as Momentum 20).
"""
import math
from datetime import date, timedelta
from statistics import median

import holidays
import momentum as M
from momentum_book import MomentumDesk

UNIVERSE, TOP, DAYS, MA_DAYS, MAX_GAP = 200, 20, 90, 100, 0.15


def regression_score(closes):
    """(e^(slope*250) - 1) * R^2 of log prices over the last DAYS closes, or None."""
    if len(closes) < DAYS or any(not c or c <= 0 for c in closes[-DAYS:]):
        return None
    y = [math.log(c) for c in closes[-DAYS:]]
    n = len(y)
    xm = (n - 1) / 2
    ym = sum(y) / n
    sxx = sum((i - xm) ** 2 for i in range(n))
    sxy = sum((i - xm) * (v - ym) for i, v in enumerate(y))
    syy = sum((v - ym) ** 2 for v in y)
    if syy == 0:
        return None
    b = sxy / sxx
    r2 = b * b * sxx / syy
    return (math.exp(b * 250) - 1) * r2


def stock_score(bars, cal):
    """{"value", "score"} for one stock at the last date of cal (score None = not picked), or None if not eligible."""
    if len(cal) < 253:
        return None
    by = {b["d"]: b for b in bars}
    today = by.get(cal[-1])
    if not today or not today.get("c") or today["c"] < M.MIN_PRICE:
        return None
    p = M.aligned(bars, cal)
    if p[-1] is None or sum(x is not None for x in p[-252:]) < 240:
        return None
    vals = [by[d]["c"] * by[d]["v"] for d in cal[-126:] if d in by and by[d].get("c") and by[d].get("v") is not None]
    if not vals:
        return None
    out = {"value": median(vals), "score": None}
    last = p[-(DAYS + 1):]
    if any(x is None for x in last):
        return out
    if max(abs(b / a - 1) for a, b in zip(last, last[1:])) >= MAX_GAP:
        return out  # a 15 % day in the last 90 days
    ma = p[-MA_DAYS:]
    if any(x is None for x in ma) or p[-1] <= sum(ma) / MA_DAYS:
        return out  # below its 100-day average
    out["score"] = regression_score(p)
    return out


def rank(prices, cal):
    rows = {s: x for s, x in ((s, stock_score(b, cal)) for s, b in prices.items()) if x is not None}
    uni = sorted(rows, key=lambda k: -rows[k]["value"])[:UNIVERSE]
    return sorted(((k, rows[k]["score"]) for k in uni if rows[k]["score"] is not None), key=lambda kv: -kv[1])


def target(ranked, regime):
    return [] if not regime else [s for s, _ in ranked[:TOP]]


class ClenowDesk(MomentumDesk):
    BOOKS, ACCOUNT, NAME = {"clenow": "Clenow · Stocks on the Move"}, "clenow", "CLENOW"

    def __init__(self, cfg, **kw):
        super().__init__({"start": "2026-11-06", "minStocks": 500, **(cfg or {})}, **kw)

    def _check_day(self, d, cal, today):
        """The week's last trading day."""
        i = cal.index(d)
        nxt = date.fromisoformat(cal[i + 1]) if i + 1 < len(cal) else holidays.next_trading_day(date.fromisoformat(d))
        return nxt.isocalendar()[1] != date.fromisoformat(d).isocalendar()[1]

    def _signal(self, d, cal, nifty):
        if d in self.state["signals"]:
            return
        dd = date.fromisoformat(d)
        i = cal.index(d)
        window = cal[max(0, i - 299):i + 1]
        bars = self.prices.many(self.symbols(), dd - timedelta(days=M_HISTORY))
        if len(bars) < self.cfg.get("minStocks", 500):
            raise IOError(f"only {len(bars)} stocks downloaded from Yahoo, ranking postponed")
        ranked = rank(bars, window)
        closes = [b["c"] for b in nifty[:i + 1]]
        avg = sum(closes[-M.REGIME_DAYS:]) / min(len(closes), M.REGIME_DAYS)
        sig = {"date": d, "regimeOk": M.regime_ok(closes), "nifty": round(closes[-1], 2), "nifty200": round(avg, 2),
               "ranked": [[s, round(v, 4)] for s, v in ranked[:TOP + 20]], "stocks": len(bars)}
        self.state["signals"][d] = sig
        self._save()
        self.on_text(self.signal_text(sig))

    def plan(self, key, sig):
        b = self.state["books"][key]
        tgt = target([tuple(x) for x in sig["ranked"]], sig["regimeOk"])
        return [s for s in b["holdings"] if s not in tgt], [s for s in tgt if s not in b["holdings"]]

    def signal_text(self, sig):
        nm = lambda s: s.replace(".NS", "")  # noqa: E731
        sells, buys = self.plan("clenow", sig)
        lines = [f"📈 CLENOW · weekly check {sig['date']}",
                 f"Nifty {sig['nifty']:,.0f} vs 200-day avg {sig['nifty200']:,.0f}: "
                 + ("ABOVE: hold the top 20" if sig["regimeOk"] else "BELOW: hold cash")]
        if not sells and not buys:
            lines.append("No change.")
        if sells:
            lines.append("SELL at next open: " + ", ".join(nm(s) for s in sells))
        if buys:
            lines.append("BUY at next open: " + ", ".join(nm(s) for s in buys))
        lines.append("\nPaper only.")
        return "\n".join(lines)

    def next_check(self):
        d = self.clock().date()
        while not holidays.is_trading_day(d) or holidays.next_trading_day(d).isocalendar()[1] == d.isocalendar()[1]:
            d += timedelta(days=1)
        return d.isoformat()


M_HISTORY = 430


def register(app, desk):
    import threading

    @app.get("/api/clenow/state")
    def state():
        return desk.status()

    @app.post("/api/clenow/run")
    def run():
        if not desk.busy:
            threading.Thread(target=desk.step, daemon=True).start()
        return {"ok": True}
