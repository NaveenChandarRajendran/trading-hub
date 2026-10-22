"""
algo_filters.py - the live apps' verdicts, for the algo running in the backend without a browser. Pure.

These are line-for-line ports of the frontend functions the apps and Dashboard cards use; test_algo_filters.py checks
them against values produced by the TypeScript code on the same fixtures. Change both together.
  oi_change_verdict  <- option-strategy/logic/oiCalculation.ts analyzeOptionChain (+ shared/dhan/chainAdapter toOptionChain)
  components_verdict <- components/logic/components.ts buildRows + summarize, prevClose.ts selectPrevClose,
                        dashboard/logic/cards.ts componentsCard (neutral band 0.05 index % points)
  rsi                <- dashboard/logic/indicators.ts rsi (Wilder, = TradingView ta.rsi)
Trending OI (calc.py) and the S/R ranking (sr_levels.rank_levels) are already Python and are used as they are.
"""
import json
import os
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
STRIKE_INTERVAL = {"BANKNIFTY": 100, "NIFTY": 50}  # oiCalculation.ts INTERVAL_BY_SYMBOL
WINDOW_SIZES = (5, 10, 15, 20, 25)
CONSTITUENTS = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "apps", "components", "config",
                            "constituents.json")


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return v if v == v else 0.0  # NaN -> 0


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def oi_change_verdict(symbol, spot, oc, lot_size=1):
    """OI & OI Change Live's verdict on a Dhan chain ({strike: {"ce": {...}, "pe": {...}}}).
    Returns {"verdict": "BULLISH" | "BEARISH" | "NEUTRAL", "average": final average, "points": average - spot}."""
    lot = lot_size if lot_size and lot_size > 0 else 1
    interval = STRIKE_INTERVAL.get(symbol, 100)
    rows = []
    for k, v in sorted(((float(s), v) for s, v in oc.items()), key=lambda kv: kv[0]):
        if k <= 0:
            continue
        ce, pe = v.get("ce") or None, v.get("pe") or None
        call_oi = _num(ce.get("oi")) / lot if ce else 0.0
        call_chg = (_num(ce.get("oi")) - _num(ce.get("previous_oi"))) / lot if ce else 0.0
        put_oi = _num(pe.get("oi")) / lot if pe else 0.0
        put_chg = (_num(pe.get("oi")) - _num(pe.get("previous_oi"))) / lot if pe else 0.0
        call_net, put_net = call_oi + call_chg, put_oi + put_chg
        total = call_net + put_net
        call_pct = call_net / total if total else 0.0
        rows.append((k, k - call_pct * interval))
    if not rows:
        return {"verdict": "NEUTRAL", "average": 0.0, "points": 0.0 - spot}
    atm = 0
    for i, (k, _) in enumerate(rows):
        if abs(k - spot) < abs(rows[atm][0] - spot):
            atm = i
    windows = [_mean([a for _, a in rows[max(0, atm - n):min(len(rows) - 1, atm + n) + 1]]) for n in WINDOW_SIZES]
    average = _mean(windows)
    points = average - spot
    return {"verdict": "BULLISH" if points > 0 else "BEARISH" if points < 0 else "NEUTRAL", "average": average,
            "points": points}


def load_constituents(path=CONSTITUENTS):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def ist_date(epoch_s):
    return datetime.fromtimestamp(epoch_s, IST).date().isoformat()


def select_prev_close(timestamps, closes, now):
    """Close of the last daily candle dated strictly before today (IST)."""
    today = now.astimezone(IST).date().isoformat()
    for i in range(min(len(timestamps), len(closes)) - 1, -1, -1):
        if ist_date(timestamps[i]) < today:
            c = closes[i]
            return c if c and c > 0 else None
    return None


def components_verdict(constituents, quotes, history, now, band=0.05):
    """Index Components card verdict. constituents: [{name, symbol, weight}]; quotes: {symbol: ltp};
    history: {symbol: {"timestamp": [...], "close": [...]}} (daily candles). No verdict (None) while any stock's
    previous close is still missing, as on the Dashboard card. Returns {"verdict", "indexMove", "priced", "total"}."""
    move, priced, missing = 0.0, 0, 0
    for c in constituents:
        h = history.get(c["symbol"])
        if h is None:
            missing += 1
        ltp = quotes.get(c["symbol"])
        if ltp is None or h is None:
            continue
        prev = select_prev_close(h.get("timestamp", []), h.get("close", []), now)
        if not prev:
            continue
        change_pct = (ltp - prev) / prev * 100
        move += c["weight"] / 100 * change_pct
        priced += 1
    out = {"indexMove": move, "priced": priced, "total": len(constituents), "verdict": None}
    if missing or not priced:
        return out
    out["verdict"] = "Bullish" if move > band else "Bearish" if move < -band else "Neutral"
    return out


def rsi(closes, period=14):
    """Wilder's RSI per close (None until period + 1 closes), same as indicators.ts / TradingView ta.rsi."""
    out = [None] * len(closes)
    if len(closes) <= period:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gain += max(d, 0.0)
        loss += max(-d, 0.0)
    gain /= period
    loss /= period

    def value():
        return (50.0 if gain == 0 else 100.0) if loss == 0 else 100 - 100 / (1 + gain / loss)

    out[period] = value()
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (period - 1) + max(d, 0.0)) / period
        loss = (loss * (period - 1) + max(-d, 0.0)) / period
        out[i] = value()
    return out
