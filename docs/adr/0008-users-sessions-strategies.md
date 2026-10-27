# ADR 0008: Users, login sessions and one origin for the UI and API

Date: 2026-10-28 · Status: accepted (step 1 of "users and strategies"; strategies follow in later steps)

## Context
Naveen and his wife will both use Trading Hub on one laptop (each in their own Chrome profile), and it will later be
exposed through nginx. Every paper trade must belong to a user (through a strategy), so the app needs real logins, and
every route, market data included, must be closed to anyone without a session.

Until now the UI was one self-contained `dist/index.html` meant to be opened by double-click (origin `file://`, or
`localhost:5173` in development) calling the backend at `127.0.0.1:8000` with CORS `*`. A browser never sends a
SameSite=Lax cookie on such cross-site calls, so cookie sessions can't work in that setup.

## Decision
- **One origin.** The backend serves the built UI at `GET /` (http://127.0.0.1:8000); Vite's dev server proxies `/api`
  and `/ws` to the backend. All calls are relative; CORS is removed. The build is still one self-contained file, but
  opened by double-click it only says "Start the backend and open http://127.0.0.1:8000". The whole app, the paste
  apps included, is behind the login. (CLAUDE.md's "keep the build double-click compatible" rule is replaced.)
- **Users** (`th_users`): created with `scripts/create_user.py` only (no sign-up page); argon2id password hashes.
- **Sessions** (`th_sessions`): random token in an HttpOnly, SameSite=Lax cookie (`Secure` over HTTPS, e.g. behind
  nginx with `X-Forwarded-Proto`); only its sha256 is stored. 30 days, extended when used (at most once an hour).
  Logout deletes the row; a password reset or deactivation ends all of that user's sessions.
- **Failed logins** (`th_login_attempts`): 5 within 15 minutes per username, and per IP, block further tries
  ("Too many attempts. Try again in N min.", HTTP 429 + Retry-After).
- **Default deny.** `AuthMiddleware` (pure ASGI) sits in front of every route: only `POST /api/auth/login` and the UI
  page are open. HTTP answers 401 `{"login": true}`; a WebSocket is closed with 4401 before accept. A test lists the
  app's routes, so a route added later can't skip the check. The UI shows the login page on either signal.
- **Table prefix `th_`**: the shared `algo_trading` database already has another project's `strategies` / `trades`.
- The Dhan token and DATABASE_URL stay on the server (never in a response).

## Consequences
- Open the app at http://127.0.0.1:8000 (or `npm run dev` → http://localhost:5173 with the backend running).
- `create_app(..., auth=...)` is required; tests that aren't about login use `authfake.create_app` (always signed in).
- New dependency: `argon2-cffi`.
