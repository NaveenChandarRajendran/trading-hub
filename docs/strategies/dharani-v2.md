# Dharani v2 rule (video rules)

Owner: R. Diwakaran. Source: Dharmidharan's paid webinar video, "Bullish Breakout Dashboard" slide (owner's screenshot,
25-Oct-2026), and owner answers 25-Oct-2026. Code: `backend/sig_rules.py` `dharani_v2_rule`. PAPER ONLY (MegaBull
paper account). Runs **alongside** Dharani v1 (`megabull.md`, built from the live-webinar notes) until the 15 Nov
review; both are tracked separately in the Excel.

## Conditions (all four on the completed 5-minute candle, 09:15-aligned, IST)
| # | indicator | call | put (mirror, owner 25-Oct) |
|---|---|---|---|
| 1 | SuperTrend (10, 2) | green, candle close above the ST line | red, close below the line |
| 2 | RSI (14) | above 70 | below 30 |
| 3 | Pivots (Traditional) | candle close above R1 | candle close below S1 |
| 4 | Bollinger (20, 2) | candle close above the upper band | candle close below the lower band |

All four TRUE = entry. Order flow: not checked (Dext not readable); does not block; trade tagged.

## Trade (owner, 25-Oct-2026)
- Entry: market BUY of 1 lot at the next candle's open, no confirmation candle. ATM strike, nearest expiry (on its
  expiry day, the next). NIFTY and BANKNIFTY.
- Not in the first 15 minutes (signal candle 09:30 or later); no entries after 15:00 (same as v1).
- Stop = fill × 0.90, target = fill × 1.20, hard exit 15:15; exits only on stop, target or 15:15 (same as v1).
- One open v2 position per index. v1 and v2 can each hold a trade on the same index, but v2 never buys the very option
  v1 already holds (the two positions would merge on MegaBull); that entry is skipped with an alert.
- Shared with the MegaBull account: daily limits (trades, loss) and the switch `megabull.enabled`; v2 alone can be
  turned off with `dharaniV2.enabled` in `autopaper.json`.
- Shadow log: SuperTrend on the side and exactly one of conditions 2-4 missed (3 of 4) = skipped setup, tracked to 15:15.
