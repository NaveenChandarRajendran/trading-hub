# Users and strategies

Branch `feature/users-strategies` (from `naveen-dev`), ADR 0008. Built in steps; this page grows with them.

| Step | What | State |
|---|---|---|
| 1 | Users, sessions, login page, every route behind a session | done 28-Oct |
| 2 | Strategies + data model (fresh start instead of a data migration) | done 28-Oct |
| 3 | Paper engine, WebSocket events and the algo per strategy | done 28-Oct |

| 4 | "Trading into" selector in Paper Trading and Power Scalper | next |
| 5 | Strategies home + strategy view | |
| 6 | Compare | |

## Users (step 1)
There is no sign-up page. In `backend/` (DATABASE_URL from `backend/.env.local`):

    python scripts/create_user.py --username naveen --name "Naveen"     create; asks for the password twice
    python scripts/create_user.py --username naveen --reset-password     new password; logs out every browser
    python scripts/create_user.py --username wife --deactivate           can't log in; open sessions end
    python scripts/create_user.py --username wife --activate
    python scripts/create_user.py --list

- Usernames are lower case (letters, digits, `.`, `-`, `_`). Passwords: 8+ characters, typed at the prompt, stored
  as argon2id hashes. A user without a password (as the data migration will create `naveen`) can't log in until
  `create_user.py --username naveen` sets one.
- Open http://127.0.0.1:8000, log in; the top bar shows the name and **Log out**. Each Chrome profile has its own
  cookie, so two people on one laptop stay apart.
- Session: 30 days, extended while used. Logout ends it on the server too.
- 5 wrong passwords within 15 minutes (per username, and per IP) → "Too many attempts. Try again in N min."

## Strategies (step 2)
API (`strategies_api.py`, rules in `strategies.py`), always the signed-in user's own strategies:

    GET   /api/strategies?archived=false         POST /api/strategies {name, description?, capital?}
    GET   /api/strategies/{id}                   PATCH /api/strategies/{id} {name?, description?, notes?}
    PUT   /api/strategies/{id}/capital {capital} POST /api/strategies/{id}/reset {capital?}
    POST  /api/strategies/{id}/archive           POST /api/strategies/{id}/unarchive

- Someone else's strategy answers **404 "Strategy not found."**, exactly like an id that doesn't exist.
- Names 1-60 characters, unique per user ignoring case (archived ones count). Two users may both have "EMA".
- Capital ₹10,000 – ₹10 crore, default ₹1,00,000. **Set capital** changes the open period's starting capital; **Reset
  capital** closes the period and opens a new one: the old orders, trades and P&L stay with the old period. Both, and
  **Archive**, need a flat book today (no open position, no pending order).
- Archived = read-only (still readable, listed under `?archived=true`) until unarchived. No hard delete.
- Algo strategies (kind `algo`): the owner can edit name / description / notes; capital, reset and archive are refused.

## Data model
```
th_users           id, username UNIQUE (lower case), display_name, password_hash (argon2id | NULL), created_at, active
th_sessions        token_hash PK (sha256 of the cookie token), user_id, created_at, last_seen_at, expires_at, ip, user_agent
th_login_attempts  username, ip, at, ok            (rows older than a day are deleted)
th_strategies      id, user_id, name (unique per user, any case), description, notes (markdown), capital,
                   kind ('manual' | 'algo'), created_at, updated_at, archived_at
th_user_prefs      user_id, key, value              (e.g. the "Trading into" choice per tool, step 4)
pt_accounts        + strategy_id: one row = one capital period of a strategy (the open one has archived_at NULL)
pt_orders, pt_trades, pt_positions, pt_order_levels, scalper_daily_summary   + strategy_id (from the account)
algo_events, algo_state, algo_daily_summary                                  + strategy_id ("OI Breakout Algo")
pt_daily_summary   strategy_id, account_id, trade_date, trades, wins, losses, fills, realized, charges, net, best/worst
```
A user owns strategies; everything else reaches the user through `strategy_id`. All new tables are prefixed `th_`: the
shared `algo_trading` database also holds another project's tables (it has its own `strategies` and `trades`).

## First start (no data migration)
Naveen chose a fresh start on 28-Oct-2026: the old paper / algo trade records were deleted on 27-Oct after a backup
(`backend/backups/trading-hub-2026-10-27.sql`); market recordings (candles, chain snapshots, Trending OI, levels)
were kept. On every start `strategies.bootstrap` makes sure that:
- user `naveen` exists (no password until `python scripts/create_user.py --username naveen` sets one; the backend
  log says so);
- the algo's strategy "OI Breakout Algo" (kind `algo`, owner naveen) exists with its `Algo` paper account;
- paper accounts without a strategy (made by the code before users existed) are removed when empty; one with orders
  or fills stops the start, nothing deleted.
Running it again changes nothing. Manual strategies are created by each user in the app.

## One engine per strategy (step 3)
- `paper_api.PaperService` keeps one `Book` per manual strategy (its open capital period + `PaperEngine`). Paper
  Trading and Power Scalper both trade through it: one set of funds, positions, OCO legs and one 15:15 square-off per
  strategy whichever screen placed the order (`pt_orders.source` says which: manual / scalper). Every active manual
  strategy is loaded at start, so stops and the square-off run after a restart. 15:35: `pt_daily_summary` row of every
  strategy with fills.
- Routes take `?strategy=<id>` (`/api/paper/*`, `/api/scalper/*`); orders need an active manual strategy of your
  own; someone else's is 404. `/api/paper/pnl|trades?strategy=all` = all of your own strategies.
- WebSockets `/ws/paper?strategy=` and `/ws/scalper?strategy=`: order / trade / position / funds events carry
  `strategyId` and go only to the owner's connections; ticks, candles and volume are shared. `{"type": "strategy",
  "id"}` switches the snapshot.
- The algo trades into "OI Breakout Algo" through its own engine (`AlgoBroker`), whoever is logged in.
  `/api/algo/*` answers only the strategy's owner (404 for anyone else).
- Tests: `test_isolation.py` (every `?strategy=` route listed from the app: user B gets 404 on user A's strategies;
  WebSocket events never reach B; separate engines), `test_scalper.py`, `test_paper_api.py`, `test_algo_service.py`.
