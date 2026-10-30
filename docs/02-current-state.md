# Current state

_Last updated: 2026-10-30 (Sat 31 Oct release: one OI build-up verdict, R1/Bollinger fixes, order-flow 5-min table, manual entry texts, Box Pullback 5/1 removed; on `Diwakar_OptionBuy_Backtest`)_

## Changes of 30-Oct-2026 (owner OK each)
- **Power Breakout** = the rule called Dharani v2 in code (`sig_dharani_v2.py`). Call Bollinger (15,3) -> (20,2.5) (owner
  "Yes" 30-Oct). The result carries `pivotR1`; the checklist says "Close above pivot R1" and the chart draws that same
  line ("Pivot R1"); OI strike lines are titled "OI R1/S1". RSI guide lines come from the board preset.
- **One OI verdict everywhere** (owner 30-Oct: "keep this fixed every where"): `sig_oi.build_up` / `shared/oiBuildUp.ts`.
  lean = (puts - calls) / (|puts| + |calls|); Bullish if lean >= 0.10 and more puts than calls added today (puts =
  support), Bearish the mirror, else Neutral. Used by phone, votes, Charts & Signals, Option Strategy, OI change and
  Sensibull pages. The father's sheet average ("course sheet method") is shown below it, for reference only.
- **Order flow card**: 5-min table like Trending OI (`flow_summary.rows`, newest on top, live row marked).
- **Manual trades** send a phone entry message (`notify.manual_fill_listener`, `PaperService.fill_listeners`).
- **Box Pullback 5/1 removed** everywhere (app, phone, journal, Excel tab). Only 15/5 trades from Mon 2 Nov.
- Buy / Sell ticket: a MARKET buy can carry stop % / target % boxes (default 10 / 20, owner 30-Oct); right after the
  fill the page calls `/api/autopaper/bracket` with prices from the fill (`ticket.bracketPrices`). Manual trades only.
- Selling book 2-month strangle 5 % away instead of 3 % (owner OK 30-Oct); an open strangle keeps its strikes.
- Rebound Call: no entries after the 14:30 candle, time exit 15:14 (shown on the open-trade card).

## Momentum 20 stock books, 2 x Rs 5 L PAPER (owner 28-Oct-2026)
Rules: `docs/strategies/momentum-20.md`. `momentum.py` (pure screener, a port of the research backtest; same top 40 on
2020-07-31, 2024-08-30 and 2026-10-27) + `momentum_book.py` (`MomentumDesk`): 5-minute loop, Yahoo daily bars,
month-end ranking after 15:50, fills at the next open from 09:35, catch-up of missed days. Books `momSwitch`
(cash when Nifty < 200-day average) and `momAll`. Not in the journal (monthly, multi-day); phone texts via
`Notifier.send`. API GET `/api/momentum/state`, POST `/api/momentum/run`; Today page `MomentumCard`. Switch:
autopaper.json `momentum.enabled`, first day `momentum.start` (2026-10-30, first buys 2 Nov). Tests:
`backend/test_momentum.py`, `frontend/src/apps/today/logic/momentum.test.ts`.

## Option Selling book, Rs 3 L PAPER (owner 28-Oct-2026)
Rules: `docs/strategies/option-selling.md`. `sell_rules.py` (pure rules) + `sell_desk.py` (`SellDesk`): its own state
file `data/books/selling/state.json`, a 1-second loop thread for entries / time exits / the 15:05 strangle check, and
`PaperService.tick_listeners` for live books (stops, buy-backs). The buying PaperEngine is untouched (long-only,
intraday). Legs go to the journal as account "App · Selling" with `short: true` (entry order SELL, exit BUY; a
positional leg is re-recorded each morning with event "carry") and to the phone ("🟠 SELL"). API: GET
`/api/selling/state`, POST `/api/selling/exit/{leg_id}` (Today page Exit button on a SOLD row). Switch:
autopaper.json `selling.enabled` and each rule's `enabled`. Tests: `backend/test_sell_desk.py`.
Timed expiry straddles 09:40 / 11:26 / 12:24 (owner 28-Oct-2026): slots `sellStraddle940/1126/1224` reuse
`SellDesk._straddle(now, rule)`; per-rule `trailToCost` (false for these). Journal strategy names "Expiry Straddle 9:40 (sell)" etc.

## Box Pullback 15/5, Rs 1 L PAPER (owner 29-Oct-2026; 5/1 version switched off 30-Oct-2026: 1-min candles too noisy)
Rules: `docs/strategies/box-pullback.md` (opening box, close outside, buy the pullback; premium stop -10 % / target +20 %).
`sig_orb.py` + `SignalService.run_orb` (the watcher now also wakes every minute while it is enabled); exits are the
normal autopaper stop order / target. Book "orb" (15/5); the "orb5" book is gone (autopaper.json `orbPullback5` off). Backtest lost money; paper for learning only.

## Trend, 4 Pillar and SuperTrend are watch-only (owner 28-Oct-2026)
autopaper.json `watchOnly: ["tradingHub", "fourPillar", "superTrend"]`: `AutoTrader.on_signal` returns
"Watch only (config watchOnly)" for these slots, so a GO is not traded and sig_service puts it in the shadow log
("GO, not sent: Watch only"). Only Dharani and Rebound Call take paper trades. Why: 5-year review 28-Oct-2026
(page https://claude.ai/artifact/TziqL9KPqRafMFU2Mut6xM, scripts in project files research/rule-review/): all
three lose in 2025-26 with every setting tried (Trend 64 versions incl. real S1/R1 break, no re-entry, wider /
SuperTrend stops; 4 Pillar VIX 14/16/18/none). Remove a name from the list to let that rule trade again.

## SuperTrend Rules waits for a band close (owner 27-Oct-2026)
`sig_rules.supertrend_rule`: with `MB_ST_WAIT_BAND_CLOSE` (autopaper.json rules `superTrendWaitBandClose`, default on)
the setup is read on the candle before the last completed one and a new must-have check `bandClose` needs the last
completed candle to CLOSE beyond the Bollinger band (call: >= upper, put: <= lower); entry at the next open. Backtest
(both indices, -10/+20): -3.90 L / 1,491 trades -> -1.10 L / 583 trades. backtest.py uses it automatically.

## Navigation and the Today page (owner 27-Oct-2026: "very confusing to see where what is happening")
- Sidebar: five everyday pages on top, in this order: **Today** (`today`, new landing page `/`), **Charts & Signals**
  (`dashboard`, was "Dashboard"), **Buy / Sell** (`option-chain`, was "Option Chain"), **Trade History** (`paper-trade`,
  was "Paper Trading"), **Backtest**. Below them two folded sections, "Live market data" (6 tools) and "Paste tools" (5);
  `GROUPS.closedByDefault`, the open/closed state is saved per section (`shared/sidebarGroups.ts`); the section of the
  page on screen always shows. Paths are unchanged. Each page has a one-line `hint` under its title in the top bar.
- **Today** (`src/apps/today/`, logic in `logic/today.ts` with tests): every trade of the day from every account
  (Manual, Dharani, Trend, 4 Pillar, SuperTrend) from `GET /api/journal/trades?from=today&to=today`; open trades priced
  live from `/ws/paper` ticks (manual security id parsed from the journal id `manual-<day>-<sid>-<n>`, rule trades'
  ids from `/api/signals/state` auto.today). Big total (booked after charges + running before charges), a tile per
  account, **Strategies today** board (owner 27-Oct-2026 follow-up: one row per strategy with In a trade now / Winning /
  Losing / No trade today, its P&L, won / lost and what it holds; each strategy keeps one colour tag in every table), Open now table (Exit with a two-step confirm; manual: Add stop + target), Closed today table, Both / Nifty /
  Bank Nifty filter. P&L green / red everywhere; rows and tiles get a green / red edge. Refreshes every 10 s and on
  every fill. No backend change.
- **Phone alerts** (owner 27-Oct-2026, `backend/notify.py`, tests `test_notify.py`): Telegram bot messages on every rule
  entry and exit (exit with the day's booked P&L so far) and a short day summary per strategy (all accounts incl. Manual)
  right after the 15:31 end-of-day summary. One-time setup: `Setup_Phone_Alerts.bat` -> `backend/setup_phone_alerts.py`
  (bot key in a hidden prompt, chat found via getUpdates, saved to `~/TradingHubKeys/telegram.json`, outside git; test
  message). No file = alerts off. Sends on a background thread; a failed send is logged and raised once a day as an app
  alert, never blocks the trader. `GET /api/notify/status`, `POST /api/notify/test` (Today page "Phone alerts ON · test").
  Wiring: `main.build_signals` (on_order hook, `svc.phone`, `svc.rows_today`), `sig_service._end_of_day`.
  Hourly updates (owner 27-Oct-2026) at 10:15, 11:15, 12:15, 13:15, 14:15 (`sig_service._hourly`, `notify.hourly_text`):
  market line, each rule's result so far (won/lost with exit reason, in a trade with live P&L, "came close N of M" from
  `_track_near` = the hour's best skipped setup, or no setup), and the owner's own trades. The 15:31 day summary also has
  the market line and, for a rule with no trade, the day's closest call.
  Today page knows "Rebound Call" (slot `reboundCall`, journal strategy name "Rebound Call"); an unknown strategy name still
  gets its own row.
- Charts & Signals charts (owner 27-Oct-2026: "the current one is confusing"): the page always opens on a **plain chart**
  (candles only: no indicators, OI levels, pivot or trade marks; own toggles behind "Add my own indicators", saved as
  `dashboard.plainIndicators`, all off by default). Clicking a strategy on the board adds only its indicators, levels and
  trades; "✕ Back to plain chart" returns. The strategy choice is no longer remembered across reloads.
  **💾 Save zoom** on each chart keeps its candle width per index (`dashboard.zoom.<SYMBOL>`), used for every strategy,
  interval and reload, scrolled to the newest candle; it wins over the automatic per-view zoom; "Clear" forgets it.
- Charts & Signals: the Interval picker always shows (it hid when a strategy was picked; a strategy opens at its own
  candle size, "(rule)" marks it); the manual positions box and "Today's paper trades" table moved to Today (a link card
  with the day's P&L replaces them; Day P&L / Open trades in the strip link to Today); "Paper trading" header is now
  "Rule accounts". Buy / Sell: views "Option chain / My orders / My P&L", "My P&L today (manual)", links to Today after
  an order. `Start_Trading_Day` opens `/` (= Today).


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

## Signal watcher + auto paper trading (branch `Diwakar_OptionBuy_Backtest`, ADR 0004)
PAPER ONLY. Owner's brief 23-Oct-2026. Rules: `docs/strategies/trading-hub-trend.md`, `docs/strategies/megabull.md`.
- **Dashboard redesign 26-Oct-2026 (owner's notepad list + approved mockups; replaces the layout described next):**
  status strip (Both / Nifty / Bank Nifty tabs, both spots, Day P&L, open trades, VIX, exit-by chip, Refresh, Settings
  with the OI-levels expiry per index) → **strategy board** (`StrategyBoard.tsx`, `logic/board.ts`: 4 strategies × index
  columns; box = In trade (blue) / GO (green) / Close = one condition away (amber) / Blocked / Waiting "x of y"; click a
  strategy = its indicators on the charts, click a box = its checklist) → **charts** (`ChartPanel.tsx`: split Nifty |
  Bank Nifty under "Both", one chart under a single tab; `CHART_PRESETS`: only the selected strategy's indicators and its
  candle size — Dharani 3-min with EMA 200 / Bollinger 15,3; others 5-min; "All indicators" = own toggles + interval;
  ▲ buy / ▼ sell of today's paper trades; zoom saved per index + strategy + interval in localStorage
  `dashboard.view.*`, double-click = whole day; ⤢ maximize (Esc back), ⧉ pop-out = `#/chart-window?symbol=&strategy=`,
  `ChartWindow.tsx`, no sidebar) → paper accounts (both indices under "Both") + today's trades → **Market context**
  (collapsed `<details>`, remembered: day levels, per index levels row + Copy, Trending OI, OI views, OI S&R, order flow)
  → snapshot bar. `useDashboard(optionIds, {symbol, interval})` runs once per index; `useSignals` per index.
  OI views card: PCR labelled "(Dhan: OI + chg)", votes "Split: 1 bullish · 1 bearish · 1 neutral" when no majority,
  "OI lean NN% puts" next to the Dhan verdict. Snapshot CSV: new last columns `dhan_oi_lean_put_pct`, `spot_minus_atm`
  (`sig_oi.oi_change_view` now returns `putShare`, `atm`). Order Flow chart axis in IST. Paper Trading page: a filled
  stop shows its fill time with "placed hh:mm:ss" (journal `orders()` returns `placedAt`); Trades tab has Buy time,
  Sell time, Time in trade (`heldFor`).
- Earlier dashboard layout (23-Oct), top to bottom: top bar (index, expiry, interval, "Exit by 3:15 PM · N min left" chip, India VIX chip
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
  chain OI). Backtest page in the app (last in the sidebar, below Paper Trading): strategy chips (one ticked = a card with its indicators, checklist and trade rules, `config/strategyInfo.ts`), totals, profit curve (series tokens
  --series-1..4), year / month tables, exits, trades + CSV, Run button (after market hours). Also `Run_Backtest.bat`.
- Names and indices (owner 25-Oct-2026, ADR 0007): **4 Pillar Rules**, **SuperTrend Rules** (MegaBull account),
  **Dharani Rules**, **Trend Rules** (app accounts). All four run on NIFTY and BANKNIFTY from 26-Oct: rule ids
  `fourPillar` and `superTrend` (each its own slot per index) replace the single `megabull` rule (kept as a slot for
  old trades). Dashboard: four rule cards (+ order flow). Snapshot CSV: new `st_*` columns for SuperTrend Rules
  (`mb_*` = 4 Pillar Rules). Backtest: every strategy on both indices, Trend Rules added as approximate (Trending OI
  from past option OI of ATM±10, counted from 09:15); the download is now ATM±10 with OI (~10,000 pieces, 2–3 hours
  the first time). Backtest page: one chip per strategy + Index filter.
- Market closed (owner 25-Oct-2026): Trending OI shows the last recorded session (`store.last_day`,
  `Tracker.last_session`, meta.sessionDay) instead of an empty table; Index Components on Saturday / Sunday compares the
  last session with the one before it (was 0.00 %; weekend cache key `<date>-wkd`). Holidays on weekdays still show 0.00 %.
- Paper Trading journal + Option Chain (owner 25-Oct-2026, ADR 0008):
  - **Option Chain** page (`apps/paper-trade`, route /option-chain, was "Paper Trading"): the chain with live LTP / OI,
    plus OI change, volume, IV, delta, gamma, theta, vega from Dhan's option chain (/api/option-chain, every 15 s in
    market hours; columns toggle "OI + volume" / "IV + Greeks"), PCR and max pain tiles; shows the last session's
    chain when the market is closed. Manual buy / sell, positions, orders and P&L of the manual account as before.
  - **Paper Trading** page (`apps/paper-journal`, route /paper-trade): all strategies in one place (4 Pillar Rules,
    SuperTrend Rules, Dharani Rules, Trend Rules, Manual): order book of any past day, trades, open positions, daily
    P&L calendar, strategies side by side, CSV. Strategy chips + Index filter + Date.
  - Backend `journal.py`: the auto trader's on_order steps (entry, stop placed, exit) become order rows in
    `data/journal/day_<date>.json` (MegaBull keeps only today's orders, so the app keeps its own); manual orders and
    round trips come from the paper store. `data/journal/imported.json` = 1-23 Oct 2026 trades from the Excel tabs
    (made once by Claude; 19 trades: 4 Pillar 10, SuperTrend 6, Trend 3; totals match the Consolidated sheet).
    Endpoints GET /api/journal/days, /api/journal/orders?date=, /api/journal/trades?from=&to=.
  - Limits: open positions show without live P&L here (live P&L stays on the Dashboard); Excel-imported trades have
    one buy and one sell order each (the stop orders of those days were not recorded).
- Owner review 25-Oct-2026 evening: Option Chain laid out like Dhan's Advanced Option Chain (one wide table, per side
  Vega, Theta, Gamma, Delta, IV, Volume, OI Chg (and %), OI, LTP Chg (and %), LTP; strike + strike PCR in the
  middle; positions and open orders below; header: spot, ATM IV, days to expiry + lot, PCR + max pain, manual day P&L).
  Backtest: profit curve green above ₹0 / red below (baseline area, thick line), drawdown chart, tiles for yearly
  return on ₹1 lakh (1 lot, not reinvested), profit factor, payoff, average a month / a trade; "What costs do to the
  result" table; month cells show the amount in thousands.
- MegaBull test order PASSED 26-Oct-2026 09:45 (buy, SL placed, SL cancelled, sell; NIFTY 22450 CE, +₹234 paper).
  Confirmed: /api/order/my = {"open": [...], "executed": [...]} with id / status / price; bulk cancel body = a plain list
  of numeric ids. `autopaper.json` megabull.enabled = true: 4 Pillar Rules and SuperTrend Rules now send MegaBull orders.
- Trade alerts (owner 26-Oct-2026): top-bar button "Trade alerts on/off" (`shared/ui/TradeAlerts.tsx`, logic
  `shared/live/tradeAlerts.ts`): every 15 s reads today's trades from /api/journal/trades; a new entry or exit plays two
  short tones, shows a desktop pop-up (after the browser's permission) and a corner note for 20 s. Any page, also in a
  background tab (the browser may slow background checks to about once a minute). Sound starts after the first click.
- A GO the account cannot take (MegaBull still off, Auto OFF, a limit) now goes to the shadow log as "GO, not sent", so
  MegaBull rule results are tracked before MegaBull orders are switched on.

- Trend Rules skips expiry day and the day before (owner 26-Oct-2026, from the backtest below): `sig_market.expiry_phase`
  (`holidays.next_trading_day`) sets `state["expiryPhase"]`; `sig_rules.TH_SKIP_EXPIRY` (autopaper.json "rules"
  `trendSkipExpiryDays`) turns it into a gate, and `sig_service.skipped_setup` shadows a Grade A/B setup blocked only by
  it, so those days keep being tracked. 4 Pillar, SuperTrend and Dharani are unchanged.
- Backtest tests (owner 26-Oct-2026, `docs/backtest.md` "Stop / target and expiry test", "New strategy search"):
  `bt_variants.py` (4 stop / target pairs x expiry handling for Trend, 4 Pillar, SuperTrend; expiry days read from the
  straddle roll in the data) and `strategy_research.py` + `research_data.py` (6 new buying ideas tuned on 2021-24, tested
  once on 2025-26). Run both with `Run_Strategy_Research.bat` (no Dhan login; uses the saved data). Result 26-Oct: no
  pair or expiry rule makes the three rules profitable (best: Trend -20/+30 skipping expiry day + eve, -Rs 2.28 L over
  5 years); none of the new ideas survived 2025-26 (0 of 61). No live rule changed. `backtest.py` functions take optional
  `stop`, `target`, `day_rule`, `toi_cache` (defaults = the live behaviour).

## Watch list (owner, 26-Oct-2026: check regularly, every after-close review)
- **Rebound Call (BankNifty, paper, owner approved 27-Oct-2026)**: new rule `sig_rebound.py` on its own Rs 1 L book
  `rebound` (config `autopaper.json` reboundCall; spec `docs/strategies/rebound-call.md`). Log it daily in the Excel tab
  "Option Buy - Rebound Call" and review with the rest on 15-Nov-2026.
- **Excel tracker, every sheet, every trading day**: follow `docs/excel-daily-checklist.md` (the MegaBull P&L calendar
  is hand-filled and was missed once on 26-Oct). The Excel is the record for the 15-Nov-2026 review.
- **Dhan OI verdict vs the OI itself.** 26-Oct 12:30 Nifty: PCR (OI + chg) 1.24 and puts ~55% (bullish lean), Trending
  OI +57%, Sensibull bullish, yet the Dhan OI & OI Change verdict was Bearish: the final average (equal-weight mean of
  ATM ±5..±25 windows, centred on the ATM strike 22,600) came out 22,577 while spot was 22,620, i.e. driven by spot
  sitting 20 pts above the ATM strike, not by bearish OI. Arithmetic checked and correct; the formula is the owner's
  Excel method and Trend Rules' must-have uses it, so it is NOT changed. Each day after close: count the 5-min candles
  where the Dhan verdict disagrees with the OI lean / Trending OI, how many Trend GOs it blocked, and what price did
  next. Planned: snapshot columns for the OI lean (put %) and spot minus ATM strike; the new dashboard shows the lean
  next to the verdict. A weighted variant is tested in the backtest only if the blocks keep costing good trades.
- 26-Oct result: Nifty verdict Bearish on 71 of 74 candles while the lean was bullish on 66; it alone blocked 6 Trend
  calls (shadow: 2 target, 3 stop, 1 neither, about -5% of premium), so no cost today. Bank Nifty agreed on 70 of 74.
  No Dext numbers typed on 26-Oct (nothing to compare); the estimated Nifty cumulative delta jumped -38K -> -620K at
  12:45 in one candle (check `orderflow.py` if it repeats).

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
Strategy engine for ORB, live orders, Alembic migrations. (Paper trading, the two rules and their strategy docs exist now.)

## Known limits
- Paste-based apps depend on NSE's browser session (empty JSON when it has expired).
- Backend: minutes while it is down are not recorded; Dhan tokens expire about daily.
