# Users and strategies

Branch `feature/users-strategies` (from `naveen-dev`), ADR 0008. Built in steps; this page grows with them.

| Step | What | State |
|---|---|---|
| 1 | Users, sessions, login page, every route behind a session | done 28-Oct |
| 2 | Strategies + data model + migration of the existing data (backup first) | done 28-Oct (not run on the live DB yet) |
| 3 | Paper engine, WebSocket events and the algo per strategy | next |
| 4 | "Trading into" selector in Paper Trading and Power Scalper | |
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

## Migrating the existing data (once, on the live database)
Stop the backend, then in `backend/`:

    python scripts/migrate_users_strategies.py --dry-run     backup + every check + counts, then rolls back
    python scripts/migrate_users_strategies.py               backup, migrate (one transaction), counts before / after
    python scripts/create_user.py --username naveen          set your password (the migration makes the user without one)

It backs up first (`backups/trading-hub-<date>.sql`), maps the accounts to naveen's strategies (Paper Trading →
"Manual (legacy)", Algo → "OI Breakout Algo" (algo), Scalper → "Scalper"), fills `strategy_id` everywhere, copies the
Scalper daily summary, makes `strategy_id` NOT NULL and checks that each strategy's realized P&L, charges and fills
equal the sum of its accounts' before; any mismatch rolls everything back. A second run changes nothing.
Rehearsed 28-Oct on a copy of the live tables: 13 orders, 13 fills, 5 positions, 2,702 algo events, 18 algo states,
18 algo summaries, 1 Scalper summary kept; Manual (legacy) realized ₹514.00 / charges ₹297.55 / 7 fills, OI Breakout
Algo ₹411.75 / ₹343.81 / 6 fills; every account's P&L calendar identical before and after.
**Run it on the live database only after step 3** (the code writes `strategy_id` everywhere from then on).

## Security rules
- Every route and WebSocket needs a session (`auth.AuthMiddleware`, default deny). Open: `POST /api/auth/login` and
  the UI page `/`. Without a session: HTTP 401 `{"login": true}`, WebSocket close 4401; the UI shows the login page.
- The Dhan token and DATABASE_URL never leave the server.
- Cookie: `th_session`, HttpOnly, SameSite=Lax, Secure when the request came over HTTPS (behind nginx, pass
  `X-Forwarded-Proto`; uvicorn trusts forwarded headers from 127.0.0.1).
