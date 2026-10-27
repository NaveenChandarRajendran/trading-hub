"""Login, sessions and the failed-login limit (auth.py, auth_api.py) with the real Auth + AuthMiddleware, and the rule
that EVERY route and WebSocket answers 401 / close 4401 without a session (routes are listed from the app itself, so a
route added later is covered without touching this file)."""
import re
import shutil
import tempfile
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auth import COOKIE, FAIL_WINDOW, PUBLIC_PATHS, Auth, LoginRefused, MemoryAuthStore, token_hash
from main import create_app
from paper_api import PaperService
from scalper_service import ScalperService
from store import PaperJsonStore
from test_api import FakeClient
from test_paper_api import Clock, FakeFeed, FakeInstruments
from tracker import Tracker

PW = "correct horse 1"


class UtcClock:
    def __init__(self):
        self.now = datetime(2026, 10, 28, 4, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.now


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock, feed = Clock(), FakeFeed()
    store = PaperJsonStore(tmp)
    paper = PaperService(store, feed, FakeInstruments(), clock=clock)
    scalper = ScalperService(store, paper, paper.instruments, clock=clock, intraday=lambda *a: {})
    ac = UtcClock()
    auth = Auth(MemoryAuthStore(), clock=ac)
    auth.create_user("naveen", "Naveen", PW)
    auth.create_user("wife", "Wife", "another pass 2")
    ui = tempfile.mkdtemp()
    with open(f"{ui}/index.html", "w") as f:
        f.write("<!doctype html><title>Trading Hub</title>")
    app = create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=paper, scalper=scalper, algo_mode="signals",
                     auth=auth, ui_dir=ui)
    yield app, auth, ac
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(ui, ignore_errors=True)


def login(c, username="naveen", password=PW):
    return c.post("/api/auth/login", json={"username": username, "password": password})


# ---------- login ----------
def test_login_sets_httponly_lax_cookie_and_me_returns_the_user(env):
    app, auth, _ = env
    c = TestClient(app)
    r = login(c, " Naveen ")  # case and spaces don't matter
    assert r.status_code == 200 and r.json()["user"] == {"id": 1, "username": "naveen", "displayName": "Naveen"}
    cookie = r.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE}=") and "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert f"Max-Age={30 * 86400}" in cookie and "Secure" not in cookie  # plain http on 127.0.0.1
    assert c.get("/api/auth/me").json()["user"]["username"] == "naveen"
    token = c.cookies.get(COOKIE)
    assert token not in auth.store.sessions and token_hash(token) in auth.store.sessions  # only the hash is stored


def test_cookie_is_secure_over_https(env):
    app, _, _ = env
    r = login(TestClient(app, base_url="https://testserver"))
    assert r.status_code == 200 and "Secure" in r.headers["set-cookie"]


@pytest.mark.parametrize("username,password", [("naveen", "wrong"), ("nobody", PW), ("", "")])
def test_wrong_username_or_password_is_one_message(env, username, password):
    r = login(TestClient(env[0]), username, password)
    assert r.status_code == 401 and r.json()["detail"] == "Wrong username or password."
    assert "set-cookie" not in r.headers


def test_inactive_user_and_user_without_password_cannot_log_in(env):
    app, auth, _ = env
    auth.create_user("nopw", "No password")
    assert login(TestClient(app), "nopw", "").status_code == 401
    c = TestClient(app)
    assert login(c).status_code == 200
    auth.set_active("naveen", False)  # deactivate also ends open sessions
    assert c.get("/api/auth/me").status_code == 401
    assert login(TestClient(app)).status_code == 401


def test_password_reset_logs_out_every_browser(env):
    app, auth, _ = env
    c = TestClient(app)
    login(c)
    auth.set_password("naveen", "a new password")
    assert c.get("/api/auth/me").status_code == 401
    assert login(TestClient(app)).status_code == 401
    assert login(TestClient(app), password="a new password").status_code == 200
    with pytest.raises(ValueError):
        auth.set_password("naveen", "short")


# ---------- failed-login limit ----------
def test_five_failures_per_username_block_even_the_right_password(env):
    app, _, ac = env
    c = TestClient(app)
    for _ in range(5):
        assert login(c, password="nope").status_code == 401
    r = login(c)
    assert r.status_code == 429 and r.json()["detail"] == "Too many attempts. Try again in 15 min."
    assert int(r.headers["retry-after"]) == 15 * 60
    ac.now += timedelta(minutes=10)
    assert login(c).json()["detail"] == "Too many attempts. Try again in 5 min."
    ac.now += FAIL_WINDOW  # the failures are older than 15 minutes
    assert login(c).status_code == 200


def test_five_failures_from_one_ip_block_other_usernames_too(env):
    app, _, _ = env
    c = TestClient(app)
    for name in ("a", "b", "c", "d", "e"):
        login(c, name, "x")
    assert login(c, "wife", "another pass 2").status_code == 429


def test_success_clears_the_username_count(env):
    app, auth, _ = env
    def fail(ip):
        with pytest.raises(LoginRefused) as e:
            auth.login("naveen", "nope", ip)
        assert e.value.status == 401
    for ip in ("1.1.1.1", "1.1.1.2", "1.1.1.3", "1.1.1.4"):
        fail(ip)
    auth.login("naveen", PW, "2.2.2.2")
    for ip in ("4.4.4.4", "5.5.5.5", "6.6.6.6", "7.7.7.7"):
        fail(ip)
    assert auth.login("naveen", PW, "8.8.8.8")[0].username == "naveen"  # 4 failures since the success: not blocked


# ---------- sessions ----------
def test_session_expires_after_30_days_without_use(env):
    app, _, ac = env
    c = TestClient(app)
    login(c)
    ac.now += timedelta(days=30, seconds=1)
    r = c.get("/api/auth/me")
    assert r.status_code == 401 and r.json() == {"detail": "Log in first.", "login": True}


def test_using_the_session_extends_it_and_resends_the_cookie(env):
    app, _, ac = env
    c = TestClient(app)
    login(c)
    ac.now += timedelta(minutes=30)
    assert "set-cookie" not in c.get("/api/auth/me").headers  # at most once an hour
    ac.now += timedelta(days=20)
    r = c.get("/api/auth/me")
    assert r.status_code == 200 and "Max-Age=2592000" in r.headers["set-cookie"]
    ac.now += timedelta(days=25)  # 45 days after login, 25 after the last use
    assert c.get("/api/auth/me").status_code == 200


def test_logout_ends_the_session_for_good(env):
    app, _, _ = env
    c = TestClient(app)
    login(c)
    token = c.cookies.get(COOKIE)
    r = c.post("/api/auth/logout")
    assert r.status_code == 200 and "Max-Age=0" in r.headers["set-cookie"]
    stolen = TestClient(app, cookies={COOKIE: token})  # the old token is dead, not just forgotten by the browser
    assert stolen.get("/api/auth/me").status_code == 401


# ---------- every route ----------
def _concrete(path):
    return re.sub(r"\{[^}]+\}", "1", path)


def test_every_http_route_needs_a_session(env):
    app, _, _ = env
    c = TestClient(app)
    checked = 0
    for r in app.routes:
        if not isinstance(r, APIRoute) or r.path in PUBLIC_PATHS:
            continue
        for m in r.methods:
            res = c.request(m, _concrete(r.path))
            assert res.status_code == 401 and res.json().get("login") is True, (m, r.path, res.status_code)
            checked += 1
    assert checked > 45  # paper, scalper, algo, dashboard, sr, market data ...
    for path in ("/docs", "/openapi.json", "/api/does-not-exist"):
        assert c.get(path).status_code == 401


def test_every_websocket_is_closed_with_4401_without_a_session(env):
    app, _, _ = env
    paths = [r.path for r in app.routes if isinstance(r, APIWebSocketRoute)]
    assert {"/ws/paper", "/ws/scalper"} <= set(paths)
    for p in paths:
        with pytest.raises(WebSocketDisconnect) as e:
            with TestClient(app).websocket_connect(p) as ws:
                ws.receive_text()
        assert e.value.code == 4401


def test_websocket_opens_with_a_session(env):
    app, _, _ = env
    c = TestClient(app)
    login(c)
    with c.websocket_connect("/ws/scalper") as ws:
        assert ws.receive_json()["type"]


def test_only_login_and_the_ui_page_are_open(env):
    app, _, _ = env
    c = TestClient(app)
    assert "Trading Hub" in c.get("/").text
    assert c.post("/api/auth/login", json={}).status_code == 401  # reachable (wrong password), not "log in first"


def test_secrets_never_reach_the_browser(env):
    app, _, _ = env
    c = TestClient(app)
    login(c)
    body = c.get("/api/status").text + c.get("/api/auth/me").text
    for secret in ("y" * 30, "postgresql://", "password_hash", "argon2"):
        assert secret not in body


# ---------- Postgres store (th_ tables) ----------
def test_postgres_store_login_limit_and_sessions():
    """Same flow on AuthPgStore. Needs TEST_DATABASE_URL (a throwaway database: it TRUNCATEs the th_ login tables)."""
    import os
    dsn = os.getenv("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("set TEST_DATABASE_URL to run the Postgres auth store test")
    from auth import AuthPgStore
    from store import PgStore
    pg = PgStore(dsn)
    try:
        with pg._cursor() as cur:
            cur.execute("TRUNCATE th_sessions, th_login_attempts, th_users RESTART IDENTITY CASCADE")
        ac = UtcClock()
        auth = Auth(AuthPgStore(pg), clock=ac)
        auth.create_user("Naveen", "Naveen", PW)
        with pytest.raises(ValueError):
            auth.create_user("naveen", "Again")
        user, token = auth.login("naveen", PW, "1.1.1.1", "pytest")
        assert user.username == "naveen" and auth.session_user(token) == (user, False)
        ac.now += timedelta(hours=2)
        assert auth.session_user(token) == (user, True)  # extended
        auth.logout(token)
        assert auth.session_user(token) == (None, False)
        for _ in range(5):
            with pytest.raises(LoginRefused):
                auth.login("naveen", "nope", "1.1.1.1")
        with pytest.raises(LoginRefused) as e:
            auth.login("naveen", PW, "9.9.9.9")
        assert e.value.status == 429
        ac.now += FAIL_WINDOW
        _, token = auth.login("naveen", PW, "9.9.9.9")
        ac.now += timedelta(days=31)
        assert auth.session_user(token) == (None, False)
        with pg._cursor() as cur:
            cur.execute("SELECT count(*) FROM th_sessions")
            assert cur.fetchone()[0] == 0  # expired row removed
    finally:
        pg.close()


def test_create_user_script(capsys):
    """scripts/create_user.py on the test database: create, duplicate refused, reset, deactivate, list."""
    import os
    import sys
    dsn = os.getenv("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("set TEST_DATABASE_URL to run the create_user script test")
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
    import create_user
    from auth import AuthPgStore
    from store import PgStore
    pg = PgStore(dsn)
    try:
        with pg._cursor() as cur:
            cur.execute("TRUNCATE th_sessions, th_login_attempts, th_users RESTART IDENTITY CASCADE")
            cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen')")  # as the migration
        run = lambda *argv, pw=PW: create_user.main(list(argv), password_prompt=lambda: pw, dsn=dsn)  # noqa: E731
        run("--username", "naveen", "--name", "Naveen")  # no password yet -> sets it
        run("--username", "wife", "--name", "Wife", pw="another pass 2")
        with pytest.raises(SystemExit, match="already exists"):
            run("--username", "wife")
        auth = Auth(AuthPgStore(pg))
        assert auth.login("naveen", PW)[0].display_name == "Naveen"
        run("--username", "wife", "--reset-password", pw="third pass 33")
        assert auth.login("wife", "third pass 33")[0].username == "wife"
        run("--username", "wife", "--deactivate")
        with pytest.raises(LoginRefused):
            auth.login("wife", "third pass 33")
        capsys.readouterr()
        run("--list")
        out = capsys.readouterr().out
        assert "naveen" in out and "inactive" in out and "argon2" not in out
    finally:
        pg.close()
