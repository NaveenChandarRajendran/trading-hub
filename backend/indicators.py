"""
indicators.py - Supertrend, session VWAP and the futures basis, for the Trending OI Algo. Pure: candle lists in, value
lists out (one value per candle, None until the indicator has enough data). RSI is algo_filters.rsi (TradingView).

Supertrend: TradingView's ta.supertrend(factor, atrPeriod), bar for bar:
    atr  = ta.atr(atrPeriod) = RMA of the true range (first TR = high - low; RMA seeded with the SMA of the first
           `period` TRs, then atr = (prev * (period - 1) + tr) / period)
    up   = hl2 - factor * atr  (support band),  dn = hl2 + factor * atr  (resistance band)
    up   = up > prevUp or prevClose < prevUp ? up : prevUp         (it only rises while price stays above it)
    dn   = dn < prevDn or prevClose > prevDn ? dn : prevDn         (it only falls while price stays below it)
    direction: first bar with an ATR = down; after that, from the down band: up when close > dn; from the up band:
               down when close < up.   Supertrend = up band in an uptrend, dn band in a downtrend.
VWAP: session VWAP of the NIFTY future, Σ(typical price × volume) / Σ volume from the session's first candle, typical
    price = (high + low + close) / 3, reset every IST day.
Index terms (the algo's levels and stop are index prices): basis = future price − index price at the same moment;
    VWAP (index) = VWAP (future) − basis. The future trades at a premium that shrinks into expiry, so the current basis
    puts the future's VWAP on the index scale.
"""
from datetime import datetime

from store import IST


def atr(candles, period):
    """TradingView ta.atr (RMA of the true range) per candle; None for the first period - 1 candles."""
    out, trs, prev = [None] * len(candles), [], None
    for i, c in enumerate(candles):
        tr = c["high"] - c["low"] if i == 0 else max(c["high"] - c["low"], abs(c["high"] - candles[i - 1]["close"]),
                                                    abs(c["low"] - candles[i - 1]["close"]))
        trs.append(tr)
        if i == period - 1:
            prev = sum(trs) / period
        elif i >= period:
            prev = (prev * (period - 1) + tr) / period
        out[i] = prev
    return out


def supertrend(candles, period=10, mult=3.0):
    """[{"value": float, "up": bool} | None] per candle (None until the ATR exists). up = uptrend (the line is
    below price, TradingView green)."""
    a = atr(candles, period)
    out = [None] * len(candles)
    prev_up = prev_dn = prev_st_is_dn = None
    for i, c in enumerate(candles):
        if a[i] is None:
            continue
        hl2 = (c["high"] + c["low"]) / 2
        up, dn = hl2 - mult * a[i], hl2 + mult * a[i]
        prev_close = candles[i - 1]["close"] if i else None
        if prev_up is not None:
            up = up if (up > prev_up or prev_close < prev_up) else prev_up
            dn = dn if (dn < prev_dn or prev_close > prev_dn) else prev_dn
        if prev_up is None:  # first bar with an ATR (TradingView: na(atr[1]) -> direction 1 = down)
            uptrend = False
        elif prev_st_is_dn:
            uptrend = c["close"] > dn
        else:
            uptrend = not (c["close"] < up)
        out[i] = {"value": round(up if uptrend else dn, 2), "up": uptrend}
        prev_up, prev_dn, prev_st_is_dn = up, dn, not uptrend
    return out


def _day(c):
    return datetime.fromtimestamp(c["time"], IST).date()


def session_vwap(candles):
    """Session VWAP per candle from candles with volume (the future's 1- or 5-minute candles), reset each IST day.
    None until the session has traded volume."""
    out, day, pv, vol = [], None, 0.0, 0.0
    for c in candles:
        if _day(c) != day:
            day, pv, vol = _day(c), 0.0, 0.0
        v = float(c.get("volume") or 0)
        pv += (c["high"] + c["low"] + c["close"]) / 3 * v
        vol += v
        out.append(round(pv / vol, 2) if vol > 0 else None)
    return out


def vwap_index(vwap_future, future_price, index_price):
    """The future's VWAP on the index scale: VWAP - (future price - index price). None without all three."""
    if None in (vwap_future, future_price, index_price):
        return None
    return round(vwap_future - (future_price - index_price), 2)
