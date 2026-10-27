# Users and strategies

Branch `feature/users-strategies` (from `naveen-dev`), ADR 0008. Built in steps; this page grows with them.

| Step | What | State |
|---|---|---|
| 1 | Users, sessions, login page, every route behind a session | done 28-Oct |
| 2 | Strategies + data model + migration of the existing data (backup first) | next |
| 3 | Paper engine, WebSocket events and the algo per strategy | |
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

## Data model
```
th_users           id, username UNIQUE (lower case), display_name, password_hash (argon2id | NULL), created_at, active
th_sessions        token_hash PK (sha256 of the cookie token), user_id, created_at, last_seen_at, expires_at, ip, user_agent
th_login_attempts  username, ip, at, ok            (rows older than a day are deleted)
```
All tables are prefixed `th_`: the shared `algo_trading` database also holds another project's tables (it has its own
`strategies` and `trades`). Strategies (`th_strategies`, `strategy_id` on the paper / algo tables) arrive in step 2.

## Security rules
- Every route and WebSocket needs a session (`auth.AuthMiddleware`, default deny). Open: `POST /api/auth/login` and
  the UI page `/`. Without a session: HTTP 401 `{"login": true}`, WebSocket close 4401; the UI shows the login page.
- The Dhan token and DATABASE_URL never leave the server.
- Cookie: `th_session`, HttpOnly, SameSite=Lax, Secure when the request came over HTTPS (behind nginx, pass
  `X-Forwarded-Proto`; uvicorn trusts forwarded headers from 127.0.0.1).
