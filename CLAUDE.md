# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product
Personal-first, later a product: an Indian index options (NIFTY, BANKNIFTY) trading
platform. OI-based support/resistance, Trending OI, rule-based strategies
(ORB, Supertrend flip), paper trading → live orders via Dhan (API v2: https://docs.dhanhq.co/api/v2/).

Planned but **not yet present** in the repo: `engine/` (strategy + paper-trading engine),
Alembic migrations, `docs/` (current-state notes, strategy specs, ADRs). Don't assume they exist.

## Commands
Backend (`backend/`, flat modules, no package — run from inside the folder):
- Install: `pip install -r requirements.txt`
- Run: `python main.py` (needs `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN`; optional `DATABASE_URL`)
  - Flags: `--port 8000 --host 127.0.0.1 --strikes 7 --track NIFTY,BANKNIFTY --data-dir data --force`
  - `--force` polls outside market hours — testing only.
- Tests: `python -m pytest -q`; single test: `python -m pytest -q test_calc.py::test_name`
  - `test_pg_store.py` is skipped unless `TEST_DATABASE_URL` is set; it TRUNCATEs the `toi_` tables, so use a throwaway DB.
- Open the app: http://127.0.0.1:8000 (the backend serves `frontend/dist`; run `npm run build` first) and log in.
  Users: `python scripts/create_user.py --username naveen --name "Naveen"` (also `--reset-password`, `--deactivate`, `--list`).
- Health check: `GET http://127.0.0.1:8000/api/status` (needs a login session; shows `"storage": "postgres"`)

Frontend (`frontend/`):
- `npm run dev` / `npm test` (vitest) / `npm run build` (`tsc --noEmit` + vite)
- Single test file: `npx vitest run src/apps/option-strategy/logic/oiCalculation.test.ts`
- Dev server proxies `/api` and `/ws` to the backend (`VITE_BACKEND`, default `http://127.0.0.1:8000`); calls are
  same-origin so the session cookie works. `VITE_API_BASE` only for special setups (default: same origin).
- `node --env-file=.env.local dhan-test.mjs` checks the Dhan token/Data API subscription.

## Architecture

### Frontend: a shell of independent "apps"
`src/App.tsx` is a sidebar shell; every tool is a lazily loaded app registered in
`src/apps/registry.ts`. To add one, create `src/apps/<name>/` and add one registry entry.
Each app follows the same layout: `<Name>App.tsx` (UI, AG Grid) + `logic/` (pure, UI-agnostic
calculations with vitest tests and JSON `__fixtures__/`) + optional `config/`.
Shared pieces: `src/shared/grid.ts` (AG Grid theme, `inr` number formatting), `src/shared/theme.tsx`
(light/dark via `data-theme`).

Data sources differ per app:
- `option-strategy` and `sensibull-oi`: **no backend** — user pastes raw JSON (NSE option-chain-v3 /
  Sensibull network response). Parsers normalize it into a flat model; formula modules consume only
  that model, never the raw shape.
- `trending-oi` and `components` (index components): call the FastAPI backend.

`vite build` (with `vite-plugin-singlefile`, `base: './'`) emits ONE self-contained `dist/index.html`, served by the
backend at `/` (ADR 0008). The whole app is behind a login (`src/shared/auth/AuthGate.tsx`); opened by double-click the
file only says "Start the backend and open http://127.0.0.1:8000".

### Backend: Trending OI recorder + Dhan proxy (`backend/`)
- `main.py` — `create_app(tracker, ...)` builds the FastAPI app (tests inject fakes through it);
  `main()` picks storage and starts uvicorn. Endpoints: `/api/trending-oi`, `/api/expiries`,
  `/api/quotes`, `/api/history`, `/api/status`, `POST /api/token` (hot-swap an expired token).
- `tracker.py` — background thread polling Dhan's option chain every minute at hh:mm:03 per
  tracked (symbol, expiry), only during NSE market hours on non-holidays (`holidays.py`).
  Strike set = ATM ± N, **fixed from the day's first snapshot** and persisted in `toi_session`.
  On restart it reloads today's rows and resumes tracking. Failed DB writes stay in memory and retry.
- `calc.py` — turns snapshots into Trending OI rows; 3/5/15-min intervals are filters of the
  1-minute snapshots. Change in OI = `oi - previous_oi` (Dhan's settled prior-day OI) summed over
  the fixed strikes, in **units, not lots**.
- `store.py` — `PgStore` (tables `toi_session`, `toi_snapshot`, see `schema.sql`, auto-created)
  or `JsonStore` fallback in `data/`. If `DATABASE_URL` is set but unreachable the backend exits —
  never silently fall back.
- `dhan_client.py` — thin Dhan v2 client with per-endpoint rate limiting (option chain ≥3.1 s,
  quotes ~1/s, history ~4/s); raises `TokenExpired` on 401/DH-901.
- `instruments.py` — NSE symbol → Dhan security ID map from Dhan's instrument CSV, refreshed daily,
  cached in `data/security_ids.json`.

Known limits: minutes when the backend is down are not recorded (no backfill); Dhan tokens expire ~daily.

### Login (ADR 0008)
`auth.py` `AuthMiddleware` guards EVERY route and WebSocket (default deny; only `POST /api/auth/login` and the UI page
are open): 401 `{"login": true}` / WebSocket close 4401. `create_app(..., auth=...)` is required; tests that aren't
about login import `create_app` from `authfake.py`. Tables are prefixed `th_` (the shared database has another
project's `strategies` / `trades`).

## Rules
- Read `docs/02-current-state.md` before starting a task and update it after finishing (create it if missing).
- Strategy logic must match `docs/strategies/*.md` exactly. Ask if a rule is unclear.
- Calculations were verified against reference tools (OI Pulse, NSE chain) — preserve numeric
  semantics (units vs lots, fixed strike set, previous-close rules) when refactoring.
- Never place real orders unless the code path is explicitly LIVE mode.
- Secrets (Dhan token, DB passwords) only via env / `.env*` files, never committed.
- Small PRs: one feature per branch, with tests.
- Significant decisions → add an ADR in `docs/adr/`.
