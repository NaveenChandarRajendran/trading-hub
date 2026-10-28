# Option Selling book (NIFTY, Rs 3 lakh, PAPER)

Owner: R. Diwakaran. Owner approved PAPER trading on 28-Oct-2026 ("Yes") after Claude's tests of public strategies
(Claude Doc "Public strategies test 28 Oct 2026", scripts in project files `research/public-strategies/`), the long-dated
strangle / rolling study (`research/long-strangle/`) and the scalping search (`research/scalping-search/`).
Code: `backend/sell_rules.py` (rules, pure) and `backend/sell_desk.py` (runs them). PAPER ONLY: nothing is sent to Dhan.
Its own book "Selling" (Rs 3,00,000), state in `data/books/selling/state.json`, separate from the buying accounts.
Tracked in the Excel tab "Option Sell - Selling Book". Rule changes need the owner's OK.

Every leg is SOLD first and BOUGHT BACK to exit, so a leg makes money when its price falls. Fills walk the live
market depth (sell into the bids, buy back from the asks); charges are the normal Dhan charges of both orders.
1 lot (65) per leg. Settings: `autopaper.json` "selling" (each rule has its own `enabled` switch).

## 1. Expiry Straddle (sellStraddle)
- Day: only on the day of the nearest NIFTY expiry (Tuesday, or the day before a holiday).
- 09:20: sell the ATM call and the ATM put (strike nearest spot, 50 step) of that expiry.
- Stop per leg: price >= sell price + 50 % (rounded up to 0.05).
- When one leg is stopped, the other leg's stop moves to its own sell price ("cost").
- 15:14: buy back whatever is open.
- Test (costs + 0.5 % slippage): +1.34 L Nov 2021-Dec 2024, +41.7 k 2025-26, profit every year, worst day about -5 k.

## 2. Calm-day Call Sell (sellCalmCall)
- Every trading day, NIFTY. 60-minute candles aligned to 09:15 (the 15:15 candle is the day's last, it is short).
- At 10:15 (when the 09:15-10:14 candle closes): Bollinger width = 4 x population SD / mean x 100 of the last 20
  hourly closes (across days).
- Width <= 1.34: sell the ATM call of the nearest expiry. Wider: no trade ("Not calm").
- Stop +50 %; 15:14 buy back.
- Found by the scalping search; positive in every year 2021-26.

## 3. Two-month Strangle (sellStrangle)
- Positional (held overnight). With no strangle open, 10:00: sell the call about 3 % above spot and the put about
  3 % below spot (rounded to 100) of the expiry closest to 61 days away (45-80 days allowed).
- Every day at 15:05:
  - Roll: a leg whose price is <= 30 % of its sell price (kept 70 % of the premium) is bought back and a new leg of
    the same type is sold 3 % from today's spot, same expiry.
  - Stop: if the strangle's total (booked legs + open legs at their price, after charges) is a loss of Rs 60,000 or
    more, buy everything back.
- On the expiry day everything is bought back at 15:14. After that, or after the Rs 60k stop, the next strangle
  starts on the next trading day at 10:00.
- Estimate (Black-Scholes on India VIX, no real long-dated prices): about +8.9 k per 2-month cycle, worst about -73 k.

## Retries and gaps
If an option has no live price at entry time the desk keeps trying for 10 minutes, then notes "Skipped today".
A buy-back with no sellers waits for the next tick. Open strangle legs show on each day's Today page and journal.

## Margin note
Real margin for the straddle and the strangle together can be more than Rs 3 L; the paper book does not block it.

## 4. Timed Expiry Straddles (sellStraddle940, sellStraddle1126, sellStraddle1224)
- Owner approved PAPER on 28-Oct-2026 ("may be we can keep this also for testing"), idea from a Salem trader's
  automated basket (Dhan podcast). Scripts and results: project files `research/timed-straddle/`.
- Day: NIFTY expiry day only (same as rule 1). Three separate straddles, 1 lot per leg each:
  - 09:40: sell ATM call + ATM put, stop per leg +80 %.
  - 11:26: same, stop +80 %.
  - 12:24: same, stop +70 %.
- No move-to-cost (`trailToCost: false`): each leg only has its own stop. 15:14: buy back whatever is open.
- Test (costs + 0.5 % slippage, 261 expiries): 2021-24 +1.92 L, 2025-26 +1.34 L, profit every year, worst day -24.8 k,
  max drawdown 53 k. The same basket on every day loses (-1.55 L), so it stays expiry-only.
- Margin note: with rule 1 that is 4 straddles open at once; real money would need about Rs 7-8 L margin.
