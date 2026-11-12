# ADR 0012: The Algos hub, one API shape for every algo, and shared settings tables

Date: 12-Nov-2026. Status: accepted.

## Context
Two paper algos (OI Breakout, ADR 0005; Trending OI, ADR 0011) each had their own page, with its own header, kill switch,
decision log, reports and (Trending OI only) settings. More are coming (ORB, then positional ones from Strategy Lab).
Naveen asked for a very organised UI, OI Breakout's settings to be editable as well, and said old numbers don't matter
before the app is stable, so the database can be reorganised freely.

## Decision
- **One hub** (`frontend/src/algos/`): the sidebar has a single "Algos" entry (Intraday / Positional). `#/algos/:slug/:tab`
  is one page template for every algo: a shared header (status, today's / MTD P&L, open position, kill switch) and tabs
  Overview (the algo's own panel, `src/algos/<slug>/Overview.tsx`), Rules (`docs/strategies/<doc>.md`, `marked` 12.0.2 pinned,
  raw HTML escaped), Log, Trades, Reports and Settings, which are shared (`AlgoTabs.tsx`). Adding an algo = one registry
  entry + one Overview panel + one backend adapter. The old `src/apps/algo` and `src/apps/trending-oi-algo` pages are gone.
- **One API shape** (`backend/algos_api.py`, `/api/algos/*`, owner-only) over adapters (`backend/algo_adapters.py`). An
  adapter only reads its algo's own records and calls its own service; no trading logic moves. The algos keep their own
  tables (ADR 0011 still holds for events / state / candles / summaries).
- **Settings for every algo in two shared tables** (`backend/algo_settings.py`): `th_algo_settings` (slug → overrides
  JSON) and `th_algo_settings_log` (slug, time, key, old → new, user). Defaults stay in each algo's config file. Field
  specs (kind, min / max, choices, read-only) validate every change; cross-field checks (entry window before the
  square-off, RSI bands) run before saving. The Trending OI Algo moved its overrides here (`toi_algo_settings` is no
  longer used). OI Breakout's merged values are written into `algo_config` at startup and on each change, because its
  logic reads that module at each decision.
- **Open trades keep what they were opened with**: OI Breakout now stores `stopPct`, `targetPct` and `lots` on the trade
  at entry and its exit check reads them (replays without them fall back to the config). Trending OI already did.
- Each settings change is also a line in the algo's decision log ("Setting … old -> new (by user)").

## Consequences
- The old per-algo routes (`/api/algo/*`, `/api/toi-algo/*`) stay for the Overview panels' live status and for tools /
  tests; the pages no longer use their events / reports / settings routes, which can be removed later.
- `toi_algo_settings` can be dropped once the live database has run on the new tables (it holds nothing the defaults
  don't, since candleMin 3 became the default).
- A new algo (ORB next) uses `th_algo_settings` from the start.
