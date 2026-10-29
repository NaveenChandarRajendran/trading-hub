"""Strategy Builder backend (builder.py, builder_api.py, dhan_client.margin_multi): drafts per user (private, validated,
edited in place), the basket margin (cached, Dhan failures as "margin unavailable") and Analyze positions (the user's
own manual strategy only). Real login with two users; JSON store and, with TEST_DATABASE_URL, Postgres (it TRUNCATEs
th_users and by cascade the drafts and pt_ tables: use a throwaway database)."""
import os
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

import dhan_client
from auth import Auth, MemoryAuthStore
from dhan_client import DhanError, TokenExpired
from main import create_app
from paper_api import PaperService
from store import PaperJsonStore, PaperPgStore, PgStore
from test_api import FakeClient
from test_paper_api import CE, Clock, FakeFeed, FakeInstruments, at, full
from tracker import Tracker

DSN = os.getenv("TEST_DATABASE_URL")
LEG = {"side": "S", "type": "PE", "expiry": "2026-11-03", "strike": 21950, "lots": 1, "include": True, "priceOverride": None}
DRAFT = {"name": "IC A 3 Nov", "symbol": "NIFTY", "multiplier": 1,
         "legs": [LEG, {**LEG, "side": "B", "strike": 21700, "priceOverride": 8.85}]}


class MarginClient(FakeClient):
    """Dhan with a margin calculator: answers, or raises what `fail` holds; counts calls."""

    def __init__(self):
        super().__init__()
        self.calls, self.fail_with = [], None

    def margin_multi(self, scripts):
        self.calls.append(scripts)
        if self.fail_with:
            raise self.fail_with
        return {"total": 48210.5, "span": 15973.1, "exposure": 32237.4, "hedgeBenefit": 110000.0}


@pytest.fixture(params=["json", "postgres"])
def env(request):
    tmp = tempfile.mkdtemp()
    pg = None
    if request.param == "json":
        store = PaperJsonStore(tmp)
    else:
        if not DSN:
            pytest.skip("set TEST_DATABASE_URL to run the Postgres builder tests")
        pg = PgStore(DSN)
        with pg._cursor() as cur:
            cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users RESTART IDENTITY CASCADE")
            cur.execute("TRUNCATE pt_accounts RESTART IDENTITY CASCADE")
            cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen'), ('wife', 'Wife')")
        store = PaperPgStore(pg)
    clock = Clock()
    paper = PaperService(store, FakeFeed(), FakeInstruments(), clock=clock)
    auth = Auth(MemoryAuthStore())
    auth.create_user("naveen", "Naveen", "password-a1")
    auth.create_user("wife", "Wife", "password-b2")
    client = MarginClient()
    app = create_app(Tracker(client, data_dir=tmp, clock=clock), paper=paper, auth=auth)
    a, b = TestClient(app), TestClient(app)
    assert a.post("/api/auth/login", json={"username": "naveen", "password": "password-a1"}).status_code == 200
    assert b.post("/api/auth/login", json={"username": "wife", "password": "password-b2"}).status_code == 200
    yield a, b, paper, clock, client
    if pg:
        pg.close()
    shutil.rmtree(tmp, ignore_errors=True)


# ---------- drafts ----------
def test_save_list_edit_in_place_and_delete(env):
    a, *_ = env
    d = a.post("/api/builder/drafts", json=DRAFT).json()["draft"]
    assert (d["name"], d["symbol"], d["multiplier"], len(d["legs"])) == ("IC A 3 Nov", "NIFTY", 1, 2)
    assert d["legs"][1] == {**LEG, "side": "B", "strike": 21700.0, "priceOverride": 8.85}
    e = a.put(f"/api/builder/drafts/{d['id']}", json={"name": "IC A wider", "multiplier": 2, "legs": [LEG]}).json()["draft"]
    assert (e["id"], e["name"], e["multiplier"], len(e["legs"])) == (d["id"], "IC A wider", 2, 1)
    assert [x["name"] for x in a.get("/api/builder/drafts").json()["drafts"]] == ["IC A wider"]  # the same one, edited
    a.post("/api/builder/drafts", json={**DRAFT, "name": "Second"})
    assert [x["name"] for x in a.get("/api/builder/drafts").json()["drafts"]][0] == "Second"  # newest first
    assert a.delete(f"/api/builder/drafts/{d['id']}").status_code == 200
    assert [x["name"] for x in a.get("/api/builder/drafts").json()["drafts"]] == ["Second"]


def test_drafts_are_private(env):
    a, b, *_ = env
    d = a.post("/api/builder/drafts", json=DRAFT).json()["draft"]
    assert b.get("/api/builder/drafts").json()["drafts"] == []
    assert b.put(f"/api/builder/drafts/{d['id']}", json={"name": "x"}).status_code == 404
    assert b.delete(f"/api/builder/drafts/{d['id']}").status_code == 404
    assert a.get("/api/builder/drafts").json()["drafts"][0]["name"] == "IC A 3 Nov"  # untouched


def test_draft_validation(env):
    a, *_ = env
    for bad in ({"name": "  "}, {"symbol": "FINNIFTY"}, {"multiplier": 0}, {"multiplier": 51},
                {"legs": [LEG] * 9}, {"legs": [{**LEG, "side": "X"}]}, {"legs": [{**LEG, "type": "FUT"}]},
                {"legs": [{**LEG, "expiry": "3 Nov"}]}, {"legs": [{**LEG, "lots": 0}]}, {"legs": [{**LEG, "strike": -1}]},
                {"legs": [{**LEG, "priceOverride": -2}]}, {"legs": [{"side": "S"}]}):
        assert a.post("/api/builder/drafts", json={**DRAFT, **bad}).status_code == 400, bad
    assert a.post("/api/builder/drafts", json={**DRAFT, "legs": []}).status_code == 200  # an empty design is fine
    sx = a.post("/api/builder/drafts", json={**DRAFT, "name": "5 Nov Sensex Expiry - Iron Condor", "symbol": "SENSEX"})
    assert sx.status_code == 200 and sx.json()["draft"]["symbol"] == "SENSEX"  # Postgres: the widened symbol check


# ---------- margin ----------
MARGIN = {"legs": [{"securityId": 41001, "side": "S", "qty": 65, "price": 19.2},
                   {"securityId": 41002, "side": "B", "qty": 65, "price": 8.85}]}


def test_margin_from_dhan_cached_per_basket(env):
    a, _, _, _, client = env
    r = a.post("/api/builder/margin", json=MARGIN).json()
    assert r == {"total": 48210.5, "span": 15973.1, "exposure": 32237.4, "hedgeBenefit": 110000.0, "cached": False}
    assert client.calls[0] == [{"securityId": 41001, "transactionType": "SELL", "quantity": 65, "price": 19.2,
                                "exchangeSegment": "NSE_FNO"},
                               {"securityId": 41002, "transactionType": "BUY", "quantity": 65, "price": 8.85,
                                "exchangeSegment": "NSE_FNO"}]  # 41001 / 41002 are not in the instrument list: NSE
    assert a.post("/api/builder/margin", json={"legs": MARGIN["legs"][::-1]}).json()["cached"] is True  # same basket
    assert len(client.calls) == 1


def test_margin_failures(env):
    a, _, _, _, client = env
    assert a.post("/api/builder/margin", json={"legs": []}).status_code == 400
    assert a.post("/api/builder/margin", json={"legs": [{**MARGIN["legs"][0], "side": "X"}]}).status_code == 400
    client.fail_with = DhanError("Dhan HTTP 502")
    r = a.post("/api/builder/margin", json={"legs": [{**MARGIN["legs"][0], "qty": 130}]})
    assert r.status_code == 502 and r.json()["detail"].startswith("Margin unavailable")
    client.fail_with = TokenExpired("expired")
    assert a.post("/api/builder/margin", json={"legs": [{**MARGIN["legs"][0], "qty": 195}]}).status_code == 401


def test_dhan_margin_request_and_answer():
    """The body Dhan accepts (checked live 28-Oct-2026: dhanClientId + scripList) and its camelCase answer."""
    sent = {}

    class Session:
        def post(self, url, json, headers, timeout):
            sent.update(url=url, body=json)

            class R:
                status_code, ok, text = 200, True, ""

                @staticmethod
                def json():
                    return {"clientId": "1100", "totalMargin": 76406.98, "spanMargin": 15973.1, "exposure": 59393.88,
                            "hedgeBenefit": 0.0, "foMargin": 76406.98}
            return R()

    c = dhan_client.DhanClient("1100", "t" * 30, session=Session())
    m = c.margin_multi([{"securityId": 41001, "transactionType": "SELL", "quantity": 65, "price": 19.2}])
    assert m == {"total": 76406.98, "span": 15973.1, "exposure": 59393.88, "hedgeBenefit": 0.0}  # no clientId passed on
    assert sent["url"].endswith("/margincalculator/multi")
    assert sent["body"]["dhanClientId"] == "1100" and sent["body"]["includePosition"] is False
    assert sent["body"]["scripList"] == [{"exchangeSegment": "NSE_FNO", "transactionType": "SELL", "quantity": 65,
                                          "productType": "MARGIN", "securityId": "41001", "price": 19.2, "triggerPrice": 0}]
    with pytest.raises(DhanError):
        dhan_client.parse_margin({"errorMessage": "nope"})


# ---------- analyze positions ----------
def test_analyze_loads_open_positions_of_your_own_strategy(env):
    a, b, paper, clock, _ = env
    st = a.post("/api/strategies", json={"name": "Manual", "capital": 100000}).json()["strategy"]
    a.get(f"/api/paper/positions?strategy={st['id']}")  # its book is loaded on first use; then the tick reaches it
    clock.now = at("09:30")
    paper.on_packet(full(CE, 100, 99.95, 100))
    o = a.post(f"/api/paper/orders?strategy={st['id']}", json={"securityId": CE, "side": "BUY", "lots": 2, "orderType": "MARKET"})
    assert o.json()["status"] == "FILLED", o.json()
    r = a.get(f"/api/builder/positions?strategy={st['id']}").json()
    assert r["strategy"] == {"id": st["id"], "name": "Manual"}
    assert r["legs"] == [{"securityId": CE, "name": "NIFTY 27 OCT 25100 CALL", "symbol": "NIFTY", "expiry": "2026-10-27",
                          "strike": 25100.0, "type": "CE", "side": "B", "lots": 2, "lotSize": 65, "price": 100.0}]
    assert b.get(f"/api/builder/positions?strategy={st['id']}").status_code == 404  # not hers
    assert a.get("/api/builder/positions").status_code == 400  # pick a strategy
