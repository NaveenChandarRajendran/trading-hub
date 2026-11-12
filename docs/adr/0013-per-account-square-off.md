# ADR 0013: A per-account square-off time (the ORB Algo runs to 15:25)

Date: 12-Nov-2026. Status: accepted.

## Context
The paper engine (`paper_engine.PaperEngine`) takes orders 09:15–15:15 and squares every account off at 15:15. The ORB
Algo's rules (docs/strategies/orb.md) hold trades to **15:25**. Every other account (manual strategies, OI Breakout,
Trending OI, Power Scalper, Trade Window) must keep 15:15.

## Decision
- `PaperEngine(..., square_off=time(15, 15))`: the last-order time and the auto square-off time are per engine (one
  engine = one account's day). It must be inside the session (after 09:15, at most 15:30). The "market closed" and
  square-off texts show the account's own time.
- `algo_service.AlgoBroker(..., square_off=None)` passes it on; only the ORB Algo sets it (its `squareOff` setting,
  15:25 by default; a settings change moves it for the running day too).
- Manual accounts are built by `paper_api.PaperService` without the parameter, so they keep 15:15. No database change.
- At 15:25 the ORB account's engine sells everything itself; the algo then books each setup's exit at that fill price
  (it cannot place an order from 15:25 on).

## Consequences
- An algo account can run later than the others; its open positions are still in the engine's square-off, so nothing
  is carried overnight.
- Reports and the P&L of other accounts are unchanged.
