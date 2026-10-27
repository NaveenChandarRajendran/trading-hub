# MegaBull rules: 4 Pillar Rules and SuperTrend Rules (any index)

Owner: R. Diwakaran. Sources: tracker sheets 'Option Buy-4 Pillar Startegy' and 'Option Buy - Dharani Setup' (header
notes), 'Rules and Data Log', the brief (23-Oct-2026) and owner answers (23-Oct-2026). Code: `backend/sig_rules.py`
`four_pillar_rule`, `supertrend_rule`. PAPER ONLY (MegaBull paper account). Strict rules, unchanged; GO = Grade A only.

**Names (owner, 25-Oct-2026):** the NIFTY setup here is **SuperTrend Nifty**, our own rule built from the live-webinar
notes (called "Dharani" / "Dharani v1" before). The teacher's exact tuned setup is the separate **Dharani** rule
(`dharani-v2.md`), traded on the app's own Rs 1 lakh Dharani paper account, not on MegaBull. MegaBull keeps the strict
rules only: 4 Pillar and SuperTrend Nifty.

**Any index (owner, 25-Oct-2026, from 26-Oct):** renamed **4 Pillar Rules** and **SuperTrend Rules**, and BOTH run on
NIFTY and BANKNIFTY ("so that way we can test it further"; before: 4 Pillar on BANKNIFTY, SuperTrend Nifty on NIFTY).
4 Pillar on NIFTY and SuperTrend on BANKNIFTY are untested extensions; they use the per-index settings already in
`autopaper.json` "rules" (pivotRoom, wallRoom: NIFTY 50 / 50, BANKNIFTY 100 / 200). Each rule is its own position slot
per index on the MegaBull account (ADR 0007): one rule's open trade never blocks the other. Section headings below keep
the original index for where each was first written.

**Status (owner, 23-Oct evening):** thresholds confirmed; the room values are guesses kept as settings
(`autopaper.json` "rules": pivotRoom, wallRoom). MegaBull takes **Grade A only** (every pillar and filter passes); a setup
missing one filter (e.g. VIX 15.2 on 12-Oct) is not a MegaBull trade, it goes to the shadow log. MegaBull auto orders stay
OFF until the key is saved, the read-only check and one test order have run.

## Flow (both)
5-minute candles, IST, 09:15-aligned. Call side shown; puts mirror it.
1. **Trigger candle**: a completed candle closes above a level that the candle before it closed at or below.
   Levels (owner, 23-Oct): day pivot, previous day high, previous day low, OI R1 and OI S1 (OI Support & Resistance,
   range 500). If several are crossed, the highest one counts. **Dharani also:** a SuperTrend flip to the trade's side on
   that candle is a trigger, at the line's value (owner, 23-Oct evening).
2. **Confirmation candle**: the next candle also closes above that level. If it closes back at or below it, the setup
   is cancelled.
3. **Entry**: market BUY at the next candle's open, 1 lot, ATM strike, nearest expiry (on its expiry day, the next).
- Not in the first 15 minutes: the trigger candle starts 09:30 or later.
- No entries after 15:00; last 15 minutes avoided.
- Target = fill × 1.20, stop = fill × 0.90 (SL SELL), hard exit 15:15. Exits ONLY on stop, target or 15:15: never on
  signal rules (owner, 23-Oct evening). After any exit the premium is shadow-logged to 15:30 (record only).

## 4 Pillar (BANKNIFTY), checked on the confirmation candle
| pillar | call | put |
|---|---|---|
| 1 Price + RSI | close above EMA 20 and VWAP, RSI 14 ≥ 45 | close below both, RSI ≤ 45 |
| 2 Order flow | cumulative delta: **not checked** (Dext not readable), does not block, tagged | same |
| 3 India VIX | VIX < 14 | same |
| 4 PCR | PCR ≥ 0.9 ("near 1 or above"; setting `pcr`) | PCR < 0.9 ("well below 1") |
Volume Oscillator (5, 10): record only.

## SuperTrend Nifty (NIFTY), checked on the confirmation candle
Owner 27-Oct-2026 (after the 12:45 NIFTY 22800 CE stop-out): wait one more candle. The setup below is read on the
confirmation candle; the next 5-minute candle must CLOSE beyond the band, and the entry is at the open after it. If it
closes back inside the bands, no trade. 5-year backtest (both indices, -10/+20, costs + 0.5 % slippage): -Rs 3.90 L
(1,491 trades) before, -Rs 1.10 L (583 trades) with the wait; still a loss, reviewed 15 Nov 2026.

| pillar | call | put |
|---|---|---|
| 1 SuperTrend (10, 2) | green, close above the line | red, close below the line |
| 2 RSI 14 | > 55 | < 45; 45–55 = no trade |
| 3 Bollinger (20, 2) | the candle's high touches or breaks the upper band | the low touches or breaks the lower band |
| Wait for band close (owner 27-Oct-2026, setting `superTrendWaitBandClose`) | the candle AFTER the confirmation candle closes at or above the upper band; entry at the open after it | that candle closes at or below the lower band |
| 4 Pivot | close above the pivot, and the next pivot level above (R1, R2 …) is at least 50 pts away (guess, setting `pivotRoom`; "no call right under R1") | close below the pivot, next level below ≥ 50 pts away |

## Filters (Rules and Data Log, agreed working list), both setups
| filter | rule |
|---|---|
| Confirmation | as in the flow; confirmation-candle delta ≥ 0: **not checked**, tagged (estimate on the Order flow page, used once it matches Dext) |
| Trigger delta jump | BANKNIFTY ≥ +5K / NIFTY ≥ +10K on futures: **not checked**, tagged |
| Chase limit | not applicable: the program enters exactly at the candle open |
| Room to the wall | distance from the confirmation close to the nearest OI level in the trade's direction (R1–R3 for calls, S1–S3 for puts) ≥ BANKNIFTY 200 pts / NIFTY 50 pts (guess, setting `wallRoom`) |

GO = trigger + confirmation valid, every pillar green (delta "not checked" allowed), room OK, entry inside the window,
no open MegaBull position on that index.
