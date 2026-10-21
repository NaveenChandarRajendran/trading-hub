# Current state

_Last updated: 2026-10-21 (sidebar grouping; live OI apps in progress on `feature/live-oi-apps`)_

## Apps (frontend, `src/apps/registry.ts`)
| App | Data | Notes |
|---|---|---|
| OI & OI Change (`option-strategy`) | pasted NSE option-chain-v3 JSON | Excel port; older styles (`index.css`) |
| Sensibull OI (`sensibull-oi`) | pasted Sensibull response | older styles |
| **OI Support & Resistance** (`oi-support-resistance`) | pasted NSE option-chain-v3 JSON | new 2026-10-20; first app on the design system |
| **Paper Trading** (`paper-trade`) | backend `/api/paper/*`, `/ws/paper` (live Dhan feed) | simulation only; design system |
| Trending OI (`trending-oi`) | backend `/api/trending-oi` | older styles |
| Index Components (`components`) | backend `/api/quotes`, `/api/history` | own `--cp-*` palette |

## Sidebar
Grouped into collapsible sections from the `group` field in `src/apps/registry.ts` (`GROUPS` sets labels and order):
"Manual (Paste)" and "Live (Dhan)". Both start open; closed sections are remembered in localStorage (`shell.groups`).
With the sidebar collapsed to icons, section headers become dividers. Helpers + tests: `src/shared/sidebarGroups.ts`.

## OI Support & Resistance
Port of the Strike Desk HTML (index3.html), S/R part only. Open the app, pick index + expiry, Open the NSE link,
paste the JSON, Analyze.
- R1–R3 / S1–S3 = top 3 call OI from spot to spot + range / put OI from spot − range to below spot,
  numbered nearest first. PCR (all strikes), max pain, days to expiry.
- First paste of the day = baseline. Later pastes are compared with the baseline and the previous paste
  (±threshold %, default 10), plus a zone (strike ±1) comparison, "R1 moved" messages and a trend table.
- Colors follow the seller's view: rising put OI at support / falling call OI at resistance = green;
  falling put OI / rising call OI = red.
- Pastes are kept in localStorage per index + expiry + day (`oi-support-resistance.snaps.*`); earlier days are
  deleted on the next save. Settings (range, threshold) are in the Settings popover.
- Differences from the HTML: zone uses the real strike step (the HTML capped it at 50, so BANKNIFTY zones were
  the strike alone); one baseline per index + expiry instead of one per day; IST times; no risk/reward calculator
  (planned as its own page).
- Tests: `logic/levels.test.ts`, `logic/snapshots.test.ts` (Bank Nifty 16-Oct-2026 fixture).

## Paper Trading (branch `feature/paper-trade`, spec `docs/features/paper-trade.md`)
SIMULATION ONLY: fills are computed by `backend/paper_engine.py` against the live Dhan feed; no order endpoint is called.
Run the backend (`python main.py`), open Paper Trading. Steps 1–4 of the spec are built; step 5 (attached SL/target) is not.
- Backend: `paper_engine.py` (fill rules, funds, 09:15–15:15 session, 15:15 square-off), `paper_charges.py` (all rates),
  `dhan_feed.py` (binary feed parser + reconnecting client), `paper_api.py` (service, routes, WebSocket), `pt_` tables in
  `schema.sql` / `store.py` (`data/paper.json` without `DATABASE_URL`), option list from Dhan's instrument CSV in
  `instruments.py` (lot sizes, strikes, security IDs; cached per IST day).
- Frontend `src/apps/paper-trade/`: Trade (chain ATM ±10 with B/S, positions, open orders, order ticket),
  Orders (order book + fills per day, CSV), P&L (FY calendar heatmap, month table, day trades, CSV).
  Shared: `src/shared/api.ts` (also used by Trending OI), `src/shared/ui/Heatmap.tsx`, `Segmented`, `Status`,
  `--heat-*` and `--backdrop` tokens.
- Each day opens with capital + net P&L of earlier days. Capital change / reset need no open positions or pending orders.
- Tests: `test_paper_engine.py`, `test_paper_charges.py`, `test_dhan_feed.py`, `test_paper_api.py`, `test_paper_store.py`,
  `test_instruments.py`; frontend `paper-trade/logic/*.test.ts`. Postgres store tests need `TEST_DATABASE_URL`.

Known limits / open:
- Never run against the live Dhan feed yet: record frames with `backend/capture_feed.py` on a trading day
  (enables `test_captured_frames`) and check Dhan's LTT time zone.
- Charges are hand-worked, not yet checked against Dhan's brokerage calculator. STT is 0.15% (from 1-Apr-2026),
  the spec says 0.1%: decision pending.
- The instrument CSV (~26 MB) is downloaded twice a day (stock IDs and option list are separate caches).
- Positions held when the backend is down at 15:15 are squared off at the next start, at the then-current price.

## Design system
`src/shared/tokens.css` (global) and `src/shared/ui/ui.css` + `src/shared/ui/index.tsx` (scoped to `.ds`),
from the trading-hub-feature skill. See `docs/adr/0001-scoped-design-system.md`. Older apps are not migrated yet.
Shared helpers added: `signed()` in `src/shared/grid.ts`, `copyText()` in `src/shared/clipboard.ts`.

## Not built yet
Strategy engine (ORB, Supertrend flip), paper trading, live orders, Alembic migrations, strategy docs.

## Known limits
- Paste-based apps depend on NSE's browser session (empty JSON when it has expired).
- Backend: minutes while it is down are not recorded; Dhan tokens expire about daily.
