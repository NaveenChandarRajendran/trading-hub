# Options paper trading (part B of the Strategy Builder; ADR 0010)

Paper trade multi-leg option positions (short legs allowed) designed in the Strategy Builder, hold them overnight and
let them settle at expiry. Options strategies only; Manual / Scalper / the algo are unchanged. PAPER ONLY.

## Naveen's rules (28-Oct-2026)
1. Settlement price at expiry: the index's 15:30 IST spot (last tick at or before 15:30).
2. Margin: Dhan's basket margin; if Dhan can't answer, the basket is refused (no estimate).
3. STT on expiry: 0.125 % of the intrinsic value of in-the-money long options settled at expiry.
4. Exits before expiry: market, whole position or one leg.

## Build steps
1. Engine (`backend/options_engine.py`, pure) + tests — done (`test_options_engine.py`, 10 tests: entry / margin /
   funds on the 3 Nov iron condor, all-or-nothing refusals, exits, flips, settlement worthless and at max loss with
   STT on the long put only, one expiry at a time, restore across days, per-day rows for the reports).
2. Service + store + routes — done (`options_service.py`, `options_api.py`, `test_options_service.py`, 7 tests):
   - `options` strategy kind (`POST /api/strategies {kind: "options"}`; schema check widened, live constraint name
     checked); capital change / reset / archive only when flat; Paper Trading / Power Scalper still manual only.
   - One engine per options strategy, rebuilt from `op_fills` (every fill in full) + `op_state` (margin blocked);
     fills mirrored to `pt_orders` (source `builder`) / `pt_trades` / per-day `pt_positions`, so the strategy cards
     (booked, unbooked, open) and day summaries read them unchanged.
   - Live books from the paper feed (kept even before an engine loads); open legs and their index kept subscribed.
   - Dhan margin of the book after each trade (net quantity per leg); entry refused without it, exits still go.
   - Settlement timer (20 s): legs whose expiry reached 15:30 settle at that day's 15:30 spot (last index tick at or
     before 15:30; else Dhan's 15:29 one-minute close; else pending, shown on the positions).
   - Routes: `POST /api/options/basket`, `POST /api/options/exit`, `GET /api/options/positions` (own options
     strategy only).
3. Builder — done. "Paper trade" (`PaperTradeDialog.tsx`): pick an options strategy (or create one there), the legs
   with estimated fills (sells at the bid, buys at the ask), net premium, Dhan margin, entry charges, available funds;
   places the ticked legs × multiplier all-or-nothing. "Paper positions" (`OptionsPositions.tsx`, re-read every 5 s):
   live P&L, booked, margin, available; per leg avg / LTP / P&L / Exit; Exit all; "Open in a tab" (held legs, shorts
   too, locked at their average: the live payoff); "settlement pending" badge. Exits 09:15-15:15 IST.
4. Strategies page — done. "+ New strategy" has a Kind (Manual / Options); cards and the strategy view tag OPTIONS
   (amber) with a "Builder" link; the P&L calendar and the Growth Plan tracker read options strategies unchanged
   (`test_options_service.py::test_pnl_calendar_and_growth_plan_read_an_options_strategy`: entry day = charges,
   expiry day = the credit kept). Live from 28-Oct-2026 22:30 (merged into naveen-dev, backend restarted).
5. Portfolios report — built 29-Oct-2026 (branch `feature/options-report`). Strategy Builder → **Portfolios** (switch
   at the top): a card per options strategy (Total P&L = booked + unbooked, trades, capital, Unbooked | Booked) and,
   for the one picked, Total / Booked / Unbooked / Win rate tiles, a month-by-month table and a trades table (click a
   trade for its fills). Re-read every 15 s. `backend/options_report.py` (pure, `test_options_report.py`):
   - one trade = every leg of one index + expiry, whatever baskets opened, adjusted or closed it;
   - booked = realized − all its charges; unbooked = its open legs at the live price; net = booked + unbooked;
     credit = premium of its opening fills; status open / closed (exited before expiry) / settled;
   - a trade counts in the month of its **expiry** (Naveen, 29-Oct); wins / losses / win % / best / worst from finished
     trades; an open trade's net is in its month so the months add up to the total; return % = net ÷ capital;
   - every capital period of the strategy (after a reset too); unbooked only from the open period.
   Routes: `GET /api/options/report?strategy=` (own options strategy only), `GET /api/options/portfolios`.
   The P&L calendar keeps booking by day (exit / settlement day), so its months can differ from the report's.
