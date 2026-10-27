# Trading Hub backend

**Start:** `python main.py` in this folder, then open **http://127.0.0.1:8000** and log in.
The backend serves the built UI (`frontend/dist`, made by `npm run build` in `frontend/`) and every API; everything
except the login needs a session (ADR 0008). Users (no sign-up page):

    python scripts/create_user.py --username naveen --name "Naveen"     (asks for the password)
    python scripts/create_user.py --username naveen --reset-password
    python scripts/create_user.py --username naveen --deactivate
    python scripts/create_user.py --list

Polls Dhan's option chain once a minute and serves OI Pulse-style Trending OI rows to the React page.
Every snapshot is saved in **Postgres**, so closing the backend, shutting the PC down or refreshing the page never loses rows.

## Setup (Windows Command Prompt, in this folder)
    pip install -r requirements.txt
    set DHAN_CLIENT_ID=your_client_id
    set DHAN_ACCESS_TOKEN=your_token
    set DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/algo_trading
    python main.py

- The tables (`toi_session`, `toi_snapshot`, see `schema.sql`) are created automatically on the first start.
  They are prefixed `toi_`, so they can share a database with your other tables (`candles`, `option_oi`, ...).
- If `DATABASE_URL` is not set the backend falls back to JSON files in `data/` and prints a warning.
  If it IS set but Postgres cannot be reached, the backend refuses to start (it never silently falls back).
- Do not use `--force` on normal days. It makes the backend record outside market hours (testing only).

Options: `--strikes 7` (7 each side of ATM = 15 strikes), `--track NIFTY,BANKNIFTY`, `--port 8000`.

Checks in a browser (after logging in): http://127.0.0.1:8000/api/status (shows `"storage": "postgres"`) and
http://127.0.0.1:8000/api/trending-oi?symbol=BANKNIFTY&interval=5

Token expired (HTTP 401 / DH-901)? Send a new one without restarting:

    curl -X POST http://127.0.0.1:8000/api/token -H "Content-Type: application/json" -d "{\"accessToken\":\"NEW_TOKEN\"}"

## Tests
    python -m pytest -q                      (the Postgres tests are skipped)
    set TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/some_throwaway_db
    python -m pytest -q                      (also runs the Postgres tests; they TRUNCATE the toi_ tables)

## How it works
- Every minute at hh:mm:03 it fetches the chain for each tracked (symbol, expiry), stores one snapshot, and writes it to Postgres.
  5 / 15 min views are just filters of those snapshots (rows at 09:20, 09:25 ... and 09:30, 09:45 ...).
- Strikes = ATM +/- N, fixed from the first snapshot of the day and saved in `toi_session`.
- Change in OI = oi - previous_oi (Dhan's settled previous-day OI), summed over the fixed strikes. Units, not lots
  (NSE's chain shows lots: NSE lots x lot size 30 for BANKNIFTY = these numbers; verified against OI Pulse for 16-Oct).
- After a restart the backend reloads today's rows from Postgres and resumes tracking whatever was tracked earlier
  today, with no need to open the page. The strike set and all earlier rows stay exactly as they were.
- If a Postgres write fails, the row stays in memory, the page shows "Database write failed, will retry", and the
  row is saved on the next successful poll.
- Holidays: `holidays.py` lists NSE weekday holidays; the backend records nothing on them.

## Known limits
1. **Minutes while the backend is not running are not recorded.** After a restart the table continues from the
   restart time and the earlier rows are there, but the minutes in between are missing. Recording is done by the
   backend, not by the page, so keep ONE backend running all session on an always-on machine; the page can then
   be opened or closed by anyone.
2. Dhan access tokens expire about every 24 hours; a new one is needed each morning before 09:15.
3. Please verify against a live screen: the LTP columns, the Day H/L Break levels (computed from index spot of the
   stored rows only), and strength when call and put changes have opposite signs.

## Index components (stock prices) - `GET /api/quotes`
    http://127.0.0.1:8000/api/quotes?symbols=HDFCBANK,ICICIBANK,TCS

Returns the live last price (`ltp`) for NSE stocks, plus the Dhan security IDs it found (`ids`) and any symbols it could not match (`unknown`).
- Symbols -> Dhan security IDs come from Dhan's instrument CSV, downloaded automatically once a day
  (cache: `data/security_ids.json`; the last cache is used if the file cannot be downloaded).
- Prices use Dhan's market-quote OHLC call (1 request / second). Requests within 2 seconds share one Dhan call.
- 401 = token expired (POST a new one to /api/token). Only `last_price` is used: after market hours Dhan's
  `ohlc.close` / `net_change` equal today's close, so they cannot give a daily change.

## Previous close - `GET /api/history?symbol=HDFCBANK`
Daily candles (`timestamp` = epoch seconds at 00:00 IST, `close`) for the last 10 days, from Dhan's
`/charts/historical` (one request per stock, 0.25 s apart). The page picks the last candle dated before today (IST)
as the previous close. Results are cached per stock per IST day; failures are not cached.
