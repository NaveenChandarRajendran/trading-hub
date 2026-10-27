"""
auth.py - users, login sessions and the failed-login limit (ADR 0008). No public sign-up: users are made with
scripts/create_user.py.

- Passwords: argon2id (argon2-cffi). An unknown username still costs one hash check, so timing doesn't tell
  which usernames exist; an inactive user or one without a password gets the same "wrong username or password".
- Sessions: a random token in an HttpOnly, SameSite=Lax cookie; the database keeps only its sha256. 30 days, extended
  when used (at most once an hour, so a busy page doesn't write on every request). Logout deletes the row.
- Failed logins: 5 within 15 minutes per username, and separately per IP, block further tries until the oldest of
  them is 15 minutes old. A successful login clears that username's count (not the IP's).
- AuthMiddleware guards EVERY path except the login call and the UI page itself: HTTP gets 401 {"login": true}
  (the page then shows the login screen), a WebSocket is closed with code 4401 before it is accepted. The signed-in
  user is put on request.state.user / websocket.state.user.
"""
import hashlib
import json
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

COOKIE = "th_session"
SESSION_DAYS = 30
REFRESH_EVERY = timedelta(hours=1)
MAX_FAILS = 5
FAIL_WINDOW = timedelta(minutes=15)
PUBLIC_PATHS = {"/api/auth/login", "/", "/index.html", "/favicon.ico"}  # everything else needs a session
LOGIN_FIRST = "Log in first."


def utcnow():
    return datetime.now(timezone.utc)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True)
class User:
    id: int
    username: str
    display_name: str
    active: bool = True

    def public(self):
        return {"id": self.id, "username": self.username, "displayName": self.display_name}


class LoginRefused(Exception):
    def __init__(self, status, message, retry_after=None):
        super().__init__(message)
        self.status, self.message, self.retry_after = status, message, retry_after


class Auth:
    def __init__(self, store, clock=utcnow, hasher=None):
        self.store, self.clock = store, clock
        self.hasher = hasher or PasswordHasher()
        self._dummy = self.hasher.hash("timing-only, never a real password")

    # ------------------------------------------------------------------ users (CLI)
    @staticmethod
    def norm(username):
        return (username or "").strip().lower()

    def create_user(self, username, display_name, password=None):
        username = self.norm(username)
        if not username or not username.replace("_", "").replace("-", "").replace(".", "").isalnum():
            raise ValueError("username: letters, digits, '.', '-' or '_' only")
        if self.store.user_by_name(username):
            raise ValueError(f"user {username!r} already exists")
        pw = self.hasher.hash(password) if password else None
        return self.store.add_user(username, display_name.strip() or username, pw, self.clock())

    def set_password(self, username, password):
        user = self._existing(username)
        if len(password) < 8:
            raise ValueError("password must be at least 8 characters")
        self.store.set_password(user.id, self.hasher.hash(password))
        self.store.delete_sessions(user.id)  # a reset logs out every browser

    def set_active(self, username, active):
        user = self._existing(username)
        self.store.set_active(user.id, active)
        if not active:
            self.store.delete_sessions(user.id)

    def _existing(self, username):
        row = self.store.user_by_name(self.norm(username))
        if not row:
            raise ValueError(f"no user {self.norm(username)!r}")
        return row[0]

    # ------------------------------------------------------------------ login
    def _blocked_for(self, attempts, now, reset_on_success=True):
        """Seconds until a try is allowed again, or 0. attempts: [(at, ok)] for one username or IP, oldest first."""
        fails = []
        for at, ok in attempts:
            if ok:
                if reset_on_success:
                    fails = []  # only failures after the user's last success count
            elif now - at < FAIL_WINDOW:
                fails.append(at)
        if len(fails) < MAX_FAILS:
            return 0
        return max(1, int((fails[-MAX_FAILS] + FAIL_WINDOW - now).total_seconds()))

    def login(self, username, password, ip="", user_agent=""):
        """-> (User, token). Raises LoginRefused(401 | 429, message)."""
        now = self.clock()
        username = self.norm(username)
        wait = max(self._blocked_for(self.store.attempts("username", username, now - FAIL_WINDOW), now),
                   self._blocked_for(self.store.attempts("ip", ip, now - FAIL_WINDOW), now, False) if ip else 0)
        if wait:
            mins = -(-wait // 60)
            raise LoginRefused(429, f"Too many attempts. Try again in {mins} min.", wait)
        row = self.store.user_by_name(username) if username else None
        user, pw_hash = row if row else (None, None)
        ok = False
        try:
            ok = self.hasher.verify(pw_hash or self._dummy, password or "") and bool(pw_hash)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            ok = False
        ok = ok and user is not None and user.active
        self.store.add_attempt(username, ip, now, ok)
        if not ok:
            raise LoginRefused(401, "Wrong username or password.")
        if self.hasher.check_needs_rehash(pw_hash):
            self.store.set_password(user.id, self.hasher.hash(password))
        token = secrets.token_urlsafe(32)
        self.store.add_session(user.id, token_hash(token), now, now + timedelta(days=SESSION_DAYS), ip, user_agent[:200])
        return user, token

    def session_user(self, token):
        """-> (User | None, refreshed). Expired or inactive -> None; extends the expiry at most once an hour."""
        if not token:
            return None, False
        now = self.clock()
        hit = self.store.session(token_hash(token))
        if not hit:
            return None, False
        user, expires_at, last_seen = hit
        if expires_at <= now or not user.active:
            self.store.delete_session(token_hash(token))
            return None, False
        if now - last_seen >= REFRESH_EVERY:
            self.store.touch_session(token_hash(token), now, now + timedelta(days=SESSION_DAYS))
            return user, True
        return user, False

    def logout(self, token):
        if token:
            self.store.delete_session(token_hash(token))


def cookie_header(token, secure, max_age=SESSION_DAYS * 86400):
    parts = [f"{COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def cookie_token(scope):
    for k, v in scope.get("headers") or []:
        if k == b"cookie":
            for part in v.decode("latin-1").split(";"):
                name, _, value = part.strip().partition("=")
                if name == COOKIE:
                    return value
    return None


class AuthMiddleware:
    """Pure ASGI: one check in front of every route (also routes added later), so none can forget it."""

    def __init__(self, app, auth):
        self.app, self.auth = app, auth

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or (scope["type"] == "http" and scope["path"] in PUBLIC_PATHS):
            return await self.app(scope, receive, send)
        token = cookie_token(scope)
        user, refreshed = self.auth.session_user(token)
        if user is None:
            if scope["type"] == "websocket":
                await receive()  # websocket.connect
                return await send({"type": "websocket.close", "code": 4401, "reason": LOGIN_FIRST})
            body = json.dumps({"detail": LOGIN_FIRST, "login": True}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                                    (b"cache-control", b"no-store")]})
            return await send({"type": "http.response.body", "body": body})
        scope.setdefault("state", {})["user"] = user
        scope["state"]["session_token"] = token
        if not (refreshed and scope["type"] == "http"):
            return await self.app(scope, receive, send)
        secure = scope.get("scheme") == "https"

        async def send_with_cookie(msg):
            if msg["type"] == "http.response.start":
                msg = {**msg, "headers": [*msg.get("headers", []), (b"set-cookie", cookie_header(token, secure).encode())]}
            await send(msg)
        return await self.app(scope, receive, send_with_cookie)


# ---------------------------------------------------------------------- stores
class MemoryAuthStore:
    """In-memory store for tests (same methods as AuthPgStore)."""

    def __init__(self):
        self.users, self.passwords, self.sessions, self.attempt_rows = {}, {}, {}, []
        self._lock = threading.Lock()

    def add_user(self, username, display_name, pw_hash, now):
        with self._lock:
            uid = len(self.users) + 1
            self.users[uid] = User(uid, username, display_name, True)
            self.passwords[uid] = pw_hash
            return self.users[uid]

    def user_by_name(self, username):
        u = next((u for u in self.users.values() if u.username == username), None)
        return (u, self.passwords[u.id]) if u else None

    def set_password(self, uid, pw_hash):
        self.passwords[uid] = pw_hash

    def set_active(self, uid, active):
        u = self.users[uid]
        self.users[uid] = User(u.id, u.username, u.display_name, active)

    def add_attempt(self, username, ip, at, ok):
        self.attempt_rows.append((username, ip, at, ok))

    def attempts(self, field, value, since):
        i = 0 if field == "username" else 1
        return [(at, ok) for r in self.attempt_rows for at, ok in [(r[2], r[3])] if r[i] == value and at >= since]

    def add_session(self, uid, th, now, expires_at, ip, user_agent):
        self.sessions[th] = [uid, expires_at, now]

    def session(self, th):
        s = self.sessions.get(th)
        return (self.users[s[0]], s[1], s[2]) if s else None

    def touch_session(self, th, now, expires_at):
        if th in self.sessions:
            self.sessions[th][1:] = [expires_at, now]

    def delete_session(self, th):
        self.sessions.pop(th, None)

    def delete_sessions(self, uid):
        for th in [k for k, s in self.sessions.items() if s[0] == uid]:
            del self.sessions[th]


class AuthPgStore:
    """th_users / th_sessions / th_login_attempts (schema.sql) through PgStore's pool."""

    def __init__(self, pg):
        self.pg = pg

    def _user(self, r):
        return User(r[0], r[1], r[2], r[3])

    def add_user(self, username, display_name, pw_hash, now):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO th_users (username, display_name, password_hash, created_at, active) "
                        "VALUES (%s, %s, %s, %s, true) RETURNING id, username, display_name, active",
                        (username, display_name, pw_hash, now))
            return self._user(cur.fetchone())

    def user_by_name(self, username):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, username, display_name, active, password_hash FROM th_users WHERE username=%s",
                        (username,))
            r = cur.fetchone()
            return (self._user(r), r[4]) if r else None

    def set_password(self, uid, pw_hash):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE th_users SET password_hash=%s WHERE id=%s", (pw_hash, uid))

    def set_active(self, uid, active):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE th_users SET active=%s WHERE id=%s", (active, uid))

    def add_attempt(self, username, ip, at, ok):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO th_login_attempts (username, ip, at, ok) VALUES (%s, %s, %s, %s)",
                        (username, ip, at, ok))
            cur.execute("DELETE FROM th_login_attempts WHERE at < %s", (at - timedelta(days=1),))

    def attempts(self, field, value, since):
        col = {"username": "username", "ip": "ip"}[field]
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT at, ok FROM th_login_attempts WHERE {col}=%s AND at >= %s ORDER BY at", (value, since))
            return cur.fetchall()

    def add_session(self, uid, th, now, expires_at, ip, user_agent):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO th_sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, "
                        "user_agent) VALUES (%s, %s, %s, %s, %s, %s, %s)", (th, uid, now, now, expires_at, ip, user_agent))
            cur.execute("DELETE FROM th_sessions WHERE expires_at < %s", (now,))

    def session(self, th):
        with self.pg._cursor() as cur:
            cur.execute("SELECT u.id, u.username, u.display_name, u.active, s.expires_at, s.last_seen_at "
                        "FROM th_sessions s JOIN th_users u ON u.id = s.user_id WHERE s.token_hash=%s", (th,))
            r = cur.fetchone()
            return (self._user(r), r[4], r[5]) if r else None

    def touch_session(self, th, now, expires_at):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE th_sessions SET last_seen_at=%s, expires_at=%s WHERE token_hash=%s", (now, expires_at, th))

    def delete_session(self, th):
        with self.pg._cursor() as cur:
            cur.execute("DELETE FROM th_sessions WHERE token_hash=%s", (th,))

    def delete_sessions(self, uid):
        with self.pg._cursor() as cur:
            cur.execute("DELETE FROM th_sessions WHERE user_id=%s", (uid,))
