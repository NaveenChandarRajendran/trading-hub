"""
trending_oi_algo_config.py - every number the Trending OI Algo uses (rules: docs/strategies/trending-oi-algo.md).
PAPER TRADING ONLY.

DEFAULTS are the values below; the page's Settings can override any of them (stored in Postgres, every change logged
with old -> new and the time). Open trades keep the SL and lots they were opened with; new decisions use the new values.
Mode: env TOI_ALGO_MODE = "paper" (default: paper orders in its own account) | "signals" (log only) | "off".
"""
import os
from datetime import time

MODES = ("paper", "signals", "off")
MODE = os.getenv("TOI_ALGO_MODE", "paper").strip().lower()
if MODE not in MODES:
    MODE = "signals"  # an unknown value never places orders

ALGO = "trending_oi"  # algo_* tables' `algo` column (the OI breakout algo is "oi_breakout")
STRATEGY_NAME = ACCOUNT_NAME = "Trending OI Algo"
CAPITAL = 500000.0
SYMBOL = "NIFTY"

DEFAULTS = {
    # direction (rule 1) and the no-trade filters (rule 2)
    "toiStrengthMin": 40.0,       # Trending OI |strength %| on the 5-minute rows
    "toiDotsMin": 2,              # strength dots (>= 60 % = 3, >= 40 % = 2, >= 20 % = 1)
    "flipLookbackMin": 30,        # no trade when the 5-minute sentiment changed within this many minutes
    "weakDayFrom": "10:30",       # from this time on: no new entries when the day range is below weakDayRangePct
    "weakDayRangePct": 0.4,       # (day high - day low) / spot, %
    "maxVwapDistPct": 0.8,        # |index - VWAP (index terms)| / spot, %
    "rsiMaxCE": 80.0,             # RSI(14) of 5-minute closes: no CE above, no PE below rsiMinPE
    "rsiMinPE": 20.0,
    # indicators
    "candleMin": 5,
    "supertrendPeriod": 10,
    "supertrendMult": 3.0,
    "rsiPeriod": 14,
    # entry (rules 3-6)
    "touchPts": 10.0,             # a candle low (CE) / high (PE) within this many index points of Supertrend or VWAP
    "entryLots": 2,
    "maxStopPct": 0.6,            # skip when the day-low (CE) / day-high (PE) stop is further than this % of spot
    # adds (rules 7-11)
    "avgAddLots": 2,              # averaging (against me) adds this many lots ...
    "avgMaxLots": 6,              # ... up to this many lots open
    "pyrAddLots": 1,              # pyramiding (my way) adds this many lots ...
    "pyrMaxLots": 4,              # ... up to this many lots open
    "maxLots": 6,                 # never more than this many lots open
    "addRiskMax": 10000.0,        # ₹: skip an add when the loss if the stop hits now (new lots included) exceeds this
    "deltaFallback": 0.6,         # when the chain has no delta for the strike
    # exits (rules 12-15)
    "partialMinPts": 20.0,        # a locked level counts for a partial exit only this many points beyond the entry
    "breakevenAtR": 1.0,          # no usable level beyond the entry: breakeven once in favour by this many R
    "squareOff": "15:15",
    # daily limits
    "entryFrom": "09:45",
    "entryTo": "14:30",
    "maxTrades": 2,               # entries per day (adds are not trades)
    "dayLossStopPct": 2.0,        # of CAPITAL: no new entries once realized + unrealized - charges reaches -this
    # strike (rule 4): 1 ITM, else the nearest liquid one in this order (logged), else skip
    "strikeFallback": ["ATM", "2ITM"],
}

LEVELS_AT = time(9, 30)  # OI S/R levels (sr_levels.rank_levels on the nearest-expiry chain), locked like the breakout algo
LEVEL_RANGE = 500
STALE_NO_ENTRY_SEC = 120  # no index tick for this long in market hours: no new entries (feed watchdog)


def merged(overrides=None):
    """DEFAULTS with the page's saved overrides (unknown keys are ignored, so an old setting can never break a day)."""
    out = dict(DEFAULTS)
    for k, v in (overrides or {}).items():
        if k in DEFAULTS:
            out[k] = v
    return out


def hhmm(value):
    """'09:45' -> time(9, 45)."""
    h, m = str(value).split(":")
    return time(int(h), int(m))
