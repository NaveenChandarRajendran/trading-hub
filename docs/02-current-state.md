# Current state

_Last updated: 2026-10-23 (OI breakout algo on `feature/oi-breakout-algo`, built on `feature/sr-level-history`)_

## Apps (frontend, `src/apps/registry.ts`)
| App | Data | Notes |
|---|---|---|
| OI & OI Change (`option-strategy`) | pasted NSE option-chain-v3 JSON | Excel port; older styles (`index.css`) |
| Sensibull OI (`sensibull-oi`) | pasted Sensibull response | older styles |
| **Dashboard** (`dashboard`, landing page) | backend `/api/dashboard/*`, `/ws/paper` candles | top of the sidebar; design system |
| **Premium Analysis** (`premium-analysis`) | two pasted NSE option-chain-v3 JSONs | Manual group; design system |
| **OI Support & Resistance** (`oi-support-resistance`) | pasted NSE option-chain-v3 JSON | new 2026-10-20; first app on the design system |
| **Paper Trading** (`paper-trade`) | backend `/api/paper/*`, `/ws/paper` (live Dhan feed) | simulation only; design system |
| **OI & OI Change Live** (`oi-change-live`) | backend `/api/option-chain` (Dhan) | paste app's formulas on live data; design system |
| **Sensibull OI Change Live** (`sensibull-oi-live`) | backend `/api/option-chain` (Dhan) | paste app's formulas on live data; design system |
| **OI Support & Resistance Live** (`oi-support-resistance-live`) | backend `/api/option-chain` (Dhan) | Refresh button only; each refresh = one snapshot |
| Trending OI (`trending-oi`) | backend `/api/trending-oi` | older styles; grid polish 2026-10-21 (see below) |
| Index Components (`components`) | backend `/api/quotes`, `/api/history` | own `--cp-*` palette |

## Dashboard (branch `feature/dashboard`, ADR 0003)
Landing page (`/`), at the top of the sidebar above Manual / Live. Run the backend (`python main.py`) and open it.
- Chart: TradingView Lightweight Charts `5.2.1` (exact pin, attribution logo + link kept). Candles from
  `GET /api/dashboard/candles?symbol=&interval=1|3|5|15` (Dhan `/charts/intraday` 1-minute, today + previous trading
  day, cached 60 s open / 15 min closed, aggregated to 09:15-aligned IST buckets in `backend/candles.py`). The live
  1-minute candle comes as `{"type":"candle"}` on `/ws/paper` (paper feed's single Dhan connection, built from index
  ticks by IST receive time). Colours read from the tokens and follow the theme without a reload.
- S1–S3 / R1–R3: the backend's recorded levels (stability rule, see "S/R level history" below), drawn as step
  segments over the time each was in effect. Before anything is recorded today, the raw `topLevels` ranking of the
  summary's chain is drawn across the bars (and said so under the chart). Levels row with CopyValue + "Copy levels for
  chart". Chart: 560px (480px on short screens).
- `GET /api/dashboard/summary?symbol=&expiry=&stocks=` (`backend/dashboard_api.py`): the cached chain, newest Trending
  OI rows and component quotes + daily candles (previous closes warm up in a background thread → `warming`), each
  section with its own status (ok / stale / warming / empty / token / error). Auto-refresh 1 min (Settings: 30 s–5 min).
- Glance cards (`logic/cards.ts`), each with the app's own logic: Trending OI (latest sentiment), OI & OI Change
  (final average vs spot), Sensibull (anticipated vs spot; Change in OI, 10 + 20, ±25), Index Components (index move
  from components, ±0.05 neutral band; no verdict while previous closes load), OI S&R (spot vs S1 / R1, "Levels" tag,
  no verdict). Consensus line counts verdicts only. Below 1200px the cards go under the chart.
- Indicators (toggles in the chart header, remembered per browser; Volume and RSI on by default):
  - RSI 14 (Wilder, = TradingView ta.rsi) in its own pane, 0-100 with dashed 80 / 20 lines.
  - EMA 20 (= ta.ema, SMA seed) on the candles.
  - Volume = the near-month index future's (NIFTY / BANKNIFTY OCT FUT ...; `instruments.near_future`, rolls the day
    after expiry; stored apart from the options in `option_instruments.json`). Dhan does send volume for the index
    itself (~293 M on 21-Oct, most likely constituent shares; last minutes stuck at one value), so the future's
    contracts are used instead, as TradingView's NIFTY1!. History merged per minute in `/api/dashboard/candles`;
    live minute from the feed's running day volume (`VolumeBuilder`, `"volume"` messages on `/ws/paper`).
  - The page keeps 1-minute candles and groups them per interval itself (`logic/candles.ts aggregate`, same 09:15
    buckets as `backend/candles.py`), so switching interval needs no request and live volume is never double counted.
- Dhan's intraday toDate is exclusive by date: the candles request runs to the day after the last session
  (before this, today's candles were missing from the history during market hours).
- Tests: `backend/test_dashboard_api.py`, `backend/test_candles.py`, `backend/test_instruments.py`,
  `src/apps/dashboard/logic/*.test.ts` (RSI checked by hand on the StockCharts closes: 70.46, 66.25).
- Known limits: the live candle is untested against real ticks (built after market hours; check at 09:15). Dhan's
  intraday data has no 09:15 candle for the index (first is 09:16), so the first bar of the day comes from the live
  feed. Trending OI is empty after midnight until the first snapshot (the tracker starts fresh each day).
  Backend refactor: `/api/quotes`, `/api/history` and `/api/trending-oi` bodies moved into shared helpers in `main.py`.

## OI breakout algo (branch `feature/oi-breakout-algo`, ADR 0005, rules `docs/strategies/oi-breakout.md`)
PAPER ONLY. Runs inside the backend all day for NIFTY and BANKNIFTY: levels locked at 09:30, breakout-pullback and range
setups on 5-minute candles, filters from the live apps, its own "Algo" paper account (₹1,00,000). `ALGO_MODE` =
`paper` (default) / `signals` / `off`. Page: Live → Algo (paper).
- Backend: `algo_config.py` (all numbers), `algo_logic.py` (pure rules), `algo_filters.py` (Python ports of the
  OI & OI Change, Index Components and RSI functions, golden-tested), `algo_service.py` (runner, own PaperEngine,
  decision log, restore), `algo_api.py` (`/api/algo/status`, `/events`, `/stop`, `/stop-exit-all`, `/resume`).
  `paper_api.py`: packet listeners + extra feed subscriptions. Store: `pt_accounts.name`, `pt_orders.source/setup`,
  `algo_events`, `algo_state` (JSON: in `paper.json`, now written under a lock). Log file `backend/logs/algo-<day>.log`.
- Frontend `src/apps/algo/`: status per index (levels, setup, open trade), kill switches, today's trades with
  "Why" (entry and exit reasons) and "Copy review", decision log (filters, date).
- Tests: `test_algo_logic.py` (state machine), `test_algo_filters.py` (ports vs TypeScript), `test_algo_service.py`
  (end to end with the real engine: entry, exits, 15:15, risk, stale data, restart, kill switch, signals mode, the
  no-real-orders check), `algo/logic/algo.test.ts`.
- First live paper day 23-Oct-2026 (A): ran all day, no trades (see "23-Oct review" below).
- Reliability (24-Oct): feed watchdog in `dhan_feed.py` (polled recv, reconnect after 2 min without packets in market
  hours, `on_event` into the algo log), per-index watchdog + logged resubscribe / reconnect attempts, exceptions with
  tracebacks, heartbeat every 15 min, status `health` (ok / stale / error + reason) on the page, network calls outside
  the algo lock, candles only 09:15–15:30 and opening at or after 09:30. Tests: `test_algo_health.py`,
  `test_dhan_feed.py`.
- Live variant **B** (since 26-Oct), shadows A / C / D on the same candles (signals only, never an order, variant tag
  on every row); "no room" skip in every variant. `test_algo_shadows.py`, `test_algo_variants.py`.
- **Postgres is the single source of truth (ADR 0006).** `main.py` reads `DATABASE_URL` (and the Dhan keys) from
  `backend/.env.local` and refuses to start without a reachable database; no JSON fallback (`JsonStore` /
  `PaperJsonStore` remain only as test doubles). The app never reads `logs/*.log` (write-only backup).
  Tables: `algo_events` (ts, trade_date, index, variant, type, setup, message, details, uid; migrated in place from
  the 23-Oct layout), `algo_state` (per index + variant), `algo_levels`, `algo_candles`, `algo_daily_summary` (15:35
  IST, `POST /api/algo/summary` recomputes), `oc_snapshots` (per strike per minute), `pt_orders.variant`.
  The same database also holds another project's tables (`candles`, `option_oi`, `trades`, `signals`, ...): never touched.
- Reports: Algo page Today | Reports. Reports: presets / custom range, index + variant filters, tiles, day-wise table
  (CSV), variant comparison, day view (levels, trades of all variants, decision log with CSV, candles with filter
  values). Today: variant filter on the log (default live), shadows on the index cards, end-of-day comparison after
  15:35. Paper Trading P&L calendar: Manual | Algo. Endpoints `/api/algo/day`, `/api/algo/reports`,
  `/api/paper/pnl?account=algo`, `/api/paper/trades?account=algo`. `algo_reports.py`.
- Import (idempotent): `python scripts/import_legacy.py` (JSON store + algo logs -> Postgres; run on 24-Oct: +4
  toi_session, +1,120 toi_snapshot, +7 pt_orders, +7 pt_trades, +3 pt_positions, +142 algo_candles, +2 algo_levels,
  +2 algo_daily_summary; algo_events +0 because the 23-Oct events were already in Postgres; a second run adds 0).
- Backup: `python scripts/backup_db.py` -> `backend/backups/trading-hub-YYYY-MM-DD.sql` (pg_dump, plain SQL; nothing is
  ever deleted). Tests on Postgres: `test_algo_db.py`, `test_pg_store.py`, `test_paper_store.py` with
  `TEST_DATABASE_URL` pointing at the throwaway database `trading_hub_test` (they TRUNCATE tables).
- Replay: `algo_replay.py --source db|dhan` (Postgres only), Replay accounts, report in `logs/replay-<date>.md`.
- Option-chain snapshots every tracked minute (`chain_snapshots.py`, ATM ±25 strikes) -> `oc_snapshots`.
- 23-Oct review: the feed was not silent from 09:50 (every 5-minute candle 09:25–15:15 had 5 live minutes, filters
  fresh). The page looked dead because candle lines are hidden in the log by default and no rule fired after 09:45
  (both indices below S1 with the breakdown already used; A has no S2 / S3 setups). Ticks did stop at about 15:14,
  with nothing logged: recv() had no timeout (a half-open socket blocks it forever) and staleness was only checked
  when a candle had ticks. Both fixed. That day ran with Postgres (DATABASE_URL set in the console only) while 24-Oct
  ran with JSON, so the 23-Oct events are in Postgres; the page now falls back to the log file.
- Known limits: candles missed while the backend is down are skipped (only the newest closed candle is evaluated);
  the paper P&L page does not separate the Algo account yet (deferred, with replay / backtest and a settings popover).

## S/R level history (branch `feature/sr-level-history`, ADR 0004)
Levels used to be re-ranked on every chain, so they jumped around and old lines vanished. Now the backend decides them
once a minute with a stability rule and records every change; the Dashboard, OI S&R Live and Paper Trading all read
the same levels.
- Backend `sr_levels.py` (pure, parity-tested with `topLevels` on the 21-Oct fixture): per side, the strongest
  outsider replaces the weakest level only when its OI leads by `leadPct` % (10) on `confirmRefreshes` (3) refreshes in
  a row; a level spot crosses or that leaves the range (500) is replaced at once; empty slots are filled at once; slots
  are renumbered nearest first. The tracker runs it on each minute poll of each tracked expiry (`_record_levels`;
  failures are logged, never break Trending OI; failed writes retry). Rows only on change: table `sr_levels`
  (slot, strike, oi in units, valid_from, valid_to, reason open / oi / crossed / range / fill / renumber), or
  `data/sr_<sym>_<expiry>_<date>.json`. A restart resumes from the open rows.
- `GET /api/sr/history?symbol=&expiry=&date=` (current, segments, changes newest first), `GET/PUT /api/sr/settings`
  (shared rule, table `sr_settings` / `data/sr_settings.json`; used from the next refresh).
- Dashboard chart (`fix/dashboard-levels`, 25-Oct): exactly one set of S1–S3 / R1–R3 price lines (`logic/levelLines.ts`,
  existing style, right-axis labels). Level history is still recorded (sr_levels, algo tables) but no longer drawn:
  no segments, faded lines, shift markers, History / Morning toggles, Pin levels or paper entry-zone line.
  **Fix zones** checkbox in the chart head: ticking it stores the levels on the chart with the time in Postgres
  (`dashboard_fixed_levels`, one active set per index + expiry, `GET|PUT|DELETE /api/dashboard/fixed-levels`,
  `dashboard_levels_api.py`); the lines then stay put ("Fixed at 10:15") until unticked. The row under the chart shows
  the live levels (CopyValue), or, while fixed, "fixed → now" per level ("22,500 → 22,400 ↓100", "22,700 —") with
  "2 levels shifted since 10:15". "Level changes today (n) ▸" is collapsed by default. `logic/fixedLevels.ts`,
  tests `fixedLevels.test.ts`, `test_dashboard_fixed_levels.py`.
- OI S&R Live: each Refresh also fetches the history and shows the recorded levels (OI from that refresh); the range is
  the shared rule's. Falls back to its own ranking (with a note) when nothing is recorded.
- Paper Trading (`backend/paper_levels.py`, `frontend/src/apps/paper-trade/logic/levels.ts`): every order saves the
  index's current levels and the spot of that refresh (table `pt_order_levels`, or `order_levels` in `paper.json`;
  nearest tracked expiry when the option's own is not tracked). An open position shows its entry zone, the level
  nearest spot (either side) on the order that opened it: "Zone S1 22,900 · 10:00" under the instrument. When a level
  whose old strike was within 100 pts of the zone changes later (renumbering not counted twice), the row gets a warn
  pill "Level shifted → 22,800" and the page shows one notice per shift (seen ids per day in localStorage). The
  service re-checks open positions every 20 s and pushes a `position` message when a shift appears. Never exits.
  (The Dashboard no longer draws the entry zone; it stays on the Paper Trading position row.)
- Tests: `test_sr_levels.py`, `test_sr_api.py`, `test_paper_levels.py`, `test_paper_store.py` (order levels),
  `test_pg_store.py`; `dashboard/logic/levelHistory.test.ts`, `dashboard.test.ts`, OSR `levels.test.ts`,
  `paper-trade/logic/logic.test.ts`.
- Known limits: never run against a live market yet (the Dhan token was expired when it was built; screenshots used
  fixture data). Levels exist only for tracked expiries (`--track`) and only while the backend runs. The spot saved with
  an order is from the last minute poll, up to a minute old. Several shifts in one minute stack their markers.

## Sidebar
Grouped into collapsible sections from the `group` field in `src/apps/registry.ts` (`GROUPS` sets labels and order):
a header-less top section (Dashboard), "Manual (Paste)" and "Live (Dhan)". The first registry entry is the landing page. Both start open; closed sections are remembered in localStorage (`shell.groups`).
With the sidebar collapsed to icons, section headers become dividers. Helpers + tests: `src/shared/sidebarGroups.ts`.

## Live OI apps (branch `feature/live-oi-apps`)
Live versions of the three paste apps, fed by Dhan through the backend (run `python main.py`, open the app under
"Live (Dhan)"). The paste apps are unchanged: their rendered output was compared on main vs this branch with the same
pastes (identical text).
- Shared UI: `src/shared/live/useLiveChain.ts` (symbol/expiry/auto-refresh Off·15s·30s·1m·3m·5m, default 1m, saved per app;
  paused while the tab is hidden, every 5 min while the market is closed; `manual` mode = Refresh button only),
  `src/shared/live/liveStatus.ts` (Live / Stale after 2× interval / Market closed / Token expired / Paused, tested),
  `src/shared/ui/LiveToolbar.tsx` (toolbar + error / token / stale alerts).
- OI & OI Change Live (`src/apps/oi-change-live/`): `analyzeOptionChain` (moved out of `OptionStrategyApp`, results
  unchanged and tested) on `toOptionChain`. OI in contracts. Grid opens scrolled to ATM.
- Sensibull OI Change Live (`src/apps/sensibull-oi-live/`): `analyzeSnapshot` (moved out of `SensibullOiApp`, unchanged
  and tested) on `toSbSnapshot`, cut to ATM ± R (`logic/range.ts`; Range ±10/15/20/25 in the toolbar, default ±25 so all
  windows 5–25 exist). Value: Change in OI (default) or Closing OI. Ticked windows survive auto-refresh. Lakhs of units.
- OI Support & Resistance Live (`src/apps/oi-support-resistance-live/`): no auto-refresh. Each Refresh click fetches
  the chain and saves one snapshot (first of the day = baseline), stored like pastes under `oi-support-resistance-live.`
  (earlier days dropped). Unchanged Dhan data (market closed / same cached chain) is not saved twice (`logic/saveRule.ts`).
  Snapshot time = backend fetch time. Range / threshold / "Clear today's snapshots" in Settings. The page starts empty
  after navigation: press Refresh (which saves a snapshot).
  Shared with the paste app: `buildView` (moved from the component, tested), `OsrResult.tsx` (result screen moved out
  unchanged; wording via `source`), `createStore(prefix)` in `storage.ts`.
- Shell fix: the topbar title matched apps by path prefix, so `/sensibull-oi-live` showed "Sensibull OI"; now exact.
- `GET /api/option-chain?symbol=NIFTY&expiry=2026-10-27` (`backend/chain_cache.py`, ADR 0002): one cached chain per
  key (10 s open / 5 min closed), one fetch for concurrent requests, last good chain on failure (`meta.stale`).
  The Trending OI tracker fetches through it (always fresh), so its minute fetches also serve the live pages.
  `meta.lotSize` from Dhan's instrument list (fallback table in `chain_cache.py`). `/api/status` shows `chainFetches`.
- `src/shared/dhan/chainAdapter.ts`: `toOptionChain` (NSE model, OI and volume ÷ lot size = contracts) and
  `toSbSnapshot` (Sensibull model, units; "from" OI = Dhan `previous_oi`).
- Field mapping / differences from NSE and Sensibull: change in OI = `oi − previous_oi` (Dhan's settled prior-day
  OI); price change = `last_price − previous_close_price`; IV is Dhan's model; no total buy/sell qty (0); timestamp
  = backend fetch time (Dhan sends none); ATM = strike nearest spot; totals summed over all strikes; Sensibull "from"
  = prior-day close instead of 09:15 OI, and the full chain instead of ATM ±15.
- Fixtures: `python capture_chain.py NIFTY BANKNIFTY` (reads `backend/.env.local`) writes the raw response to
  `backend/fixtures/` and the API body to `frontend/src/shared/dhan/__fixtures__/`. Current ones: 21-Oct-2026 after close.
- Tests: `backend/test_chain_cache.py`, `src/shared/dhan/chainAdapter.test.ts`.

## Premium Analysis (branch `feature/premium-analysis`)
Replaces Naveen's Excel: which strikes' premiums moved most for the spot move between two NSE snapshots.
Open the app, paste snapshot A (earlier) and B (later); each collapses to "A · 13:51 IST · Spot 54,725.40 ✓" (Edit to
re-paste). The parsed snapshots (compact, not the raw JSON) and the toggles are kept in localStorage (`premium-analysis.*`).
- Parser: the OI & OI Change `parseOptionChain` (now also reads the older `bidprice` / `askPrice` when `buyPrice1` /
  `sellPrice1` are missing; v3 results unchanged). Checks: same symbol, same expiry, B later than A (Swap button).
- `logic/premium.ts`: spotMove = spotB − spotA; per strike and side chg = premB − premA, chgPct = chg ÷ premA × 100,
  ratio = |spotMove| ÷ |chg| (lower = premium moved more), efficiency = chg ÷ spotMove (CSV only). Basis LTP or
  Mid = (bid + ask) ÷ 2. Premium 0 / no bid or ask (Mid) in either snapshot = "No trades" for that side; chg 0 or
  spot move 0 → ratio "—". Top movers: chg > 0 only, by points or %, ties to the lower ratio, top 10 per side.
- Screen: toolbar (index · expiry from the paste, LTP / Mid, Clear), summary strip (spot A → B, spot move, PCR at B
  = put OI ÷ call OI, ATM A / B), Top movers (click a row → full table scrolls to the strike and flashes it),
  mirrored AG Grid table with ATM A / ATM B tags, CSV.
- Tests: `logic/premium.test.ts` (the Excel reference values: 54,000 CE +73.05 / 4.14% / 3.44, 54,000 PE −41.35 /
  6.08, 55,000 CE +52 / 4.84, 54,900 CE +7.20 / 34.93, 54,100 CE No trades; Mid; zero handling; top movers),
  `logic/snapshots.test.ts` (parsing, validation). The fixtures are NSE-shaped files built from those reference
  LTPs with made-up bid / ask / OI; no real 13:51 / 15:40 responses were available. Swap in real ones when captured.

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

## Copy values (2026-10-21, `fix/live-ui-polish`)
`src/shared/ui/CopyValue.tsx` shows a formatted number (22,900) with a copy button that copies the raw value
(`rawNumber` in `src/shared/clipboard.ts`: "22900", "22985.40", ASCII "-"). Icons are inline SVGs in
`src/shared/ui/icons.tsx`. The button shows on row / tile hover or keyboard focus (space always reserved), swaps to a
check + "Copied" (or "Copy failed") for 1.5 s. `copyText` uses the Clipboard API, else a hidden textarea +
execCommand (file:// pages). Used in OI S&R (paste and live): Strike column of both level tables, Spot and Max pain.
"Copy levels for chart" also uses raw values now: spot was rounded to 1 decimal ("55844.0"), it is now "55844" /
"22811.35". The red / green left edges on the Resistance / Support cards were removed (the green one read as a stray
bar after the Resistance table).

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

- Option chain UI (2026-10-21, `fix/live-ui-polish`): CALLS / Strike / PUTS group header row (call / put header tints
  toned down), ITM cells shaded with the new `--itm-soft` token (calls below spot, puts above; the ATM row keeps its
  highlight), a live spot line with a "NIFTY 22,957.05" pill between the two strikes around spot (`logic/chain.ts`
  `itm`, `spotGapAfter`, tested), and an ITM legend in the card head. Stat tiles wrap long text (`ui.css`).
  At ~1280px the chain card is narrower than the table, so it scrolls sideways (unchanged from before).

Known limits / open:
- Never run against the live Dhan feed yet: record frames with `backend/capture_feed.py` on a trading day
  (enables `test_captured_frames`) and check Dhan's LTT time zone.
- Charges are hand-worked, not yet checked against Dhan's brokerage calculator. STT is 0.15% (from 1-Apr-2026),
  the spec says 0.1%: decision pending.
- The instrument CSV (~26 MB) is downloaded twice a day (stock IDs and option list are separate caches).
- Positions held when the backend is down at 15:15 are squared off at the next start, at the then-current price.

## Trending OI grid (2026-10-21, `fix/live-ui-polish`)
UI only, numbers unchanged. Sentiment and "OI H/L Break" (was "Day High/Low Diff. in OI"; renamed because "Day H/L Break"
is already the index spot-break column) use soft design-system pills, centred (cells carry `.ds`, `trending-oi.css`).
Headers are one line with the long form and formula in `headerTooltip`. Up to 20 rows the grid sizes to its rows
(`domLayout autoHeight`), above that it is 640px and scrolls. The thin "column" after Time seen while scrolling sideways
is the next column sliding under the pinned Time column, not a real column. The grid container carries `.ds`, so every
pill in it (Strength, Dir Chg %, D.H.B./D.L.B., LIVE, Sentiment, OI H/L Break) is the soft design-system pill.

## Design system
`src/shared/tokens.css` (global) and `src/shared/ui/ui.css` + `src/shared/ui/index.tsx` (scoped to `.ds`),
from the trading-hub-feature skill. See `docs/adr/0001-scoped-design-system.md`. Older apps are not migrated yet.
Shared helpers added: `signed()` in `src/shared/grid.ts`, `copyText()` in `src/shared/clipboard.ts`.

## Not built yet
Strategy engine (ORB, Supertrend flip), paper trading, live orders, Alembic migrations, strategy docs.

## Known limits
- Paste-based apps depend on NSE's browser session (empty JSON when it has expired).
- Backend: minutes while it is down are not recorded; Dhan tokens expire about daily.
