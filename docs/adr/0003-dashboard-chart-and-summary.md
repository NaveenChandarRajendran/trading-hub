# ADR 0003: Dashboard chart library and a "raw data" summary endpoint

Date: 2026-10-22 · Status: accepted

## Context
The Dashboard shows a live index chart with the OI support / resistance levels and a glance card for every live app.
Two choices had to be made: how to draw the chart, and where the cards' numbers are computed. The live apps' formulas
live in the frontend (`logic/` modules, tested against reference tools). A second copy in Python could drift from them.

## Decision
- **Chart:** TradingView Lightweight Charts (`lightweight-charts`, Apache-2.0), pinned to exactly `5.2.1` (released
  2026-08-12). The TradingView attribution logo stays on (`layout.attributionLogo`) and the chart card links to
  tradingview.com, as the licence asks. The TradingView iframe widget was rejected: it cannot show our levels.
  The library bundles into the single `dist/index.html` (about +180 kB).
- **Summary endpoint returns raw data, not verdicts:** `GET /api/dashboard/summary` returns the shared cached option
  chain, the newest Trending OI rows and component quotes + daily candles, each with its own status. The browser
  computes every card and the S/R lines with the apps' own functions (`analyzeOptionChain`, `analyzeSnapshot`,
  `analyzeChain` + `topLevels`, `buildRows` + `summarize`). Index weights stay in the frontend; the page sends the
  stock list.
- **Live candles** reuse the paper feed's single Dhan connection: index ticks become a 1-minute candle on the backend
  (`candles.py`, IST buckets from the backend's receive time) and go out as `candle` messages on `/ws/paper`.

- **Volume** comes from the near-month index future (Dhan's index volume exists but means something else),
  merged into the index candles per minute; the page keeps 1-minute candles and aggregates them per interval.

## Consequences
- A card can never disagree with its app; a formula change in an app reaches the dashboard automatically.
- The summary response carries the whole chain (~250 kB) once a minute. Fine on localhost; trim it if the backend
  is ever served remotely.
- No extra Dhan load: the chain comes from the 10 s cache (shared with the tracker and the live apps), quotes from the
  2 s cache, previous closes once per stock per day, intraday candles once per symbol per minute.
- One more dependency to keep up to date; upgrade deliberately (exact pin, check the attribution rules on upgrade).
