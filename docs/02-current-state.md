# Current state

_Last updated: 2026-10-22 (Dashboard on `feature/dashboard`)_

## Apps (frontend, `src/apps/registry.ts`)
| App | Data | Notes |
|---|---|---|
| OI & OI Change (`option-strategy`) | pasted NSE option-chain-v3 JSON | Excel port; older styles (`index.css`) |
| Sensibull OI (`sensibull-oi`) | pasted Sensibull response | older styles |
| **Dashboard** (`dashboard`, landing page) | backend `/api/dashboard/*`, `/ws/paper` candles | top of the sidebar; design system |
| **Premium Analysis** (`premium-analysis`) | two pasted NSE option-chain-v3 JSONs | Manual group; design system |
| **PCR Trend Analysis** (`pcr-trend`) | pasted Sensibull OI + NSE option-chain-v3 JSONs | Manual group; design system; for Naveen's father, not on the Dashboard |
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
- S1–S3 / R1–R3 = OI Support & Resistance Live's `analyzeChain` + `topLevels` (range 500) on the summary's chain;
  six price lines created once and updated in place (`logic/levelLines.ts`); the price scale includes all six.
  The lines move at most once an hour (`LEVELS_REFRESH_SEC`, `takeNewLevels`); Refresh or a new index / expiry
  redraws them at once. The cards keep the summary's 1-minute refresh; the OI S&R card measures the latest spot
  against the chart's (hourly) S1 / R1. The levels row shows "Levels 10:05 IST · next 11:05".
  Levels row under the chart with CopyValue + "Copy levels for chart". Chart: 620px (480px on short screens).
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

## PCR Trend Analysis (branch `feature/pcr-trend-analysis`)
Replaces the father's Excel "Trend Analysis" sheet. Manual (Paste) app only, no backend, not on the Dashboard.
- Two paste areas (Sensibull OI response, NSE option-chain response), **Calculate**; each read paste collapses to
  "source · time · spot ✓ · Edit". Parsers are the existing ones (`sensibull-oi/logic/sensibull.ts`,
  `option-strategy/logic/optionChain.ts`), imported as other apps already do; their results are unchanged.
- Rule (agreed with the sheet's author, 2026-10-25): **today's OI = yesterday's OI + today's change**. Rows per strike:
  CE yesterday OI, CE OI chg, CE today OI, Strike PCR, PE yesterday OI, PE OI chg, PE today OI.
  Strike PCR = PE today OI ÷ CE today OI; source PCR = Σ PE today OI ÷ Σ CE today OI; Final = average.
- Model (`logic/sources.ts`), all in units: Sensibull today OI = `to_*_oi`, change = `to − from` (from = 09:15 =
  yesterday's close; a chart starting later is flagged); NSE `openInterest` / `changeinOpenInterest` × lot size
  (`config/settings.ts` LOT_SIZE: BANKNIFTY 30, NIFTY 65). Shown in lakhs like the sheet. Sensibull's `to_time`
  after the close is capped at 15:40 IST.
- Window (`logic/pcr.ts`): ATM (strike nearest spot, lower on a tie) ± N strike steps (step = most common strike gap;
  N = 10, Settings). Verdict < 0.9 Down side, > 1.1 Up side, else Sideways (on the 2-decimal value shown; thresholds
  in Settings, saved in localStorage `pcr-trend.settings`).
- Checks: different index or expiry → error, nothing calculated; > 5 min apart → warning; ATM differs → note.
- Verified on the real 23-Oct-2026 BANKNIFTY pastes (expiry 27-Oct-2026, 15:40, the Excel's day): NSE × 30 equals
  Sensibull at every strike; both PCR 0.97, Final 0.97 → Sideways. The Excel showed 1.01 / 0.50 / 0.75 Down side
  because its NSE block added the change on top of today's OI (counted twice) and had typing slips (53,600 CE,
  54,600 / 54,700 PE, NSE 54,300 CE chg); a test pins the sheet's Sensibull cells against the paste.
- Open: thresholds and the Excel's "Direction" box (Long Build Up, Strong Up Trend, …) still to confirm; not built.

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
