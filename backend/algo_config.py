"""
algo_config.py - every number the OI breakout algo uses (rules: docs/strategies/oi-breakout.md). PAPER TRADING ONLY.

Mode: env ALGO_MODE = "paper" (default: paper orders in the "Algo" account) | "signals" (log only, no orders) | "off".
"""
import os
from datetime import time

MODES = ("paper", "signals", "off")
MODE = os.getenv("ALGO_MODE", "paper").strip().lower()
if MODE not in MODES:
    MODE = "signals"  # an unknown value never places orders

SYMBOLS = ("NIFTY", "BANKNIFTY")
ACCOUNT_NAME = "Algo"
CAPITAL = 100000.0

# levels: OI Support & Resistance Live's ranking (sr_levels.rank_levels), on the nearest-expiry chain, locked for the day
LEVELS_AT = time(9, 30)
LEVEL_RANGE = 500  # points either side of spot, OSR Live's default

CANDLE_MIN = 5  # closed 5-minute candles of the index spot, 09:15-aligned
BUFFER = {"NIFTY": 10, "BANKNIFTY": 25}  # points
PULLBACK_CANDLES = 6  # the pullback must come within this many candles after the break
MIN_RANGE_WIDTH = {"NIFTY": 100, "BANKNIFTY": 250}  # R1 - S1 for the range setup

# filters on the break candle
TOI_STRENGTH_MIN = 40.0  # Trending OI |strength %|, 5-minute rows
TOI_INTERVAL = 5
TOI_MAX_AGE_MIN = 11  # the newest Trending OI row must be at most this old (two 5-minute rows)
RSI_PERIOD = 14
RSI_CE = (50.0, 80.0)
RSI_PE = (20.0, 50.0)
COMPONENTS_NEUTRAL_BAND = 0.05  # index % points, same as the Dashboard card

# execution and risk
LOTS = 1
ENTRY_FROM, ENTRY_TO = time(9, 35), time(14, 30)
SQUARE_OFF = time(15, 15)
PREMIUM_STOP_PCT = 10.0  # exit when the option's LTP falls this % below the entry price
MAX_OPEN_PER_INDEX = 1
MAX_TRADES_PER_INDEX = 4
DAY_LOSS_STOP_PCT = 2.0  # of CAPITAL: no new entries after this day loss (realized + unrealized - charges)

# reliability
STALE_NO_ENTRY_SEC = 120
STALE_EXIT_SEC = 300  # with an open position: exit at market when data returns
STALE_RETRY_SEC = (30, 60, 120, 300)  # an index silent while the feed is up: resubscribe, then reconnect, backing off
HEARTBEAT_MIN = 15  # a heartbeat line in the decision log every 15 minutes during the session
SESSION_FROM, SESSION_TO = time(9, 15), time(15, 30)  # candles are evaluated only inside the session
ATM_STRIKES_EACH_SIDE = 1  # option strikes kept subscribed around ATM, so a market order always has a price
LOG_DIR = "logs"
