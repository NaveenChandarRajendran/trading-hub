# Momentum 20 (NSE stocks, monthly, two Rs 5 lakh PAPER books)

Owner: R. Diwakaran. Owner approved PAPER trading on 28-Oct-2026 ("run both side by side") after Claude's backtest
(Claude Doc "Stock momentum strategy test 28 Oct 2026", scripts + 2,016-version grid in project files
`research/stock-momentum/`). Code: `backend/momentum.py` (rules, pure) and `backend/momentum_book.py` (runs them).
PAPER ONLY: no Dhan order endpoint is used. Rule changes need the owner's OK.

## Rules (checked on the last trading day of each month, after the close)
1. Stocks: every NSE equity (series EQ). Eligible: traded on the check day, close >= Rs 20, at least 240 prices in
   the last 252 trading days, no one-day jump above +80 % or below -55 % in the last year (suspect data).
2. Universe: the 500 eligible stocks with the highest median daily traded value (close x volume) over 126 days.
3. Score: return from 252 to 21 trading days ago (12 months, skipping the last month) divided by the yearly
   volatility (standard deviation of daily log returns over 252 days x sqrt 252). Adjusted prices.
4. A stock must close above its own 200-day average to be picked.
5. Hold the top 20, equal money each. A holding stays while it ranks in the top 40; a stock that drops out is sold
   and the best new names fill up to 20.
6. Orders at the next trading day's open (paper: open +/- 0.1 % slippage). Delivery charges: STT 0.1 % both sides,
   stamp 0.015 % on buys, NSE 0.00297 %, SEBI, GST 18 % on those, DP Rs 15.93 per stock sold. Brokerage 0 (Dhan).
7. Two books, same ranking:
   - **with Nifty switch** (`momSwitch`): if Nifty 50 closes below its 200-day average on the check day, sell
     everything and hold cash until a later check finds it above again.
   - **no switch** (`momAll`): always follows rules 1-6.
No stop loss and no target (a 15 % stop made the backtest worse).

## Backtest (Yahoo daily prices 2010-2026, Rs 5 L, charges + slippage)
| | with switch | no switch | Nifty 50 (with dividends) |
|---|---|---|---|
| 2012-22 per year | 25.9 % | 34.9 % | 14.7 % |
| 2023-26 per year | 28.1 % | 41.0 % | 7.4 % |
| worst fall | -35 % | -47 % | -38 % |
Caveats: stocks delisted since 2010 are missing (survivorship bias); short-term tax (20 %) is not in the numbers.

## Running it
- Prices: Yahoo Finance daily bars (`query1/query2.finance.yahoo.com/v8/finance/chart`), stock list from NSE's
  EQUITY_L.csv (refreshed every 20 days; `backend/nse_equity_list.csv` is the fallback copy).
- 5-minute loop + on start-up: after 15:50 values the books and, on a month end, ranks (about 2,400 downloads,
  a few minutes) and phones the buy / sell list; from 09:35 the next trading day fills both books at the open.
  Missed days are caught up from history when the backend next runs.
- Paper books hold fractional shares and measure each holding's growth on Yahoo's adjusted prices (splits and
  dividends included). State: `data/books/momentum/state.json`. Settings: autopaper.json `momentum`.
- API: GET `/api/momentum/state`, POST `/api/momentum/run`. Today page card "Momentum 20 · stock books".
