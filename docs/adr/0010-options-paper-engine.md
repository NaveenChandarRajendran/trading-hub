# ADR 0010: Options paper engine (short legs, overnight, expiry settlement)

Date: 28-Oct-2026 · Status: accepted (Naveen: "we can build it … your suggestions are fine")

## Context
The Strategy Builder designs multi-leg positions (iron condors, spreads, strangles) that are held to the weekly expiry.
The paper engine (`paper_engine.py`, ADR 0007) is buy-only and intraday by design: a sell only closes a long, and
everything is squared off at 15:15. It cannot hold a short condor overnight or settle it at expiry, and its rules
are shared by Paper Trading, Power Scalper and the algo, which must not change.

## Decision
1. **A new strategy kind `options`**, next to `manual` and `algo`. Only `options` strategies take short legs and carry
   positions overnight; Manual, Scalper and the algo keep the buy-only intraday engine unchanged.
2. **A separate pure engine, `options_engine.py`**, not a mode of `paper_engine.py`: positions are signed (long +,
   short −) with an average price, live across days, and are rebuilt from the strategy's fills of every day on load.
   Realized P&L uses the average price (as the paper engine): closing quantity × (close − average) × sign.
3. **Baskets, all-or-nothing, at market**: every leg must have depth on its side (sells walk the bids, buys the asks,
   the same depth walk as the paper engine); funds and margin are checked for the whole basket first; if any leg
   can't fill, nothing fills. Entries 09:15–15:15 IST on trading days. Exits at market for one leg or all, same hours.
4. **Margin blocked = Dhan's basket margin** (`/v2/margincalculator/multi`) of the open legs after the trade, and at
   least the premium of the long legs. A basket is **refused when Dhan can't answer** (no estimate). After exits the
   margin is asked again; if Dhan can't answer then, the last margin stays blocked until the next answer (never less).
5. **Funds**: cash = capital + booked P&L (realized − charges, every day so far) + premium received on open shorts −
   premium paid on open longs; available = cash − blocked margin. A basket needs available ≥ (new margin − margin
   blocked now) + its debit (if any) + charges.
6. **Expiry settlement at 15:30 IST** on the expiry day, at the index's **15:30 spot** (the last tick at or before
   15:30): every open leg of that expiry closes at its intrinsic value (OTM = 0). **STT 0.125 % of the intrinsic value
   on in-the-money long options** settled at expiry (NSE rule); no brokerage on settlement.
7. **Charges** on every market fill: `paper_charges.order_charges` (the same rates as the paper engine).
8. **Records in the existing tables** so every report keeps working unchanged: each fill is a `pt_trades` row (and a
   FILLED `pt_orders` row, `source='builder'`); each day's per-instrument row in `pt_positions` carries that day's
   buys, sells and the realized P&L booked that day. The P&L calendar, strategy cards, Growth Plan tracker and daily
   summaries read them as they read every other strategy. Own tables: `op_fills` (every fill in full, to rebuild the
   positions across days) and `op_state` (the margin blocked now).

## Consequences
- Options strategies appear in the Builder's Paper trade, the Strategies page and reports; Paper Trading and Power
  Scalper keep offering only manual strategies ("Trading into" is unchanged).
- Dhan's margin can look high (on 28-Oct it reported hedge benefit 0 for a hedged condor): the blocked margin follows
  Dhan, so free capital may look lower than at a broker that nets hedges. Compare once with Dhan's own app.
- Settlement uses the 15:30 spot, not NSE's official closing value (they can differ a little).
- Paper only: nothing in this path can reach a real order endpoint.
