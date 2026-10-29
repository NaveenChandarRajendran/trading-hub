"""User isolation across the paper / Scalper / algo routes and both WebSockets, with the real login (auth.Auth +
AuthMiddleware). User A (naveen, id 1) owns strategies #1 "SuperTrend" and #3 "OI Breakout Algo" (algo); user B
(wife, id 2) owns #2 "EMA". Every route that takes ?strategy= is listed from the app itself, so a route added later is
covered without touching this file. Runs on the JSON store and, with TEST_DATABASE_URL, on Postgres (it TRUNCATEs
th_users and, by cascade, the strategies and pt_ tables: use a throwaway database)."""
import os
import shutil
import tempfile
import time

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import algo_config as cfg
from algo_service import AlgoService
from auth import Auth, MemoryAuthStore
from main import create_app
from paper_api import PaperService
from scalper_service import ScalperService
from store import PaperJsonStore, PaperPgStore, PgStore
from test_algo_service import Instruments, make_data
from test_api import FakeClient
from test_paper_api import CE, Clock, FakeFeed, FakeInstruments, at, full
from tracker import Tracker

DSN = os.getenv("TEST_DATABASE_URL")
A_ST, B_ST, ALGO_ST = 1, 2, 3
BODIES = {  # minimal valid bodies, so a refusal is about the strategy and never a 422
    ("POST", "/api/paper/orders"): {"securityId": CE, "side": "BUY", "lots": 1, "orderType": "MARKET"},
    ("PUT", "/api/paper/orders/{order_id}"): {"lots": 1},
    ("POST", "/api/paper/account"): {"capital": 200000},
    ("POST", "/api/scalper/orders"): {"securityId": CE, "side": "BUY", "lots": 1},
    ("PUT", "/api/scalper/protection/{security_id}"): {"stop": 90.0},
    ("PUT", "/api/scalper/trail/{security_id}"): {"distance": 10},
    ("PUT", "/api/scalper/mtm-limit"): {"loss": 1000},
    ("POST", "/api/options/basket"): {"legs": [{"securityId": 52175, "side": "S", "lots": 1}]},
    ("PUT", "/api/scalper/account/capital"): {"capital": 200000},
}


@pytest.fixture(params=["json", "postgres"])
def env(request):
    tmp = tempfile.mkdtemp()
    pg = None
    if request.param == "json":
        store = PaperJsonStore(tmp)
    else:
        if not DSN:
            pytest.skip("set TEST_DATABASE_URL to run the Postgres isolation tests")
        pg = PgStore(DSN)
        with pg._cursor() as cur:
            cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users RESTART IDENTITY CASCADE")
            cur.execute("TRUNCATE pt_accounts RESTART IDENTITY CASCADE")
            cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen'), ('wife', 'Wife')")
        store = PaperPgStore(pg)
    clock = Clock()
    clock.now = at("09:30")
    store.create_strategy(1, "SuperTrend", "", 100000, "manual", clock())
    store.create_strategy(2, "EMA", "", 100000, "manual", clock())
    store.create_strategy(1, "OI Breakout Algo", "", cfg.CAPITAL, "algo", clock(), account_name=cfg.ACCOUNT_NAME)
    feed = FakeFeed()
    paper = PaperService(store, feed, FakeInstruments(), clock=clock)
    scalper = ScalperService(store, paper, paper.instruments, clock=clock, intraday=lambda *a: {})
    auth = Auth(MemoryAuthStore())
    auth.create_user("naveen", "Naveen", "password-a1")
    auth.create_user("wife", "Wife", "password-b2")
    app = create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=paper, scalper=scalper, auth=auth)
    algo = AlgoService(store, None, Instruments(), make_data(), clock, mode="paper",
                       log_dir=os.path.join(tmp, "logs"), variant="A", shadows=())
    import algo_api
    algo_api.register(app, algo)
    a, b = TestClient(app), TestClient(app)
    assert a.post("/api/auth/login", json={"username": "naveen", "password": "password-a1"}).status_code == 200
    assert b.post("/api/auth/login", json={"username": "wife", "password": "password-b2"}).status_code == 200
    yield app, a, b, paper, store, clock
    if pg:
        pg.close()
    shutil.rmtree(tmp, ignore_errors=True)


def strategy_routes(app):
    """(method, path) of every route that takes ?strategy=."""
    out = []
    for r in app.routes:
        if isinstance(r, APIRoute) and any(p.name == "strategy" for p in r.dependant.query_params):
            out += [(m, r.path) for m in sorted(r.methods)]
    return out


def concrete(path):
    return path.replace("{order_id}", "PT20261021-0001").replace("{security_id}", str(CE))


def a_state(store, paper):
    acc = paper.books[A_ST].account["id"]
    return (store.orders(acc, "2026-10-21"), store.trades(acc, "2026-10-21"), store.strategy(A_ST),
            [x for x in store.accounts() if x["strategy_id"] == A_ST])


def test_user_b_gets_404_on_every_strategy_route_for_user_a(env):
    app, a, b, paper, store, clock = env
    paper.on_packet(full(CE, 100, 99.95, 100))
    assert a.post(f"/api/paper/orders?strategy={A_ST}", json=BODIES[("POST", "/api/paper/orders")]).status_code == 200
    before = a_state(store, paper)
    routes = strategy_routes(app)
    assert len(routes) >= 20 and ("POST", "/api/scalper/orders") in routes and ("GET", "/api/paper/pnl") in routes
    for target in (A_ST, ALGO_ST):
        for method, path in routes:
            r = b.request(method, f"{concrete(path)}?strategy={target}", json=BODIES.get((method, path)))
            assert r.status_code == 404 and r.json()["detail"] == "Strategy not found.", (method, path, target, r.text)
    assert a_state(store, paper) == before  # nothing of A's changed
    # the owner still reaches it
    assert a.get(f"/api/paper/positions?strategy={A_ST}").json()["rows"][0]["open_qty"] == 65
    # "all" means the caller's own strategies only
    assert b.get("/api/paper/trades?strategy=all").json()["rows"] == []
    assert b.get("/api/paper/pnl?strategy=all&from=2026-10-01&to=2026-10-31").json()["rows"] == []


def test_algo_pages_and_strategy_only_for_its_owner(env):
    app, a, b, *_ = env
    algo_routes = [(m, r.path) for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/api/algo/")
                   for m in r.methods]
    assert len(algo_routes) == 8
    for method, path in algo_routes:
        r = b.request(method, path)
        assert r.status_code == 404, (method, path)
    assert a.get("/api/algo/status").status_code == 200
    assert a.post("/api/algo/stop").status_code == 200 and a.post("/api/algo/resume").status_code == 200
    assert [s["name"] for s in b.get("/api/strategies").json()["strategies"]] == ["EMA"]
    names = sorted(s["name"] for s in a.get("/api/strategies").json()["strategies"])
    assert names == ["OI Breakout Algo", "SuperTrend"]


def drain_until_status(ws, svc_push):
    """Messages a socket got before a status marker pushed to everyone."""
    svc_push()
    seen = []
    while True:
        m = ws.receive_json()
        if m["type"] == "status":
            return seen
        seen.append(m)


@pytest.mark.parametrize("path", ["/ws/paper", "/ws/scalper"])
def test_account_events_reach_only_the_owner_ticks_reach_both(env, path):
    app, a, b, paper, store, clock = env
    scalper = next(fn.__self__ for fn in paper.event_listeners)
    push = (lambda: paper._broadcast({"type": "status", "data": {}})) if path == "/ws/paper" else \
        (lambda: scalper._broadcast({"type": "status", "data": {}}))
    with a.websocket_connect(f"{path}?strategy={A_ST}") as wa, b.websocket_connect(f"{path}?strategy={A_ST}") as wb:
        assert wa.receive_json()["strategyId"] == A_ST
        snap_b = wb.receive_json()
        assert snap_b["strategyId"] is None and "positions" not in snap_b  # B can't open A's strategy
        for ws in (wa, wb):
            ws.send_json({"type": "subscribe", "instruments": [["NSE_FNO", CE]]})
        deadline = time.monotonic() + 2
        while ("NSE_FNO", CE) not in paper.feed.subs or len([c for c in paper.clients | scalper.clients if c.subs]) < 2:
            assert time.monotonic() < deadline
            time.sleep(0.005)
        paper.on_packet(full(CE, 100, 99.95, 100))
        a.post(f"/api/paper/orders?strategy={A_ST}", json=BODIES[("POST", "/api/paper/orders")])
        got_a = drain_until_status(wa, push)
        got_b = drain_until_status(wb, push)
    market = {"tick", "candle", "volume"}  # shared market data
    kinds_a = [m["type"] for m in got_a]
    assert {"order", "trade", "position", "funds"} <= set(kinds_a) and "tick" in kinds_a
    assert all(m.get("strategyId") == A_ST for m in got_a if m["type"] not in market)
    kinds_b = [m["type"] for m in got_b]
    assert "tick" in kinds_b and set(kinds_b) <= market  # A's account events never reach B


def test_each_strategy_has_its_own_engine_funds_and_pnl(env):
    app, a, b, paper, store, clock = env
    paper.on_packet(full(CE, 100, 99.95, 100))
    a.post(f"/api/scalper/orders?strategy={A_ST}", json={"securityId": CE, "side": "BUY", "lots": 2})
    b.post(f"/api/scalper/orders?strategy={B_ST}", json={"securityId": CE, "side": "BUY", "lots": 1})
    fa = a.get(f"/api/paper/account?strategy={A_ST}").json()["funds"]
    fb = b.get(f"/api/paper/account?strategy={B_ST}").json()["funds"]
    assert (fa["used"], fb["used"]) == (13000, 6500)
    assert paper.books[A_ST].engine is not paper.books[B_ST].engine
    clock.now = at("15:15")
    paper.tick_timer()  # each book squares off its own position
    assert a.get(f"/api/paper/positions?strategy={A_ST}").json()["rows"][0]["open_qty"] == 0
    assert b.get(f"/api/paper/positions?strategy={B_ST}").json()["rows"][0]["open_qty"] == 0
