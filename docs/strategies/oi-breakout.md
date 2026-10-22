# Strategy: OI breakout algo (paper only)

Status: approved by Naveen 23-Oct-2026 (first live paper day 23-Oct). Code: `backend/algo_logic.py` (rules),
`backend/algo_service.py` (runner), every number in `backend/algo_config.py`. PAPER TRADING ONLY: orders go to the
paper engine's "Algo" account (₹1,00,000); there is no code path to Dhan's order APIs.

## Mode
`ALGO_MODE` env: `paper` (default, paper orders) · `signals` (decision log and would-be trades, no orders) · `off`.

## Levels (locked for the day)
At 09:30 IST, per index: S1–S3 / R1–R3 from the nearest-expiry option chain with OI Support & Resistance Live's ranking
(top call OI from spot to spot + 500 for R, top put OI from spot − 500 to below spot for S, nearest first). They do not
change during the day. A backend started after 09:30 locks them at start (logged as late); a restart reuses the saved set.

## Data
- 5-minute candles of the index spot, 09:15-aligned, built from the live feed's ticks (Dhan intraday 1-minute
  candles fill earlier minutes and the previous session for RSI). A candle is evaluated 10 s after it closes.
- Filters, read at each candle close: Trending OI (newest 5-minute row; direction = sentiment, size = |strength %|;
  a row older than 11 minutes counts as missing), OI & OI Change Live's verdict (final average vs spot), Index
  Components card verdict (±0.05 index % points; no verdict until every previous close is loaded), RSI(14) Wilder on
  5-minute closes. Missing data fails the filter. The Python versions match the frontend functions (test_algo_filters.py).

Buffer: NIFTY 10, BANKNIFTY 25 points.

## Setup 1: Breakout CE / Breakdown PE
- **Break**: a candle closes above R1 + buffer (PE: below S1 − buffer).
- **Filters on the break candle** (CE / PE): Trending OI Bullish / Bearish with |strength| ≥ 40 %; OI change BULLISH /
  BEARISH; RSI 50–80 / 20–50; Index Components not Bearish / not Bullish. Any failure: logged skip with every value.
- **Pullback**: within the next 6 candles, a candle's low comes within the buffer of R1 (low ≤ R1 + buffer) and it
  closes above R1 (PE: high ≥ S1 − buffer, close below S1) → buy at once (= the next candle's open).
- **Cancel**: a close below R1 − buffer (PE: above S1 + buffer) before the pullback. **Expire**: no pullback in 6 candles.
- **Re-arm**: after a setup ends (entered, cancelled, expired, skipped), a new break needs a close back at or below R1
  (PE: at or above S1) first.
- **Target**: the next level's zone: spot ≥ R2 − buffer (PE: spot ≤ S2 + buffer), checked on every tick.
- **Stop**: a candle closes below R1 − buffer (PE: above S1 + buffer), or the option's LTP falls 10 % below the entry
  price, whichever comes first.

## Setup 2: Range (only when no breakout setup is armed and no position is open)
- **R1 rejection → PE**: the candle's high ≥ R1 and it closes below R1. Target S1 zone (spot ≤ S1 + buffer).
  Stop: a close above R1 + buffer, or premium −10 %.
- **S1 bounce → CE**: low ≤ S1 and close above S1. Target R1 zone (spot ≥ R1 − buffer). Stop: a close below
  S1 − buffer, or premium −10 %.
- Only if R1 − S1 ≥ 100 (NIFTY) / 250 (BANKNIFTY). Blocked when Trending OI is ≥ 40 % against the trade (Bullish
  blocks the PE, Bearish blocks the CE). A new touch needs a candle that did not touch the level first. A candle that
  started with a breakout setup armed is not used for range.

## Execution and risk
- ATM option (strike nearest spot) of the nearest expiry (the next one on expiry day), 1 lot, market order on the
  paper engine (fills against the live order book).
- New entries 09:35–14:30 (candle close time). Square-off 15:15.
- Per index: 1 open position, 4 trades a day. NIFTY and BANKNIFTY run independently.
- No new entries once the Algo account's day P&L (realized + unrealized − charges) is ≤ −2 % of ₹1,00,000.

## Reliability
- Spot data older than 2 minutes: no new entries. Older than 5 minutes with a position open: exit at market when data
  returns. Dhan token expired: no new entries (logged). The feed reconnects by itself (dhan_feed.py).
- Restart: levels, setups, open trade, trade count and closed trades come back from the store; a candle is never
  evaluated twice (its time is saved before any order), so a signal is never entered twice.
- Kill switch: `POST /api/algo/stop` (no new entries), `POST /api/algo/stop-exit-all`, `POST /api/algo/resume`; buttons
  on the Algo page.

## Decision log
Every candle, level lock, armed setup, skip (with each filter value), cancel, expiry, entry, exit and error goes to
the store (`algo_events`) and to `backend/logs/algo-YYYY-MM-DD.log`. Each closed trade keeps its entry / exit time,
prices, spot, and the full reason for both, for the end-of-day review ("Copy review" on the Algo page).
