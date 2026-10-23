# ADR 0004: Signal watcher and auto paper trading on the backend

Date: 2026-10-23 · Status: accepted (owner's brief, 23-Oct-2026)

## Context
The owner wants the two written rules (MegaBull rule, Trading Hub rule) evaluated every 5 minutes and, with Auto ON,
traded on paper hands-off. ADR 0003 put the dashboard's card formulas in the browser so a card can never disagree with
its app. A browser tab can't be the trading engine: it may be closed, asleep or hidden (polling pauses).

## Decision
- **Rules run on the backend** (`sig_rules.py`, specs in `docs/strategies/`), on 5-minute candles from the dashboard's
  `CandleService`, the shared option-chain cache and the Trending OI tracker. The dashboard's rule cards, OI section and
  paper card show the backend's evaluation (`GET /api/signals/state`), so the screen shows exactly what was traded on.
- **Two copies of the maths, tested against each other.** Chart indicators stay in TypeScript (live per-tick drawing);
  `sig_indicators.py` has the same definitions. Both are tested on the same hand-worked cases
  (`frontend/src/apps/dashboard/logic/__fixtures__/indicator_cases.json`). `sig_oi.py` is a line-by-line port of the OI
  & OI Change, Sensibull and OI S&R formulas, tested on the same real Dhan fixture and hand checks as the frontend apps.
  A formula change in an app must be made in `sig_oi.py` too.
- **Paper only.** Trading Hub rule trades go to the existing paper engine; MegaBull rule trades to MegaBull's
  virtual-trading API. There is no live-order code path. MegaBull stays off (`megabull.enabled`) until the owner has
  confirmed the ⚠ values in `docs/strategies/megabull.md` and `python megabull_client.py check` has confirmed the API's
  field names.
- **Logs outside git:** `autopaper.json` `logDir` (default `H:\Personal\Trading Journey\Auto Paper Logs`): snapshot CSV
  per day, trade log CSV, alerts, end-of-day summary, MegaBull request log (no key). Keys in `~/TradingHubKeys/`.

## Consequences
- One more background thread (watcher) and one 2-second loop (stops / targets) in the backend; one India VIX call per
  30 s at most. Candles are fetched fresh (≤ 15 s old) once per index per 5 minutes.
- Indicator or OI formula changes now touch two languages; the shared fixtures catch drift.
- The backend must run all day for hands-off trading (it already must for Trending OI).
