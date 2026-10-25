"""
sig_indicators.py - chart indicators for the signal engine, with TradingView's definitions. Pure: lists in, lists out.

Every function takes plain lists (oldest first) and returns a list of the same length, None where there is not enough
data yet. The dashboard chart draws the same indicators in TypeScript (frontend/src/apps/dashboard/logic/indicators.ts);
both are tested against the same hand-checked values so the chart and the program never disagree.

    rsi        Wilder's RSI (ta.rsi): first average = mean of the first `period` changes, then RMA.
    ema        ta.ema seeded with the SMA of the first `period` closes.
    sma        simple mean of the last `period` values.
    stdev      population standard deviation (ta.stdev, biased=true), as Bollinger Bands use it.
    bollinger  basis = SMA(20), upper / lower = basis +/- 2 x stdev(20).
    atr        ta.atr: RMA of the true range, seeded with the SMA of the first `period` true ranges.
    supertrend ta.supertrend(factor, atrPeriod) on hl2. direction -1 = up (green line under price), +1 = down (red).
    vwap       session VWAP: running sum(typical price x volume) / sum(volume), reset each IST day.
               An index has no volume, so the near-month future's volume is used (as on the chart).
    pivots     Traditional floor pivots from the previous day's high / low / close (TradingView "Pivots Standard").
    williams_r Williams %R: (highest high - close) / (highest high - lowest low) x -100 over `period` candles (0 to -100).
    cci        Commodity Channel Index: (typical price - SMA) / (0.015 x mean absolute deviation), typical = (H+L+C)/3.
    cpr        Central Pivot Range from the previous day: P, BC = (H+L)/2, TC = 2P - BC, width % = |TC-BC| / P x 100.
"""
import math
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def sma(values, period):
    out = [None] * len(values)
    run = 0.0
    for i, v in enumerate(values):
        run += v
        if i >= period:
            run -= values[i - period]
        if i >= period - 1:
            out[i] = run / period
    return out


def stdev(values, period):
    """Population standard deviation over the last `period` values (TradingView ta.stdev default)."""
    out = [None] * len(values)
    for i in range(period - 1, len(values)):
        w = values[i - period + 1:i + 1]
        m = sum(w) / period
        out[i] = math.sqrt(sum((x - m) ** 2 for x in w) / period)
    return out


def ema(values, period):
    out = [None] * len(values)
    if len(values) < period:
        return out
    e = sum(values[:period]) / period
    out[period - 1] = e
    k = 2 / (period + 1)
    for i in range(period, len(values)):
        e += k * (values[i] - e)
        out[i] = e
    return out


def rsi(closes, period=14):
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
        if loss == 0:
            return 50.0 if gain == 0 else 100.0
        return 100 - 100 / (1 + gain / loss)

    out[period] = value()
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (period - 1) + max(d, 0.0)) / period
        loss = (loss * (period - 1) + max(-d, 0.0)) / period
        out[i] = value()
    return out


def bollinger(closes, period=20, mult=2.0):
    """(basis, upper, lower), each a list."""
    basis = sma(closes, period)
    dev = stdev(closes, period)
    upper = [None if b is None else b + mult * d for b, d in zip(basis, dev)]
    lower = [None if b is None else b - mult * d for b, d in zip(basis, dev)]
    return basis, upper, lower


def true_range(highs, lows, closes):
    out = []
    for i, (h, l) in enumerate(zip(highs, lows)):
        if i == 0:
            out.append(h - l)
        else:
            pc = closes[i - 1]
            out.append(max(h - l, abs(h - pc), abs(l - pc)))
    return out


def atr(highs, lows, closes, period=10):
    tr = true_range(highs, lows, closes)
    out = [None] * len(tr)
    if len(tr) < period:
        return out
    a = sum(tr[:period]) / period
    out[period - 1] = a
    for i in range(period, len(tr)):
        a = (a * (period - 1) + tr[i]) / period
        out[i] = a
    return out


def supertrend(highs, lows, closes, period=10, factor=2.0):
    """(line, direction): direction -1 = uptrend (green, line under price), +1 = downtrend (red, line above price).
    Same steps as TradingView's ta.supertrend, starting from the first bar that has an ATR."""
    n = len(closes)
    a = atr(highs, lows, closes, period)
    line, direction = [None] * n, [None] * n
    prev_up = prev_lo = prev_st = None
    for i in range(n):
        if a[i] is None:
            continue
        src = (highs[i] + lows[i]) / 2
        up, lo = src + factor * a[i], src - factor * a[i]
        if prev_lo is not None:
            lo = lo if (lo > prev_lo or closes[i - 1] < prev_lo) else prev_lo
            up = up if (up < prev_up or closes[i - 1] > prev_up) else prev_up
        if prev_st is None:  # first bar with an ATR (TradingView: na(atr[1]) -> direction 1)
            d = 1
        elif prev_st == prev_up:
            d = -1 if closes[i] > up else 1
        else:
            d = 1 if closes[i] < lo else -1
        st = lo if d == -1 else up
        line[i], direction[i] = st, d
        prev_up, prev_lo, prev_st = up, lo, st
    return line, direction


def ist_day(epoch_s):
    return datetime.fromtimestamp(epoch_s, IST).date()


def vwap(times, highs, lows, closes, volumes):
    """Session VWAP on hlc3, reset at each IST day. None while the day's volume is still 0."""
    out = [None] * len(closes)
    day = None
    pv = vol = 0.0
    for i in range(len(closes)):
        d = ist_day(times[i])
        if d != day:
            day, pv, vol = d, 0.0, 0.0
        v = volumes[i] or 0.0
        pv += (highs[i] + lows[i] + closes[i]) / 3 * v
        vol += v
        out[i] = pv / vol if vol > 0 else None
    return out


def pivots(high, low, close):
    """Traditional floor pivots from the previous session."""
    p = (high + low + close) / 3
    rng = high - low
    return {
        "P": p, "R1": 2 * p - low, "S1": 2 * p - high, "R2": p + rng, "S2": p - rng,
        "R3": high + 2 * (p - low), "S3": low - 2 * (high - p),
    }


def williams_r(highs, lows, closes, period=14):
    out = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        hh, ll = max(highs[i - period + 1:i + 1]), min(lows[i - period + 1:i + 1])
        out[i] = (hh - closes[i]) / (hh - ll) * -100 if hh > ll else -50.0
    return out


def cci(highs, lows, closes, period=20):
    tp = [(h + l + c) / 3 for h, l, c in zip(highs, lows, closes)]
    out = [None] * len(tp)
    for i in range(period - 1, len(tp)):
        w = tp[i - period + 1:i + 1]
        m = sum(w) / period
        md = sum(abs(x - m) for x in w) / period
        out[i] = (tp[i] - m) / (0.015 * md) if md else 0.0
    return out


def cpr(high, low, close):
    """Central Pivot Range from the previous session. Traditional S1 / R1 come from pivots()."""
    p = (high + low + close) / 3
    bc = (high + low) / 2
    tc = 2 * p - bc
    return {"P": p, "BC": min(bc, tc), "TC": max(bc, tc), "widthPct": abs(tc - bc) / p * 100 if p else None}
