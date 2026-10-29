# Trade Window (Live group, paper only)

A plain, chart-free order window modelled on the 1Cliq trade window (Naveen's screenshot, 29-Oct-2026). PAPER ONLY:
orders go through the Power Scalper routes into the strategy picked in "Trading into" (the same pick as Power
Scalper), so funds, positions, OCO legs, the 15:15 square-off and the reports are the strategy's whichever screen
placed the order.

## Decisions (Naveen, 29-Oct-2026)
- **Buy only.** Buy Call / Buy Put; no Sell buttons (no option writing). A position is closed from its row
  (25 / 50 / 75 / 100 %), with Close all (F6) or by its SL / target.
- **Day MTM limit** in ₹ (profit and / or loss) instead of 1Cliq's lock icon.
- **Same strategy as Power Scalper** ("Trading into" pick shared).

## Screen (`frontend/src/apps/trade-window/`)
- Row 1: Trading into, Index, Expiry, Call strike (− select +), Put strike, Lots (− n + and a Qty preset list).
- Row 2: Order type (Market only), Market protection (off / 2 / 5 / 10 / 20 %), Predefined SL and target (tick + points),
  MTM limit (profit, loss, Set), One click (off on every load: each order, Close all and Cancel all ask first), status.
- Three day ranges: CE (left), the index (centre), PE (right): low ─●──▼─ high (● LTP, ▼ previous close), LTP and change.
  Options from their Full packets; the index's low / high / previous close from its 1-minute candles (re-read every
  minute) plus the live LTP.
- Buy Call (with "Need ₹ · qty"), Close all positions / F6, Cancel all orders / F7, Refresh, Buy Put; a Message line.
- Tabs: Positions (net buy / sell qty, MTM after charges and the limit; per row Net qty, Avg, LTP, SL and Target you can
  type, R. / UR. / total P&L before charges, 25 / 50 / 75 / 100 % and Trail, buy / sell qty and price; All / Open only),
  Order book (cancel a pending order), Trade book (today's fills), Funds.
- F6 / F7 work while the page has focus, never while typing in a field.

## Backend
- `POST /api/scalper/orders {securityId, side, lots, sl?, target?, protection?}`:
  - `protection` (%): refused with nothing placed when the depth would fill a BUY above LTP × (1 + % / 100);
  - `sl` / `target` (points, BUY only): once filled, the position's OCO stop / target at fill − sl / fill + target, on the
    0.05 grid, for the whole open quantity (an add moves them to the new fill's levels). If they can't be set the buy
    stands and `attached.error` says why.
- `POST /api/scalper/cancel-all`: cancels every pending order of the strategy (targets and stops too).
- `PUT /api/scalper/mtm-limit {profit?, loss?}` (`backend/mtm_limit.py`, checked every second by the paper timer):
  - day MTM = today's booked − charges + open positions at the live price;
  - at +profit or −loss: every pending order cancelled, every position sold at market, new BUYs refused for the rest
    of that day on every screen of that strategy (even if the limit is changed or MTM comes back);
  - the limit stays set for the next days; stored per strategy in `th_user_prefs` (`mtm_limit:<id>`, `mtm_hit:<id>`),
    so a restart keeps both; `funds.mtm` shows it.

## Tests
`backend/test_trade_window.py` (attach on fill, protection, cancel all, MTM limit: loss / profit, blocked buys, kept
after a restart, back the next day, other strategies untouched); `frontend/src/apps/trade-window/logic/tradeWindow.test.ts`.
Checked in light and dark on a fake-only preview backend (no Dhan token).

## Not built
Sell / option writing, limit and SL entry orders, Holdings and Basket order tabs (the Builder has baskets).
