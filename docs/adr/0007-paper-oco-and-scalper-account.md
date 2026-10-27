# ADR 0007: OCO target / stop in the paper engine; Power Scalper as a third paper account

Date: 2026-10-27 · Status: accepted

## Context
Power Scalper needs a target and a stop on every position, dragged on the chart. The paper engine had no OCO: a
target placed after a stop was rejected as "exceeds open qty", because both pending sells counted against the same
open quantity (the 21-Oct bug). Scalping also needs its own capital and P&L, apart from the manual and algo accounts.

## Decision
- **OCO in `paper_engine.py`** (`set_protection`): a target (LIMIT SELL) and a stop (SL-M SELL) of one position share
  an `oco_group` (`pt_orders.oco_group`, '' for every other order). Rules chosen by Naveen on 27-Oct:
  1. The pair never blocks a manual partial sell; plain (non-OCO) sells still count against each other as before.
  2. Both legs follow the open quantity: a partial sell shrinks them, buying more grows them (same prices).
  3. Prices on the 0.05 tick grid. Target above LTP, stop below LTP, stop below target.
  When one leg fills the other is cancelled; when the position closes both are cancelled. OCO is opt-in, so manual
  and algo orders behave exactly as before.
- **A third paper account "Scalper"** (`pt_accounts.name`), run by `scalper_service.py` with its own engine, like the
  algo's. Orders carry `source='scalper'`. It reads the same feed through the paper service's packet listeners and
  keeps its positions and pending orders subscribed with `set_feed_keys("scalper", ...)`. Default capital ₹1,00,000.
- **Reports from fills**: a trade is a round trip (flat → flat) of one instrument; day P&L = realized − charges, the
  same as the P&L calendar. `scalper_daily_summary` keeps one row per account and day, written at 15:35 IST.

## Consequences
- `engine.on_tick` now skips orders that stopped being open earlier in the same tick (an OCO fill cancels its partner).
- The P&L calendar and `/api/paper/pnl` / `/trades` accept `account=scalper|all`; manual and algo results are unchanged
  (tested in `test_scalper.py`).
