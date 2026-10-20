# Backend conventions (backend/)

Python, FastAPI + uvicorn, `requests` for Dhan, optional Postgres (psycopg2), pytest + httpx.
Flat modules, no package. Run from inside `backend/`. See `CLAUDE.md` for commands.

## Adding an endpoint
- Add routes inside `create_app(tracker, ...)` in `main.py`, so tests can build the app with fakes.
  If `main.py` gets crowded, move a feature's routes into `<feature>_api.py` with a
  `register(app, deps)` function called from `create_app`. Don't introduce a package layout without an
  approved plan and an ADR.
- Path `/api/<kebab-noun>`, query params in camelCase to match the frontend (`symbol`, `expiry`, `interval`).
- Response shape: `{ "meta": {...}, "rows": [...] }` for tabular data. `meta` always carries
  `asOf` (IST string), `marketOpen`, `tokenExpired`, `lastError`, `message`, so the UI can render every state.
- Validate inputs first and fail with clear `HTTPException`s: 400 bad input (list the allowed values),
  401 token expired, 404 unknown symbol, 409 not tracked yet, 502 Dhan error, 503 database down.
- Pure calculations go in their own module (like `calc.py`) with no FastAPI, no I/O, and pytest tests.

## Dhan
- Only call Dhan through `dhan_client.py` and its per-endpoint rate limiting (option chain ≥3.1s, quotes
  ~1/s, history ~4/s). New Dhan endpoints get a method there with the same limiter and `TokenExpired` handling.
- Cache aggressively (expiries 1h, quotes ~2s, history per IST date), because the UI polls.
- Respect market hours and holidays (`holidays.py`). Background polling only runs during the session unless `--force`.
- Numbers keep Dhan's raw semantics (units, not lots) unless the plan says otherwise. Convert at the edge and label it.

## Storage
- Postgres via `store.py` (`PgStore`) when `DATABASE_URL` is set. Otherwise the JSON fallback in `data/`.
  New tables get a feature prefix (`toi_`, `strat_`…), go in `schema.sql`, and are created idempotently.
- If `DATABASE_URL` is set but unreachable, exit. Never silently fall back.
- `data/` contents and `.env*` are never committed.

## Tests
- `test_<feature>.py` per module. Calculation tests use small real fixtures. API tests use `create_app` with a
  fake tracker/client (see `test_api.py`), never the real Dhan API.
- `python -m pytest -q` must pass before reporting done.
