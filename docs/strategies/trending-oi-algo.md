# Trending OI Algo (NIFTY, PAPER ONLY)

Naveen's rules (12-Nov-2026), with the answers to the plan's questions. Every number is in
`backend/trending_oi_algo_config.py` (DEFAULTS) and can be changed on the page's Settings; each change is logged with
old → new and the time. Open trades keep their stop and lots; new decisions use the new values. Code:
`backend/toi_algo_logic.py` (rules), `backend/indicators.py` (Supertrend, VWAP), `backend/toi_algo_data.py` (contracts).

Own paper strategy "Trending OI Algo" (kind algo, naveen, ₹5,00,000). NIFTY only. Options: nearest weekly expiry, the
next weekly on an expiry day. CE side below; PE mirrors (highs ↔ lows, above ↔ below).

## Data
- 5-minute NIFTY index candles, 09:15-aligned; a candle is used once closed.
- Supertrend(10, 3) and RSI(14) on them, exactly as TradingView (`ta.supertrend`, `ta.rsi`).
- VWAP: session VWAP of the NIFTY current-month future (next month's from the Monday of its expiry week),
  Σ(typical price × volume) / Σ volume from 09:15. Index terms: VWAP − (future − index), the current basis.
- Trending OI: the 5-minute rows of the existing Trending OI (calc.py). Strength dots: ≥ 60 % = 3, ≥ 40 % = 2, ≥ 20 % = 1.
- OI levels S1–S3 / R1–R3: OI Support & Resistance's ranking, locked at 09:30 (as the OI breakout algo).

## Rules
1. **Direction**: latest row Bullish with |strength| ≥ 40 % and ≥ 2 dots → CE only; Bearish → PE only.
2. **No trade** (reason logged when it changes):
   - unclear: below 40 % or 2 dots, or the sentiment changed less than 30 minutes ago;
   - weak day (from 10:30): day high − day low < 0.4 % of spot;
   - over-extended: |index − VWAP| > 0.8 % of spot, or RSI > 80 (CE) / < 20 (PE);
   - indicators not ready yet.
3. **Entry**: a 5-minute candle whose low comes within 10 points of Supertrend or VWAP (or goes through it) and closes
   above both → buy at the next candle's open. The first such candle of the day, then the next one after each exit.
4. **Strike**: 1 ITM (CE one strike below ATM, PE one above). Liquid = live bid / ask, volume today, OI > 0. Not liquid
   → ATM, then 2 ITM (the switch is logged); none liquid → no entry (logged).
5. **Size**: 2 lots.
6. **Stop loss**: the index trades below the day low at entry (PE: above the day high); fixed. Skipped when that is
   more than 0.6 % of spot from the entry.
7. **Averaging** (against me: index below the entry), a pullback that holds (rule 3) → +2 lots, up to 6.
8. **Pyramiding** (my way): after a new swing high since the entry, the next pullback that holds → +1 lot, up to 4.
9. Never more than 6 lots.
10. **Risk guard** before every add: loss if the stop hits now = Σ qty × (average − estimated price at the stop), the
    estimate = LTP − delta × (index − stop) with Dhan's delta (0.6 without one), new lots included. Over ₹10,000 → no add.
11. Adds need Trending OI still valid (rule 1), never after the first partial exit, and never move the stop.
    Adds only inside the entry hours (09:45–14:30). Each new swing high / low gives one pyramiding chance: its first
    pullback that holds adds or is skipped (logged), then a new swing is needed.
12. **Partial exits** at the locked levels beyond the entry in the trade direction (CE: R levels above, PE: S levels
    below), counting only levels at least 20 points beyond the entry: the first → sell half the lots (rounded down, at
    least 1), the second → half of what is left. One usable level → one partial. When half of what is left is the last lot,
    that partial is an ordinary exit and the trade closes.
13. After the first partial: the stop for the rest is **breakeven** (the option average) and the rest trails
    **Supertrend** (exit on a 5-minute close beyond it against the trade). No usable level beyond the entry: breakeven
    once the index has moved 1R in my favour (R = entry − initial stop), then the Supertrend trail.
14. The stop loss (rule 6) exits every open lot. 15. Square-off at 15:15.

## Daily limits
Entries 09:45–14:30. At most 2 trades a day (adds are not trades). After a stop loss, no new entry in that direction
that day. No new entries once the day's P&L (realized + unrealized − charges) reaches −2 % of capital.
