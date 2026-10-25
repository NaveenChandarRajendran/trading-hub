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
  per call. Downloaded: calls ATM−6…ATM+4, puts ATM−4…ATM+6 (the ITM side is deeper for Dharani's ₹250 / ₹500 premium).
  A fixed strike's price path is rebuilt from these series; a minute with no row keeps the last price.
- Nearest expiry: NIFTY weekly; BANKNIFTY weekly until 20-Nov-2024, monthly after (SEBI change).
- No intraday data for expired futures and no past option chain OI per minute.
- Cache: `backend/data/backtest/` (not in git). Re-running downloads only what is missing.

## What is tested, and what is left out
| strategy | tested as | left out (no past data) |
|---|---|---|
| MegaBull 4 Pillar (BANKNIFTY) | rules as live, 5-min | PCR pillar, OI-wall room, OI R1/S1 as triggers; VWAP = day's average price (no futures volume) |
| MegaBull SuperTrend Nifty | rules as live, 5-min | OI-wall room, OI R1/S1 as triggers |
| Dharani (both indices) | rules as live, 3-min, SuperTrend exit | put side reads the index instead of futures |
| Trend | not tested | its must-haves need minute-by-minute OI of the whole chain |
Cumulative delta is "not checked" live as well.

## Fills and costs
Buy at the option's open in the minute the signal candle closes. Stop / target when a minute's low / high crosses them
(a gap: that minute's open); both in one minute = stop first. Time exit 15:14. Dhan's charges at today's rates
(`paper_charges.py`) on both orders, plus slippage 0.5 % of premium per order (results also without slippage).
One lot at today's lot size (NIFTY 65, BANKNIFTY 30) in every year. Max 6 trades a day per rule and index.
The live rule rolls to the next expiry on expiry day; the backtest stays on the nearest (as Quantman's "current week").

## Output
`backend/data/backtest/results.json` (per strategy and index: trades, net, win %, average win / loss, max drawdown,
worst losing streak, exits by kind, year by year) and `trades.csv` (every trade).
