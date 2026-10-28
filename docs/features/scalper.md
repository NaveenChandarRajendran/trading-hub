# Feature: Power Scalper (paper only)

Status: in progress on `feature/scalper` (from `naveen-dev`), plan approved by Naveen 27-Oct-2026.
A one-screen scalping workspace in the Live (Dhan) group: index + CE + PE charts, one-click tickets, chart position
lines with draggable TP / SL. Every order goes to the paper engine's **"Scalper"** account; there is no code path to
Dhan's order APIs.

## Decisions (27-Oct)
- Base branch `naveen-dev`. Default capital ₹1,00,000 (presets ₹50k / 1L / 2L / 5L + custom).
- OCO (ADR 0007): the pair doesn't block a manual partial sell; both legs follow the open quantity; prices on 0.05.
- Defaults: Follow ATM on; Sell sells the stepper's lots (the engine refuses more than the open qty); 3-minute
  timeframe; Hotkeys off and not remembered.

## Build steps
1. **Done** — Scalper account, OCO, reports, `scalper_daily_summary`, P&L calendar filter Manual / Algo / Scalper / All.
2. **Done** — Layout + three synced charts with live candles: `/ws/scalper` (ticks with day high / low, live
   1-minute candles and per-minute volume for what the page shows, Scalper account events), option history
   `GET /api/scalper/candles` (Dhan 1-minute, today + previous session, cached 60 s), the page (top bar, index chart
   full height + ATM CE / PE charts on one time grid with synced scroll / zoom / crosshair, volume in its own pane,
   Trade panel with Phase 2 tabs disabled, Positions / Orders strip, Reports view with tiles, day-wise table, day
   trades, CSV and capital / fresh start). Shared: `src/shared/chart/candles.ts` (moved from the Dashboard).
3. **Done** — Trade tab: CE and PE tickets with a strike dropdown of every strike of the expiry (opens at the
   selected strike / ATM, ATM and ITM marked, LTP per strike from the shared option-chain cache, type a strike to
   jump, Enter / arrows / Esc), Follow ATM (default on; never switches while that side holds a position or pending
   order; needs spot 10 % of a strike step past the midpoint, so no flipping), lots stepper (max 100), one-click
   MARKET Buy / Sell (no confirmation), best bid / ask with quantities, day range bar, the reason when Buy / Sell is
   off (market closed, stale, token, funds, nothing to sell). Picking a strike switches that side's chart; picking a
   non-ATM strike turns Follow ATM off for that side. Positions box: open positions with live P&L (before charges),
   Exit and Exit all.
4. **Built, live check pending** (orders only 09:15–15:15) — Chart position lines + draggable TP / SL
   (`PositionOverlay.tsx`, `logic/drag.ts`): an open position on its CE / PE chart shows an entry line at the average
   price with a label "65 · +13.00 INR", ✕ (exit at market) and TP / SL handles. Dragging a handle onto the chart
   draws a line that follows the pointer (price rounded to 0.05, label with the price and the P&L there; chart scroll
   / zoom paused, Esc cancels). Dropping it validates (long: TP above LTP, SL below LTP and below TP; invalid drops snap
   back with a message) and places / moves the OCO leg (`PUT /api/scalper/protection`). Existing TP / SL lines have a
   grip on the right to drag them (modify); dropping one back on the position label cancels it. Pixel ↔ price via
   Lightweight Charts' `priceToCoordinate` / `coordinateToPrice`; no new library.
5. **Done** — Hotkeys (toggle in the top bar, off on every load, never remembered): Shift+B buys the CE ticket,
   Shift+S the PE ticket, Shift+X exits all, Esc cancels a chart drag; only while the page has focus and never while
   typing in a field or with Ctrl / Alt / Meta or a held-down repeat; a "?" popover lists them; every hotkey order
   (and refusal) shows a toast. Toasts (shared `src/shared/ui/Toast.tsx`) replace the inline notices. States:
   loading ("Loading candles…"), market closed (last session's charts, Buy / Sell off with the reason), stale feed
   (off, reason), orders closed after 15:15, insufficient funds (reason, engine rejects too), token expired (banner +
   off). Checked in light and dark with live prices.
Fixes (28-Oct): bottom strip collapsed by default (▲ / ▼, drag the top edge to resize, height remembered); strike
dropdown drawn above the page so the Trade panel never scrolls sideways.
Phase 2: Option Chain, Depth, OI Insights tabs.

## Backend (step 1)
`scalper_service.py`, `scalper_api.py`, `scalper_reports.py`; `paper_engine.set_protection`; `pt_orders.oco_group`;
`scalper_daily_summary`. Routes: see the `scalper_api.py` docstring.

## Reports
- A **trade** is a round trip of one instrument: from flat, its buys and sells until flat again.
  pnl = sell value − buy value; net = pnl − the charges of its fills; a win has net > 0.
- Tiles: net P&L, trades, win rate, average win / loss (per trade, net), best / worst day (day net).
- Day net = realized − charges of the day's fills (identical to the Paper Trading P&L calendar).
- After "Reset account" the reports show the new account only; the old one's history stays in the tables.

## Partial exits and trailing stop-loss (28-Oct, Naveen's rules)
- **Partial exit** 25 / 50 / 75 % (100 % = ✕ / Exit): that share of the open lots at market, **rounded down, at least
  1 lot**; when that is every lot it is a full exit. 4 lots: 1 / 2 / 3; 3 lots: 1 / 1 / 2. The OCO TP / SL legs shrink
  to the remaining lots (existing rule). `POST /api/scalper/exit/{id} {pct}`; the button's tooltip shows the lots.
- **Trailing stop** in option **points**: distance (default 10), step (default 1), optional "start after profit" (points
  above the average buy; default: straight away). On: the stop is placed / raised to LTP − distance (down to the 0.05
  tick) unless the start-after profit isn't reached yet (then the existing stop holds; one is required). Then, on every
  tick, highest LTP since on − distance becomes the stop when it is at least one step above the current stop. Only
  ever up. Dragging the SL keeps trailing at the new gap (distance = LTP − new stop). Ends when the stop is cancelled /
  filled or the position closes. Runs in the backend paper engine (works with the page closed), stored on the stop
  order (`pt_orders.trail_*`), so a restart keeps it. `PUT /api/scalper/trail/{id} {distance, step?, after?}`;
  `{distance: null}` = off. Positions carry `trail`.
- Screen: chart position label `qty P&L │ TP SL │ 25% 50% 75% │ Trail │ ✕`; SL grip "SL 173.80 · −582.40 · trail 10";
  the same buttons on each Positions row. Last Trail values remembered in this browser.
