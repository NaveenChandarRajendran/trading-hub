# MegaBull rule (4 Pillar = BANKNIFTY, Dharani = NIFTY)

Owner: R. Diwakaran. Sources: tracker sheets 'Option Buy-4 Pillar Startegy' and 'Option Buy - Dharani Setup' (header
notes), 'Rules and Data Log', the brief (23-Oct-2026) and owner answers (23-Oct-2026). Code: `backend/sig_rules.py`
`megabull_rule`. PAPER ONLY (MegaBull paper account). Strict rules, unchanged; GO / NO GO only (grade n.a.).

**Status: the numbers marked ⚠ turn the sheet's words into exact values. The owner confirms them before Auto trades
MegaBull.**

## Flow (both)
5-minute candles, IST, 09:15-aligned. Call side shown; puts mirror it.
1. **Trigger candle**: a completed candle closes above a level that the candle before it closed at or below.
   Levels (owner, 23-Oct): day pivot, previous day high, previous day low, OI R1 and OI S1 (OI Support & Resistance,
   range 500). If several are crossed, the highest one counts.
2. **Confirmation candle**: the next candle also closes above that level. If it closes back at or below it, the setup
   is cancelled.
3. **Entry**: market BUY at the next candle's open, 1 lot, ATM strike, nearest expiry (on its expiry day, the next).
- Not in the first 15 minutes: the trigger candle starts 09:30 or later. ⚠
- No entries after 15:00; last 15 minutes avoided.
- Target = fill × 1.20, stop = fill × 0.90 (SL SELL), hard exit 15:15.

## 4 Pillar (BANKNIFTY), checked on the confirmation candle
| pillar | call | put |
|---|---|---|
| 1 Price + RSI | close above EMA 20 and VWAP, RSI 14 ≥ 45 | close below both, RSI ≤ 45 |
| 2 Order flow | cumulative delta: **not checked** (Dext not readable), does not block, tagged | same |
| 3 India VIX | VIX < 14 ⚠ ("below fourteen is calm and safe") | same |
| 4 PCR | PCR ≥ 1.0 ⚠ (sheet: "near one or above"; journal: "simplified to a 1.0 threshold") | PCR < 1.0 ⚠ |
Volume Oscillator (5, 10): record only.

## Dharani (NIFTY), checked on the confirmation candle
| pillar | call | put |
|---|---|---|
| 1 SuperTrend (10, 2) | green, close above the line | red, close below the line |
| 2 RSI 14 | > 55 ⚠ (sheet: "above 55–60") | < 45 ⚠ (sheet: "below 40–45"); 45–55 = no trade |
| 3 Bollinger (20, 2) | the candle's high reaches the upper band ("pressing or breaking") ⚠ | low reaches the lower band |
| 4 Pivot | close above the pivot, and the next pivot level above (R1, R2 …) is at least 50 pts away ⚠ ("don't buy a call right under R1") | close below the pivot, next level below ≥ 50 pts away |

## Filters (Rules and Data Log, agreed working list), both setups
| filter | rule |
|---|---|
| Confirmation | as in the flow; confirmation-candle delta ≥ 0: **not checked**, tagged |
| Trigger delta jump | BANKNIFTY ≥ +5K / NIFTY ≥ +10K on futures: **not checked**, tagged |
| Chase limit | not applicable: the program enters exactly at the candle open |
| Room to the wall | distance from the confirmation close to the nearest OI level in the trade's direction (R1–R3 for calls, S1–S3 for puts) ≥ BANKNIFTY 200 pts / NIFTY 50 pts ⚠ |

GO = trigger + confirmation valid, every pillar green (delta "not checked" allowed), room OK, entry inside the window,
no open MegaBull position on that index.
