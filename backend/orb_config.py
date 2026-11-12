"""
orb_config.py - every number the ORB Algo uses (rules: docs/strategies/orb.md). PAPER TRADING ONLY.

DEFAULTS are the values below; the page's Settings can override them (th_algo_settings, slug "orb"; every change logged
with old -> new, the time and the user). New decisions use a change at once; an open trade keeps its stop and lots.
Mode: env ORB_ALGO_MODE = "paper" (default: paper orders in its own account) | "signals" (log only) | "off".
"""
import os
from datetime import time

MODES = ("paper", "signals", "off")
MODE = os.getenv("ORB_ALGO_MODE", "paper").strip().lower()
if MODE not in MODES:
    MODE = "signals"  # an unknown value never places orders

SLUG = "orb"
STRATEGY_NAME = ACCOUNT_NAME = "ORB Algo"
CAPITAL = 500000.0
SYMBOL = "NIFTY"
SESSION_OPEN = time(9, 15)

# the three setups: key -> (name, opening-range minutes)
SETUPS = {"b60": ("60m Breakout", 60), "r30": ("30m Retest", 30), "v5": ("5m Reversal", 5)}

DEFAULTS = {
    "b60On": True,             # 60m Breakout on / off
    "r30On": True,             # 30m Retest on / off
    "v5On": True,              # 5m Reversal on / off
    "orSizePct": 0.5,          # OR size (high - low) as % of the day's open: 60m needs more, 30m at most this
    "entryBefore": "12:00",    # 60m Breakout and 5m Reversal: the signal candle starts before this
    "retestWithinMin": 60,     # 30m Retest: entry at most this many minutes after the first breakout
    "lots": 1,                 # per setup
    "dayLossStopPct": 2.0,     # no new entries once the day's loss reaches this % of CAPITAL
    "squareOff": "15:25",      # every open trade is sold then (this account's engine squares off then too, ADR 0013)
    "strikeFallback": [],      # when 1 ITM isn't liquid: nothing (no trade) by default; may add "ATM", "2ITM"
}

STALE_NO_ENTRY_SEC = 120  # no index tick for this long in market hours: no new entries (feed watchdog)
SUMMARY_AT = time(15, 35)
HEARTBEAT_MIN = 15


def merged(overrides=None):
    return {**DEFAULTS, **{k: v for k, v in (overrides or {}).items() if k in DEFAULTS}}


def hhmm(value):
    h, m = map(int, value.split(":"))
    return time(h, m)
