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
2. Service + store + routes: the `options` strategy kind, one engine per options strategy loaded from all its fills,
   live ticks, Dhan margin on every trade, the 15:30 expiry settlement job, records in `pt_orders` / `pt_trades` /
   `pt_positions` + `pt_accounts.blocked_margin`; `POST /api/options/basket`, `POST /api/options/exit`,
   `GET /api/options/positions`.
3. Builder: "Paper trade" (pick an options strategy, confirm legs / net premium / margin), and an Options positions
   panel with live P&L, exit leg / exit all.
4. Strategies page: create an Options strategy; its card numbers, P&L calendar and Growth Plan tracker (they read the
   same tables, checked end to end); docs, both themes, all checks.
