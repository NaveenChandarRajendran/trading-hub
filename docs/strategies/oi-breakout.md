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
- **Target**: the next level's zone: spot ≥ R2 − buffer (PE: spot ≤ S2 + buffer), or the option's LTP rises 20 %
  above the entry price, whichever comes first; checked on every tick.
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

## Rule variants (`RULE_VARIANT` in algo_config.py, env `ALGO_VARIANT`; live **B** since 26-Oct-2026)
The live variant places paper orders. The other three run as **shadows** on the same live candles and filter values:
signals only (never an order, no account, no day-loss limit), each logged with its variant tag; their would-be
entries record the ATM option's live price, exits use the same target / spot stop / premium stop / 15:15 rules, and
the result is measured in index points. 23-Oct ran A live (before shadows existed).
- **A**: filters checked only on the break candle (Setup 1 above).
- **B**: after a break of R1 / S1 the setup stays armed for 6 candles and the filters are re-checked on every candle;
  entry on a pullback candle if they pass at that moment. A close back through the level (by the buffer) cancels.
- **C**: B + continuation: no pullback within 3 candles, the filters pass and a candle closes beyond the break
  candle's high (CE) / low (PE) → enter.
- **D**: B + level ladder: R1–R3 / S1–S3 are all breakout levels, each targeting the next one (R3 / S3: no target,
  exit by stop or 15:15). A broken level stays armed until a close back through it (no 6-candle expiry), so a later
  retest from the other side is a pullback.
- **No room** (every variant, breakout and range entries): skip when spot is already at or through the target zone
  (on 23-Oct BANKNIFTY the 09:50 breakdown closed at 54,607.7 with its S2 zone at 54,625 already passed).

## Replay
`python algo_replay.py --date 2026-10-23 --variants A,B,C,D --source db|dhan` (backend folder). `dhan`: historical
1-minute candles (index + the option traded), booked in paper accounts "Replay <variant>"; needs a valid token. `db`:
the day's stored candles and RSI (algo_candles) and locked levels (algo_levels), index points only. OI filters are checked when the day has option-chain
snapshots (saved every minute since 24-Oct) and Trending OI history; else the report says "OI not checked".
Report: `backend/logs/replay-<date>.md` / `.json`.

## Execution and risk
- ATM option (strike nearest spot) of the nearest expiry (the next one on expiry day), 1 lot, market order on the
  paper engine (fills against the live order book).
- New entries 09:35–14:30 (candle close time). Square-off 15:15.
- Per index: 1 open position, at most **2 trades a day** (NIFTY 2 + BANKNIFTY 2). NIFTY and BANKNIFTY run independently.
- **A win ends the index's day** (from 26-Oct-2026): trade 1 closed in profit → no more entries for that index; trade 1
  in loss → trade 2 is allowed, and after trade 2 the index is done whatever its result. Profit = P&L after charges
  above ₹0 (shadows and replays use the paper engine's charges for 1 lot). Exits: premium −10 % stop, premium +20 %
  target or the level target zone, spot stop, 15:15 square-off.
- No new entries once the Algo account's day P&L (realized + unrealized − charges) is ≤ −2 % of ₹1,00,000.

## Reliability
- Feed watchdog (dhan_feed.py): recv() is polled every 5 s; no packet for 2 minutes in market hours drops and re-makes
  the connection with backoff. Every disconnect, stale feed and reconnect attempt is logged.
- Feed window (27-Oct, after the 26-Oct pre-market storm): the feed connects only 09:00–15:35 IST on trading days
  ("Feed idle until 09:00" once otherwise) and only while the Dhan token is valid. A connection that drops within 10 s
  counts as a failed attempt (backoff keeps growing); HTTP 429 waits 60 s, doubling to 5 min. Repeated feed lines
  are collapsed: the first is logged, then "Feed connection lost ×37 in the last 5 min" every 5 minutes.
- Token check (read-only `GET /profile`) when the algo starts and at 09:00: one clear line in the log; an invalid
  token shows on the Algo page and keeps the feed idle until a new token is sent.
- Per-index watchdog (algo): no tick for 2 minutes → "Feed stale" in the log, then resubscribe / reconnect with backoff
  (30 s, 60 s, 2 min, 5 min; one feed action per 30 s), every attempt logged; "Feed back" when ticks return.
- Exceptions in the tick handler, candle builder and evaluation are logged with their traceback (decision log + file);
  the loop keeps running. A heartbeat line every 15 minutes (last tick time and spot per index, feed state).
- Candles are evaluated only inside 09:15–15:30 and only when they open at or after the 09:30 level lock.
- Spot data older than 2 minutes: no new entries. Older than 5 minutes with a position open: exit at market when data
  returns. Dhan token expired: no new entries (logged). The feed reconnects by itself (dhan_feed.py).
- Restart: levels, setups, open trade, trade count and closed trades come back from the store; a candle is never
  evaluated twice (its time is saved before any order), so a signal is never entered twice.
- Kill switch: `POST /api/algo/stop` (no new entries), `POST /api/algo/stop-exit-all`, `POST /api/algo/resume`; buttons
  on the Algo page.

## Decision log and reports (Postgres)
Every level lock, armed setup, skip (with each filter value), cancel, expiry, entry, exit, error, feed event and
heartbeat goes to `algo_events` (with index, variant, type), every evaluated candle with its RSI and filter values to
`algo_candles`, the locked levels to `algo_levels`, and a daily summary per index and variant to `algo_daily_summary`
at 15:35 IST. `backend/logs/algo-YYYY-MM-DD.log` is a write-only plain-text backup; the app never reads it.
The Algo page's Reports view (date range, tiles, day-wise table, variant comparison, day view, CSV) reads these tables. Each closed trade keeps its entry / exit time,
prices, spot, and the full reason for both, for the end-of-day review ("Copy review" on the Algo page).
