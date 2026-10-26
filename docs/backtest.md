# Backtest (5 years, Dhan data)

Owner's request 25-Oct-2026: test the auto rules on past data, not only on the paper trades until 15 Nov.
Code: `backend/bt_data.py` (download + cache), `backend/backtest.py` (engine, report), `backend/bt_service.py`
(GET /api/backtest/status, POST /api/backtest/run, GET /api/backtest/results). Screen: the **Backtest** page in the app
(`frontend/src/apps/backtest`): tick strategies, see totals, profit curve, year by year, month by month, exits and
trades; "Run backtest" works after market hours only. Command line alternative: `Run_Backtest.bat`.
READ ONLY: market data only, no orders.

## Data (Dhan Data API, checked 25-Oct-2026)
- Index 1-minute candles NIFTY / BANKNIFTY / INDIA VIX, last 5 years (from Nov 2021), 90 days per call.
- Option prices per minute, "rolling" by moneyness (ATM, ATM±N; each row carries its strike), last 5 years, 30 days
  per call, with OI. Downloaded: calls and puts ATM−10…ATM+10 (Dharani's ₹250 / ₹500 premium pick, and the OI for
  Trend Rules). Far from expiry Dhan may not give the outer strikes; such a piece is saved empty (an error on the inner
  strikes still stops the download). Files `opt2_*` (the first version's `opt_*` files had no OI and are not read).
  A fixed strike's price path is rebuilt from these series; a minute with no row keeps the last price.
- Nearest expiry: NIFTY weekly; BANKNIFTY weekly until 20-Nov-2024, monthly after (SEBI change).
- No intraday data for expired futures; past option OI only for the rolling strikes (ATM±10), no settled previous-day OI.
- Cache: `backend/data/backtest/` (not in git). Re-running downloads only what is missing.

## What is tested, and what is left out
| strategy | tested as | left out (no past data) |
|---|---|---|
| 4 Pillar Rules (both indices) | rules as live, 5-min | PCR pillar, OI-wall room, OI R1/S1 as triggers; VWAP = day's average price (no futures volume) |
| SuperTrend Rules (both indices) | rules as live, 5-min | OI-wall room, OI R1/S1 as triggers |
| Dharani Rules (both indices) | rules as live, 3-min, SuperTrend exit | put side reads the index instead of futures |
| Trend Rules (both indices) | APPROXIMATE (≈ on the page): the live rule, with Trending OI rebuilt from past option OI | Trending OI counted from 09:15 (live: from the previous day's settled OI); Dhan OI view on ATM±10 only (live: up to ±25); VWAP as above |
Cumulative delta is "not checked" live as well.

## Fills and costs
Buy at the option's open in the minute the signal candle closes. Stop / target when a minute's low / high crosses them
(a gap: that minute's open); both in one minute = stop first. Time exit 15:14. Dhan's charges at today's rates
(`paper_charges.py`) on both orders, plus slippage 0.5 % of premium per order (results also without slippage).
One lot at today's lot size (NIFTY 65, BANKNIFTY 30) in every year. Max 6 trades a day per rule and index.
The live rule rolls to the next expiry on expiry day; the backtest stays on the nearest (as Quantman's "current week").

## Output
`backend/data/backtest/results.json` (per strategy and index, and per strategy on both indices: trades, net, win %, average win / loss, max drawdown,
worst losing streak, exits by kind, year by year) and `trades.csv` (every trade).

## Page
Chips: 4 Pillar Rules, SuperTrend Rules, Dharani Rules, Trend Rules ≈ (each covers both indices); Index: Both / Nifty /
Bank Nifty. Results from the first version (names "MegaBull 4 Pillar", "MegaBull SuperTrend Nifty", "Dharani") still
show under the new names.

## Stop / target and expiry test (owner 26-Oct-2026, `bt_variants.py`)
Same engine and costs. Pairs -10/+20, -15/+20, -10/+15, -20/+30; expiry handling: all days, skip expiry day, skip expiry
day + the day before, wider stop (+10 points) on those two days. Expiry days come from the data: the nearest-expiry ATM
straddle at least doubles from one close to the next open only when the series rolls (260 Nifty, 181 Bank Nifty found).
Output `variants.json` / `variants.csv`. Result 26-Oct: all 48 combinations lose over 5 years.

## New strategy search (owner 26-Oct-2026, `strategy_research.py`, `research_data.py`)
Six buying ideas (ORB, previous-day high/low break, trend pull-back, momentum breakout, Bollinger and VWAP reversion), ATM
option, fixed or trailing exits. Chosen on 2021-11..2024-12 only (each of 2022-24 positive, PF >= 1.1, 60+ trades), then
run once on 2025-01..2026-10. Selling the opposite ATM option is reported for information only. `research_data.py` turns
the cache into per-day arrays (`research_<SYM>.pkl`). Output `research_results.json`, `research_trades.csv`,
`research_report.md`. Result 26-Oct: 0 of 61 passing settings made money in 2025-26.
