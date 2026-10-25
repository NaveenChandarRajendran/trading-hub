# Feature: Paper Trading (phase 1)

Status: plan approved by Naveen (20 Oct 2026). Build with the `trading-hub-feature` skill.
Branch: `feature/paper-trade`. Never touches real order endpoints: this is simulation only.

## Scope (phase 1)
- **Option buying only.** NIFTY / BANKNIFTY CE and PE. A SELL order is allowed only to close an
  existing long position, and its quantity can't exceed the open quantity. No short selling, so no margin calculator.
- **Intraday only.** Auto square-off of all open positions at **15:15 IST** at market, using the same fill rules.
  New orders are rejected after 15:15 and outside 09:15–15:30. No carry-forward, no expiry settlement.
- **Order types:** Market, Limit, SL (trigger + limit), SL-M (trigger + market). Modify and cancel pending orders.
  Exit one position (market) or Exit all.
- **Attached SL + target (build last, optional):** on a filled BUY, optionally attach an SL-M sell and
  a limit target sell as an OCO pair. When one fills, the other is cancelled. Exiting the position manually
  cancels both. Skip this step if the rest of phase 1 runs late. It must not block the release.
- **Virtual capital:** presets ₹1L / ₹2L / ₹5L plus a custom amount, persisted. "Reset account" archives the
  old account (history stays queryable) and starts a new one.
- **P&L report:** GitHub-style daily calendar (green/red shades by net P&L), month-wise table, click a day to
  see its trades. CSV export.

## Dhan data (verified against the official SDK, github.com/dhan-oss/DhanHQ-py `marketfeed.py`)
- Live feed: `wss://api-feed.dhan.co?version=2&token=<token>&clientId=<id>&authType=2`.
- Subscribe with a JSON message. RequestCode `15` Ticker, `17` Quote, `21` Full. At most **100 instruments
  per subscribe message** (send batches). RequestCode `12` disconnects. Check the unsubscribe codes in the docs.
- Responses are **little-endian binary**. Byte 0 is the response code: `2` ticker, `4` quote, `5` OI,
  `6` prev close, `7` market status, `8` full, `50` server disconnect.
- **Full packet** (162 bytes): header `<BHBI` (code, length, segment, securityId), then LTP f32, LTQ u16,
  LTT u32, avg price f32, volume, total sell qty, total buy qty, OI, OI day high, OI day low (u32 each),
  open/close/high/low f32, then **5 depth levels × 20 bytes**: bidQty i32, askQty i32, bidOrders i16,
  askOrders i16, bidPrice f32, askPrice f32. Use Full mode for every tradable instrument.
- Option chain REST (existing client, ≥3.1s between calls) supplies strikes and security IDs. Live LTP and
  bid/ask come from the feed only.
- Lot size and security IDs come from the Dhan instrument master, cached per IST day. Never hard-code lot sizes.
- Copy a few real Full packets (raw bytes, base64) into a test fixture during market hours.

## Fill rules (paper_engine.py, pure, no I/O)
- **Market BUY:** walk the ask levels from best to worse until quantity is filled. Average price = VWAP of the levels used.
  Market SELL walks the bids. If the 5 levels can't fill the quantity, fill the remainder at the worst visible
  level and flag the order `slippageCapped`.
- **Limit BUY:** fills when best ask ≤ limit, at the best ask price (price improvement allowed).
  Limit SELL fills when best bid ≥ limit. An LTP touch alone does not fill. This is conservative, because queue position is unknown.
- **SL-M SELL:** triggers when LTP ≤ trigger, then fills as market. **SL SELL:** triggers when LTP ≤ trigger, then rests
  as a limit at its price. The same rules mirror for BUY stop orders (LTP ≥ trigger).
- No partial fills in phase 1, apart from the depth walk above.
- The engine runs on the backend on every tick, so SL orders work while the browser is closed (backend must be running).

## Money
- Quantity in **units** = lots × lot size. The ticket shows both.
- BUY blocks premium × qty + estimated charges. Reject if available funds are insufficient.
- Realized P&L per position = (sell value − buy value) using average prices. Unrealized = (LTP − avg) × open qty.
- Available = capital + realized − charges − blocked funds for open positions and pending BUYs.
- Charges (config in `paper_charges.py`, one place): brokerage ₹20 per executed order; STT 0.1% of sell premium;
  NSE transaction charge on premium (rate from config); SEBI ₹10 per crore; stamp duty 0.003% on buy premium;
  GST 18% on (brokerage + transaction + SEBI). Verify 2–3 trades against Dhan's brokerage calculator and note
  the source in the test.
- Day P&L in the report = realized − charges, bucketed by IST trade date.

## Backend (paper_api.py, registered from create_app)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/paper/account` | get funds / set capital `{capital}` |
| POST | `/api/paper/account/reset` | archive and start new |
| POST | `/api/paper/orders` | `{securityId, side, lots, orderType, price?, triggerPrice?, attach?: {sl, target}}` → `{id, status, qty}` |
| PUT / DELETE | `/api/paper/orders/{id}` | modify / cancel pending |
| GET | `/api/paper/orders?date=` | order book |
| GET | `/api/paper/positions` | open + closed today |
| POST | `/api/paper/positions/{id}/exit`, `/api/paper/positions/exit-all` | market exits |
| GET | `/api/paper/pnl?from=&to=` | `{meta, rows:[{date, realized, charges, net, trades}]}` |
| GET | `/api/paper/trades?date=` | fills for a day |
| WS | `/ws/paper` | events: `tick`, `order`, `position`, `funds`, `status` |

- `meta` carries `asOf`, `marketOpen`, `tokenExpired`, `lastError`, `message`, as the backend conventions require.
- The UI subscribes to the instruments it shows (visible chain strikes). The backend always keeps open positions
  and pending orders subscribed.
- Tables in `schema.sql`, prefix `pt_`: `pt_accounts`, `pt_orders`, `pt_trades` (fills), `pt_positions`.
  Postgres via `store.py`. If DATABASE_URL is unreachable, exit, as the existing rule says.

## Frontend (`src/apps/paper-trade/`)
- Views via `.seg`: **Trade | Orders | P&L**.
- Trade: toolbar (index, expiry, view, status, Settings) → summary strip (spot, Available, Used, Day P&L,
  Open positions) → `.split`: option chain card (hover row shows B/S, ATM row highlighted) | Positions card + Open orders card.
- Order ticket popover: lots → qty, segmented order type, price/trigger fields shown per type, required vs
  available funds, one primary button.
- P&L: FY selector → summary (Net, Charges, Win/Loss days, Best/Worst day) → calendar card (CSV) → month table
  and the selected day's trades.
- Calendar: new shared `src/shared/ui/Heatmap.tsx`. Add tokens `--heat-up-1…4`, `--heat-down-1…4`, `--heat-empty`
  for both themes in `tokens.css`.
- Logic: `ticket.ts` (validation, lots↔qty, buy-only rule), `pnl.ts`, `calendar.ts` (IST days, weeks, months, holidays),
  `feed.ts` (WS client with reconnect and backoff, rAF-throttled updates, about 4 per second per row), `api.ts`.
- States: loading, empty ("No trades yet"), error with last data kept, stale feed, market closed (show last session).

## Files
- Backend: `dhan_feed.py`, `paper_engine.py`, `paper_charges.py`, `paper_api.py`, `dhan_client.py` (instrument master),
  `store.py`, `schema.sql`, tests `test_dhan_feed.py`, `test_paper_engine.py`, `test_paper_api.py`.
- Frontend: app folder above, `src/shared/ui/Heatmap.tsx`, `tokens.css`, `registry.ts` entry.
- New dependency (approved): Python `websockets` for the Dhan feed client.

## Tests
- Engine: depth-walk VWAP, limit not filled on LTP touch, limit filled on ask ≤ limit, SL-M trigger, SL trigger then
  rests, modify/cancel, sell exceeding open qty rejected, insufficient funds rejected, 15:15 square-off, OCO cancel.
- Charges vs Dhan calculator values (source in a comment).
- Feed parser on captured binary fixtures (Full, Ticker, prev close, disconnect).
- Calendar bucketing across month and year boundaries and holidays.
- API tests with a fake feed. Never the real Dhan API.

## Build order
1. `paper_engine.py` + `paper_charges.py` + tests
2. `dhan_feed.py` + fixture tests
3. Store tables + `paper_api.py` + WS + API tests
4. Frontend Trade view, then Orders, then P&L calendar
5. Attached SL/target (optional, last)
6. Verify: pytest, `npm test && npm run build`, `check_ui.py`, both themes, all states. Update `docs/02-current-state.md`.