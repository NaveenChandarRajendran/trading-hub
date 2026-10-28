"""
sell_rules.py - the three option SELLING rules of the app's Rs 3 lakh "Selling" paper book (owner approved 28-Oct-2026).
docs/strategies/option-selling.md is the written rule; this file must match it. PAPER ONLY. Pure functions: no I/O, no
clock; sell_desk.py runs them.

1. Expiry Straddle (sellStraddle): NIFTY, on the day of the nearest NIFTY expiry only. 09:20 sell the ATM call and the
   ATM put of that expiry, 1 lot each. Each leg has its own stop at +50 % of its sell price. When one leg's stop fills,
   the other leg's stop moves to its own sell price (cost). Whatever is open buys back at 15:14.
   5-year test (costs + 0.5 % slippage): +1.34 L on Nov 2021-Dec 2024, +41.7 k on 2025-26, profit every year.
2. Calm-day Call Sell (sellCalmCall): NIFTY, every trading day. On 60-minute candles (09:15-aligned, the 15:15 candle
   is the day's last), when the 09:15-10:14 candle closes, Bollinger width = 4 x population SD / mean of the last 20
   candle closes x 100 (across sessions). If width <= 1.34, sell the ATM call of the nearest expiry at 10:15, stop at
   +50 %, buy back at 15:14. (Found by the scalping search, research/scalping-search/; positive every year 2021-26.)
3. Two-month Strangle (sellStrangle): NIFTY, positional. With no strangle open, at 10:00 sell the call ~3 % above and
   the put ~3 % below spot (rounded to 100) of the expiry closest to 61 calendar days away (45-80 allowed). Once a day
   at 15:05: a leg that has kept 70 % of its premium (price <= 30 % of its sell price) is bought back and a new leg of
   the same type is sold 3 % from spot, same expiry ("roll"); if the strangle's total (booked rolls + open legs, after
   charges) is a loss of Rs 60,000 or more, everything is bought back. On expiry day everything buys back at 15:14.
   5-year estimate (Black-Scholes on India VIX, research/long-strangle/roll.py): about +8.9 k per 2-month cycle,
   worst cycle about -73 k.
4. Timed Expiry Straddles (sellStraddle940 / sellStraddle1126 / sellStraddle1224, owner approved 28-Oct-2026, from a
   Salem trader's Dhan podcast): the same expiry-day straddle as rule 1, sold again at 09:40 (stop +80 %), 11:26
   (stop +80 %) and 12:24 (stop +70 %), each its own pair, no move-to-cost, buy back at 15:14. 5-year test as one basket
   (research/timed-straddle/): +1.92 L on 2021-24, +1.34 L on 2025-26, profit every year, worst day about -25 k.
"""
from datetime import date, datetime
from statistics import fmean, pstdev

from sig_indicators import IST

STRADDLE, CALM, STRANGLE = "sellStraddle", "sellCalmCall", "sellStrangle"
S940, S1126, S1224 = "sellStraddle940", "sellStraddle1126", "sellStraddle1224"
STRADDLES = (STRADDLE, S940, S1126, S1224)  # expiry-day straddles, one pair each
RULES = (STRADDLE, CALM, STRANGLE, S940, S1126, S1224)
NAMES = {STRADDLE: "Expiry Straddle (sell)", CALM: "Calm-day Call Sell", STRANGLE: "2-month Strangle (sell)",
         S940: "Expiry Straddle 9:40 (sell)", S1126: "Expiry Straddle 11:26 (sell)", S1224: "Expiry Straddle 12:24 (sell)"}
SYMBOL = "NIFTY"

DEFAULTS = {
    "enabled": True, "capital": 300000, "lots": 1,
    STRADDLE: {"enabled": True, "entry": "09:20", "stopPct": 50, "trailToCost": True},
    CALM: {"enabled": True, "entry": "10:15", "maxWidth": 1.34, "bars": 20, "stopPct": 50},
    STRANGLE: {"enabled": True, "entry": "10:00", "check": "15:05", "awayPct": 3, "days": 61, "minDays": 45, "maxDays": 80,
               "rollAtPct": 70, "maxLoss": 60000},
    S940: {"enabled": True, "entry": "09:40", "stopPct": 80, "trailToCost": False},
    S1126: {"enabled": True, "entry": "11:26", "stopPct": 80, "trailToCost": False},
    S1224: {"enabled": True, "entry": "12:24", "stopPct": 70, "trailToCost": False},
    "timeExit": "15:14",
}


def hm(s):
    h, m = s.split(":")
    return int(h), int(m)


def config(cfg):
    """autopaper.json "selling" merged over DEFAULTS (one level deep)."""
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()}
    for k, v in (cfg or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def atm_strike(spot, step=50):
    return round(spot / step) * step


def is_expiry_day(expiries, today):
    """expiries: 'YYYY-MM-DD' from today on, nearest first (instruments.OptionInstruments.expiries)."""
    return bool(expiries) and expiries[0] == today.isoformat()


def hourly_closes(one_min):
    """1-minute candles [{"time": epoch s (IST minute start), "close"}] -> closes of 09:15-aligned 60-minute candles,
    oldest first; the 15:15 candle (15:15-15:29) is a session's last. Pass only minutes up to the decision time.
    Keyed by the minute's own time, so the order of the input does not matter."""
    out = {}
    for m in one_min:
        dt = datetime.fromtimestamp(m["time"], IST)
        mins = dt.hour * 60 + dt.minute - 555
        if not 0 <= mins < 375:
            continue
        key = (dt.date(), mins // 60)
        if key not in out or m["time"] >= out[key][0]:
            out[key] = (m["time"], m["close"])  # the bucket's last minute so far
    return [out[k][1] for k in sorted(out)]


def bb_width(closes, n=20):
    """4 x population SD / mean x 100 of the last n closes, or None with fewer."""
    if len(closes) < n:
        return None
    w = closes[-n:]
    return 4 * pstdev(w) / fmean(w) * 100


def calm_check(width, max_width):
    return width is not None and width <= max_width


def strangle_expiry(expiries, today, days=61, lo=45, hi=80):
    """The expiry closest to `days` calendar days away, inside [lo, hi]; None if there is none."""
    best = None
    for e in expiries:
        d = (date.fromisoformat(e) - today).days
        if lo <= d <= hi and (best is None or abs(d - days) < abs(best[1] - days)):
            best = (e, d)
    return best[0] if best else None


def strangle_strikes(spot, away_pct=3, step=100):
    """(call strike, put strike) about away_pct above / below spot."""
    return round(spot * (1 + away_pct / 100) / step) * step, round(spot * (1 - away_pct / 100) / step) * step


def roll_due(sell_price, ltp, roll_at_pct=70):
    """A strangle leg that has kept roll_at_pct % of its premium."""
    return ltp is not None and sell_price > 0 and ltp <= sell_price * (1 - roll_at_pct / 100)


def leg_stop(sell_price, stop_pct):
    """Buy-back trigger of a short leg, on the 0.05 tick grid (rounded up)."""
    raw = sell_price * (1 + stop_pct / 100)
    return round(-(-raw // 0.05) * 0.05, 2)

