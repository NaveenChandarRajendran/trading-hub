# Rebound Call (BankNifty, found by the 5-year strategy search)

Owner: R. Diwakaran. Source: Claude's broad 5-year backtest search of 27-Oct-2026 (Claude Doc "New strategy search
27 Oct 2026"; scripts in `research/strategy-search-v2/`). Owner approved PAPER trading on 27-Oct-2026 ("lets go with both").
Code: `backend/sig_rebound.py` (internal id reboundCall). PAPER ONLY, on its own **Rebound Call** paper account
(Rs 1,00,000, `strategy_books.py`, key "rebound"). Tracked in the Excel tab "Option Buy - Rebound Call".
Rule changes need the owner's OK.

## Idea
After a deep, fast fall, BankNifty often snaps back. Buy a call only when the index is far below its long average,
down on the day, and has already started climbing back toward the day's average price.

## Data
BANKNIFTY index only. 5-minute candles, 09:15-aligned, IST; evaluated after every 5-minute close.
EMA and ATR run on 5-minute closes across sessions (12 sessions loaded).

## Entry: CALL only, first candle of the day where all hold
| check | condition |
|---|---|
| deep fall | close <= EMA 200 - 4.09 x ATR 14 |
| down today | close <= today's open - 0.11 x average daily range (high - low) of the 10 sessions before today |
| bouncing | close >= VWAP - 0.38 x ATR 14 (VWAP = running mean of (H+L+C)/3 of today's 5-minute candles, no volume) |
| window | candle closing 09:20 to 14:30 |

One trade a day (the day's first signal only). No trade while the account already holds a position.

## Trade
Buy the ATM call (1 lot, 30 qty) at the next minute. Stop -25 %, target +50 % of the entry premium
(`autopaper.json` reboundCall), else the 15:14 time exit. Switch: `reboundCall.enabled`.

## Backtest (costs: Dhan charges + 0.5 % slippage per order)
Tuned 2021-24: +1.39 L. Checked 2025-26 (not used for tuning): +64.5 k. Thresholds are the 20th / 40th / 40th
percentiles of 2021-24 BANKNIFTY candles; nearby values also stayed profitable.
