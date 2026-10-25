# Dharani v2 rule (teacher's tuned Quantman setups, copied as taught)

Owner: R. Diwakaran. Source: Dharmidharan's paid webinar video (owner's screenshots, 25-Oct-2026): Quantman setups
"L1 08 FINAL CE" and "L1 10 PE ALT", and owner answers 25-Oct-2026 ("replicate the same setup, the one with more
tuning"; SuperTrend trail exit; 3-minute candles). Code: `backend/sig_dharani_v2.py`. PAPER ONLY (MegaBull paper
account). Runs alongside Dharani v1 (`megabull.md`) until the 15 Nov review; tracked separately in the Excel.
The teacher's five further portfolio strategies are in his paid course and are not included.

## Data
NIFTY only (as the teacher tested it). 3-minute candles, 09:15-aligned, IST; evaluated ~35 s after every 3-minute close.
Call conditions use the NIFTY index; put conditions use the NIFTY near-month **futures** candles (his "Fields: Future").
Pivots / CPR from the previous trading day of the same data (index for the call, futures for the put).

## Entry (all conditions on the same completed candle)
| call ("L1 08 FINAL CE") | put ("L1 10 PE ALT") |
|---|---|
| close above SuperTrend (10, 2) | close below SuperTrend (10, 2) |
| RSI (14) above 70 | close below EMA 200 |
| close above R1 (Traditional pivots) | RSI (20) below 30 |
| close above upper Bollinger (15, 3) | CCI (20) below −200 |
| Williams %R (14) above −30 | Williams %R (14) below −85 |
| | close below CPR S1 (= Traditional S1) |
| | CPR is narrow: width (TC − BC) ÷ P below 0.2 % (⚠ our reading of Quantman's "Narrow range 0.2") |
| | close below lower Bollinger (20, 2) |

Order flow is not part of this setup.

## Trade
- Market BUY of 1 lot right after the signal candle closes. Option: current week (on its expiry day, the next), CE or
  PE, the strike whose last premium is nearest **₹250** (his "Premium near 250").
- Entry window: signal candles closing 09:18 to 15:00 (the teacher trades from 09:15).
- **Exit when a 3-minute candle closes back through SuperTrend** (call: index closes below the line; put: futures close
  above it). No fixed target. Safety stop: SL at fill × 0.90 (owner's MegaBull −10%). Hard exit 15:15 (the teacher's
  ends 15:28).
- One open v2 position at a time; a new entry is allowed after an exit when all conditions are true again. Never buys
  the option Dharani v1 holds. Daily limits are the MegaBull account's (6 trades, ₹10,000 loss; the teacher allows 10).
- Shadow log: SuperTrend on the side and exactly one other condition missed = skipped setup; a GO the account could
  not take (MegaBull off, Auto OFF, a limit) = "GO, not sent".
- Log: `Auto Paper Logs/dharani_v2_<day>.csv`, one row per 3-minute evaluation with every check's value.

## Teacher's backtest (NIFTY, 2019-04 to 2026-07, gross of costs, his numbers)
Call: 345 trades, ₹3.24 L, 51 % wins, max drawdown ₹8,717. Put: 268 trades, ₹2.97 L, 51 % wins, max drawdown ₹13,046.
Both: 627 trades, ₹6.12 L, max drawdown ₹14,973; at 0.5 % slippage equal to his untuned base version.
