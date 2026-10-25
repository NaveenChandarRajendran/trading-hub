# Current state

_Last updated: 2026-10-23 (signal watcher + auto paper on `Diwakar_OptionBuy_Backtest`)_

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

## Signal watcher + auto paper trading (branch `Diwakar_OptionBuy_Backtest`, ADR 0004)
PAPER ONLY. Owner's brief 23-Oct-2026. Rules: `docs/strategies/trading-hub-trend.md`, `docs/strategies/megabull.md`.
- Dashboard layout, top to bottom: top bar (index, expiry, interval, "Exit by 3:15 PM · N min left" chip, India VIX chip
  (record only), clock, Refresh) → day levels (both indices: previous H / C / L, pivot = (H+L+C)/3, today H / L, VIX,
  PCR) → chart (SuperTrend 10,2 red/green, Bollinger 20,2, EMA 20, VWAP on futures volume, volume, RSI 14 with put
  30-45 / call 55-70 guide lines, pivot and S1-S3 / R1-R3 dashed) → MEGABULL RULE and TRADING HUB RULE cards (GO / NO GO,
  grade, ticks, account) → Trending OI last 5 rows + "OI views side by side" (Dhan vs Sensibull, Agreement) → OI S&R
  table with the biggest walls → paper trade card (Auto ON / OFF kill switch, per-account limits, live premium, P&L,
  stop / target bar, "Place stop + target together", "Exit position") → snapshot log bar (Download CSV).
  The glance-card column is gone (its contents are in the OI section); `logic/cards.ts` still feeds the components line.
- Backend: `sig_indicators.py` (same maths as the chart, shared fixture), `sig_oi.py` (port of the OI apps' formulas),
  `sig_rules.py` (both rules), `sig_market.py` (state from CandleService, chain cache, tracker, VIX), `sig_service.py`
  (watcher thread every 5 min at hh:m5:35, snapshot CSV, alerts, end-of-day summary, routes), `autopaper.py` (trader:
  Auto switch, daily limits, entries, SL-M stop + watched target, signal / time exits, trade log CSV),
  `megabull_client.py` (MegaBull paper API; `python megabull_client.py check` is read-only). Settings: `autopaper.json`
  (optional `autopaper.local.json`, not committed). State: `data/autopaper_state.json`.
- Endpoints: `GET /api/signals/state?symbol=`, `GET /api/signals/snapshots.csv?date=`, `POST /api/autopaper/auto`,
  `POST /api/autopaper/bracket`, `POST /api/autopaper/exit`. `dhan_client.index_ltp` (India VIX, IDX_I 21).
  `dashboard_api.CandleService` (the candles cache, now shared with the watcher; endpoint unchanged).
  `paper_api.PaperService.watch / ltp / order / open_qty` hooks.
- Owner decisions (23-Oct): cumulative delta (Dext) is "not checked", never blocks, trades tagged; Trading Hub
  must-have (b) = Trending OI ±50% × 3 rows AND Dhan OI & OI Change verdict agrees, Sensibull record only; MegaBull
  trigger levels = pivot, previous high / low, OI R1 / S1.
- Tests: `test_sig_indicators.py`, `test_sig_oi.py`, `test_sig_rules.py`, `test_sig_market.py`, `test_autopaper.py`;
  frontend `logic/indicatorsShared.test.ts`, `logic/signals.test.ts`.
- Evening update (23-Oct): order flow (`orderflow.py`: delta estimated per tick from the near-month future's Full
  packets vs the previous best bid / ask, tick rule in between; per minute, saved in `data/orderflow_<day>.json`;
  `GET /api/orderflow`, `POST /api/orderflow/dext`); main chart: cumulative delta (est.) pane under RSI, no per-candle
  bars; "Order flow, last 30 min" card beside the rule cards; new page **Order Flow (est.)** (`src/apps/order-flow/`:
  price, delta bars, cumulative line, 1/3/5/15/30m, last 12 candles with a typed Dext column, match tick, delta jump).
  Rule thresholds in `autopaper.json` "rules" (`sig_rules.configure`); PCR 0.9; Dharani SuperTrend flip trigger;
  MegaBull Grade A only. Shadow logging (record only): after every exit to 15:30 (trade log columns, rewritten at
  15:31) and skipped setups (`shadow_skips.csv`). Paper section: MEGABULL ACCOUNT and TRADING HUB ACCOUNT cards, today's
  trades for both accounts with day P&L, order book lists (`GET /api/autopaper/orders`), shadow line.
  `Start_Trading_Day.bat` (+ `scripts/start_trading_day.ps1`): hidden Dhan prompts, MegaBull key only when missing or
  older than 25 days (`%USERPROFILE%\TradingHubKeys`), starts both windows, checks Dhan (`/api/expiries`) and MegaBull
  (`GET /api/autopaper/check`, read-only), opens the dashboard. 30-minute chart interval.
- Known limits / open: MegaBull is off until the owner confirms the ⚠ numbers in `megabull.md` and the API check has run
  (instrument file confirmed 23-Oct: a downloadUrl to a 3-column CSV, names parsed, lot size taken from Dhan; order
  fields and bulk-cancel body are unverified; two pending SELLs not yet tested). India
  VIX ID 21 is from Dhan's list, not yet checked live. Nothing has run against a live session yet: check the first
  watcher rows at 09:20-09:35. Alerts show on the dashboard and in `alerts.log`, not on the phone.
- Date picker + interval dropdowns (owner, 23-Oct-2026): dashboard chart card has Interval (1, 3, 5, 10, 15, 20, 30,
  45 min, 1 hour, 1 day) and Date (today live, or one of the last 60 trading days, `GET /api/dashboard/sessions`); with
  1 day it shows Range (15 / 30 / 90 / 180 days, 1 year; index daily candles, `GET /api/dashboard/daily`). An earlier day:
  `GET /api/dashboard/candles?date=` (fetched once, cached; meta.prevSession gives that day's pivot), no live feed, no OI
  levels. Order Flow page: same intervals up to 1 hour plus Date from the saved `data/orderflow_<day>.json` files
  (`GET /api/orderflow/days`, `/api/orderflow?date=`); Dext column is read-only for earlier days. Rule cards always use
  today's 5-min reading.
- Start_Trading_Day.bat (owner, 23-Oct-2026): asks the Dhan client ID once and the token only when the saved one is
  older than 23 hours or Dhan rejects it; both in `%USERPROFILE%\TradingHubKeys\dhan.json` (token DPAPI-encrypted,
  this Windows user only). MegaBull key asked only when missing or older than 25 days.
- Charts (dashboard + Order Flow): the mouse wheel scrolls the page until the chart is clicked; then it zooms the chart
  until the mouse leaves it (`src/shared/chartWheel.ts`, owner 23-Oct-2026). Dragging works either way.
- Sensibull-style views (Sensibull OI Change Live page, dashboard "OI views side by side"): change in OI now counts
  from the day's first chain at or after 09:15, like Sensibull (`chain_cache.OpeningOi`, `data/open_oi_<day>.json`,
  legs carry `open_oi`, meta `openOiAt`). Falls back to the previous-day settled OI when 09:15 was not recorded
  (backend started late or after the close); the page says which. Owner 23-Oct-2026: the old view read Bullish on a
  clearly bearish day because the put side counted from the previous close. The NSE paste app's formulas already run
  live on Dhan data (OI & OI Change Live), so no separate NSE fetch is needed (same exchange OI).
- Dashboard "OI views side by side" has a third column, Trending OI (`sig_oi.trending_view`: the rule's test on the
  last 3 completed rows, ±50%), and a count in the header ("3 of 3 Bearish"). Record only; the rules are unchanged.
- `keep_awake.py`: on Windows the backend stops the PC from sleeping until 16:00 IST (SetThreadExecutionState, like
  call apps); the screen may still lock. Owner 24-Oct-2026.
- Dharani v2 (owner 25-Oct-2026, `docs/strategies/dharani-v2.md`, `sig_dharani_v2.py`): the teacher's tuned
  Quantman setups copied as taught: NIFTY and BANKNIFTY (owner added BANKNIFTY), 3-minute candles (call on the index, put on the futures), call 5 and
  put 8 conditions, exit on a SuperTrend close-through, no fixed target, −10 % safety stop, strike by premium near ₹250 (NIFTY) / ₹500 (BANKNIFTY).
  The watcher now wakes on every 3- and 5-minute close; `CandleService.get_with_futures` keeps the futures' own candles
  and 4 sessions of history (EMA 200). The MegaBull Nifty setup is renamed SuperTrend Nifty. Auto trader positions are per
  rule ("slot"), not per account; a rule never buys the option another rule holds on the same account.
- Accounts (owner 25-Oct-2026, ADR 0006): MegaBull = strict rules only (4 Pillar, SuperTrend Nifty = old "Dharani v1").
  The app's paper trading has one Rs 1 lakh account per auto strategy (`strategy_books.StrategyBook`, data/books/<name>):
  **Trend** (Trading Hub rule) and **Dharani** (the teacher's setup). Books reuse the paper engine and get the same
  ticks from PaperService. The owner's own Paper Trading screen stays the main account ("manual"): hand trades and the
  "stop + target" button. Dashboard: three account cards with balances.
- Backtest (owner 25-Oct-2026, `docs/backtest.md`): 5 years of Dhan data (index minutes, rolling option prices),
  `bt_data.py` + `backtest.py`, the live rule functions reused; MegaBull rules and Dharani tested, Trend not (no past
  chain OI). Backtest page in the app (home group): strategy chips, totals, profit curve (series tokens
  --series-1..4), year / month tables, exits, trades + CSV, Run button (after market hours). Also `Run_Backtest.bat`.
- Names and indices (owner 25-Oct-2026, ADR 0007): **4 Pillar Rules**, **SuperTrend Rules** (MegaBull account),
  **Dharani Rules**, **Trend Rules** (app accounts). All four run on NIFTY and BANKNIFTY from 26-Oct: rule ids
  `fourPillar` and `superTrend` (each its own slot per index) replace the single `megabull` rule (kept as a slot for
  old trades). Dashboard: four rule cards (+ order flow). Snapshot CSV: new `st_*` columns for SuperTrend Rules
  (`mb_*` = 4 Pillar Rules). Backtest: every strategy on both indices, Trend Rules added as approximate (Trending OI
  from past option OI of ATM±10, counted from 09:15); the download is now ATM±10 with OI (~10,000 pieces, 2–3 hours
  the first time). Backtest page: one chip per strategy + Index filter.
- A GO the account cannot take (MegaBull still off, Auto OFF, a limit) now goes to the shadow log as "GO, not sent", so
  MegaBull rule results are tracked before MegaBull orders are switched on.

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
Strategy engine for ORB, live orders, Alembic migrations. (Paper trading, the two rules and their strategy docs exist now.)

## Known limits
- Paste-based apps depend on NSE's browser session (empty JSON when it has expired).
- Backend: minutes while it is down are not recorded; Dhan tokens expire about daily.
