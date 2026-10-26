# Trend Rules (Method S "Trend", formerly "Trading Hub rule")

Owner: R. Diwakaran. Source: BRIEF_Dashboard_and_AutoPaper.md (23-Oct-2026) + owner answers 23-Oct-2026.
Code: `backend/sig_rules.py` `trading_hub_rule`. PAPER ONLY, on the app's own **Trend** paper account (Rs 1,00,000,
`strategy_books.py`; owner 25-Oct-2026: one account per strategy). Both NIFTY and BANKNIFTY.

Evaluated on every completed 5-minute candle (09:15-aligned, IST). Put side shown; calls mirror it.

## Must-have (all three)
| id | check | put | call |
|---|---|---|---|
| supertrend | SuperTrend (10, 2) | red (down) and close below the line | green (up) and close above the line |
| trendingOi | Trending OI, last 3 completed 5-min rows, **and** Dhan OI & OI Change Live agrees | every row Strength % ≤ −50, and the OI & OI Change verdict is Bearish | every row ≥ +50, verdict Bullish |
| delta | cumulative delta agrees | estimated from Dhan ticks (Order flow page); **not checked** until the estimate matches Dext most of the time; does not block, trade tagged "delta not checked" | same |

Sensibull OI Change Live is **record only** (shown and logged, never a tick). The "Agreement" row compares Dhan with Sensibull for display only.

## Other checks
| id | check | put | call |
|---|---|---|---|
| pivot | price vs pivot | close < pivot | close > pivot |
| averages | price vs VWAP and EMA 20 | close below both | close above both |
| bbWidening | Bollinger (20, 2) widening | band width (upper − lower) of this candle > the previous candle's | same |
| bbOuter | price in the outer half of the band | close ≤ (basis + lower) ÷ 2 | close ≥ (basis + upper) ÷ 2 |
| rsi | RSI 14 | 30–45 = green; below 30 = borderline (weaker) | 55–70 = green; above 70 = borderline |

A check whose data is missing (for example VWAP before any futures volume) is **not checked**, which counts as "off".

## Grade
- **Grade A** = all must-haves green (delta "not checked" allowed) and every other check green.
- **Grade B** = all must-haves green and exactly ONE other check borderline, off or not checked.
- Anything else = **NO GO**.

## Gates (NO GO even with a grade)
One position per index on this account; no new entries after 14:30; market closed; Auto OFF; daily limit reached.
**No entries on the nearest expiry's day or the trading day before it** (owner 26-Oct-2026, from the 5-year backtest:
expiry-day Trend trades had profit factor 0.54, and skipping both days cut the 5-year loss from Rs 5.83 L to Rs 3.14 L).
Such a setup keeps its grade and goes to `shadow_skips.csv`, so those days' results are still tracked.
Switch in `autopaper.json` "rules": `trendSkipExpiryDays` (true).

## Trade
- Entry: market BUY of 1 lot at the next candle's open (right after the signal candle closes). Strike = ATM (nearest
  to spot), CE for calls / PE for puts, nearest expiry; on its expiry day, the next one.
- Stop = fill × 0.85 (−15%), placed as the pending SL-M SELL. Target = fill × 1.20, watched on LTP (the paper
  account allows one pending SELL per position): at target the stop is cancelled and a market SELL sent.
- Signal exit on a completed 5-min candle: Trending OI strength back inside −50% (put: > −50; call: < +50), or a candle
  closing beyond SuperTrend (put: close above the line; call: close below it).
- Exit by 15:15. Highest and lowest premium recorded.
- Shadow after every exit (record only, no order): the same option's premium until 15:30: highest after exit and its
  time, lowest, premium and spot at 15:15, SuperTrend still on the trade's side at 15:15 (Y/N), missed profit
  = (highest after exit − exit) ÷ entry. Trade log columns; owner's brief 23-Oct evening.
- Skipped setups (Trending OI or SuperTrend fired, but a must-have was missed or two or more other checks were off) go to
  `shadow_skips.csv` with the ATM option that would have been bought, tracked to 15:15 (target / stop first, Y / N).
- Volume Oscillator, VIX and PCR are recorded only.
