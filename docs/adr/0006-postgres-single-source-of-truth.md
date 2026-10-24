# ADR 0006: Postgres is the single source of truth; the algo runs a live variant with shadow variants

Date: 2026-10-24 · Status: accepted

## Context
On 23-Oct the backend ran with `DATABASE_URL` set in one console window (Postgres) and on 24-Oct without it (JSON
files), so the data of one week was split across two stores and the Algo page could not show a past day. The algo's
rule variants (B, C, D) also needed live results side by side with the variant actually trading.

## Decision
- **Postgres only.** `DATABASE_URL` (and the Dhan keys) come from `backend/.env.local`; `main.py` refuses to start
  when it is missing or the database can't be reached, with a message saying what to set. No JSON fallback in the app;
  the JSON stores stay only as in-memory test doubles. The `.log` files are a write-only plain-text backup.
- **Tables for decisions and reports:** `algo_events` (index, variant, type, details; unique `uid` so imports never
  duplicate), `algo_state` per index and variant, `algo_levels`, `algo_candles` (with filter values),
  `algo_daily_summary` (15:35 IST, recomputable), `oc_snapshots` (per strike per minute). Every date column is the
  IST trading date written by the app, never derived from a UTC timestamp. Existing tables are migrated in place by
  `schema.sql` (idempotent); nothing is deleted.
- **Live + shadows:** `RULE_VARIANT` (B) places paper orders; the other variants run on the same candles and filter
  values in signals-only mode with their own state and log rows. P&L is computed for the live variant only; shadows
  report index points.
- **Import and backup scripts:** `scripts/import_legacy.py` (idempotent) and `scripts/backup_db.py` (pg_dump).

## Consequences
- One place to query every day; Reports can compare variants on real days.
- The backend can't run without the database service; a backup routine is needed (daily pg_dump).
- The database is shared with another project's tables; Trading Hub's migrations only touch its own tables.
