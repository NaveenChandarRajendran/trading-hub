# Box Pullback 15/5 (orbPullback) and 5/1 (orbPullback5) - PAPER

**30-Oct-2026: the 5/1 version is OFF** (owner: 1-min candles too noisy, a 5-min close would have avoided the losing trade). Code kept; `autopaper.json` "orbPullback5" enabled false; hidden from the app, phone and Excel.

Owner asked for paper trading on 29-Oct-2026 ("why should we ignore it"), from a YouTube video he shared on 28-Oct.
Code: `backend/sig_orb.py` (rule, pure), wired in `sig_service.run_orb` (every minute) and `autopaper.py` (own Rs 1 lakh
books "orb" and "orb5", journal names "Box Pullback 15/5" and "Box Pullback 5/1"). Settings: `autopaper.json` "orbPullback" and "orbPullback5". The 5/1 version was added the same day ("we need to see all
the combinations"). Rule changes need the owner's OK.

## Rule (NIFTY and BANKNIFTY, 1 lot, one trade a day per index)
Two versions, each on its own book: 15/5 = 15-min box + 5-min close; 5/1 = 5-min box + 1-min close.
1. Box: high and low of 09:15-09:29 (15/5) or 09:15-09:19 (5/1).
2. Break: the first 5-minute (15/5) or 1-minute (5/1) candle after the box that CLOSES above the box high (call) or below the box low (put).
   Only the day's first break counts.
3. Pullback: after that candle, the first 1-minute candle that touches the box edge again (low <= box high for a call,
   high >= box low for a put). Buy the ATM option at the next minute. No pullback by 13:30: no trade today.
4. Stop -10 %, target +20 % on the option premium (owner 29-Oct-2026: uniform 10 / 20 for buying and scalping).
   The video's index exits (stop at the box middle, 2R target) lost more in the 5-year test; with 10 / 20
   (2021-24 / 2025-26): 15/5 NIFTY -1.04 L / -46 k, BANKNIFTY -1.65 L / -1.31 L; 5/1 NIFTY -1.53 L / -38 k,
   BANKNIFTY -2.05 L / -1.18 L. Still losing: paper for learning only.
5. 15:14: time exit.

## Backtest (honest warning)
Claude's 5-year test (project files `research/orb-pullback/`, Dhan costs + 0.5 % slippage, 1 lot) of exactly these versions
lost money (2021-24 / 2025-26):
- 15/5: NIFTY -1.36 L / -1.41 L; BANKNIFTY -1.92 L / -1.02 L; ~32 % winners.
- 5/1: NIFTY -2.02 L / -1.02 L; BANKNIFTY -3.03 L / -1.32 L; ~30 % winners.
0 of 4,320 nearby versions were profitable in both periods. Kept on paper for learning and comparison only.
