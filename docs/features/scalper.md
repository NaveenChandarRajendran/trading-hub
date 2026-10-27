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
3. Trade tab tickets + full strike dropdowns + positions.
4. Chart position lines + draggable TP / SL.
5. Hotkeys + states, both themes.
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
