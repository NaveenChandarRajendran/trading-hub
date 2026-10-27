"""S/R levels with paper orders (paper_levels.py + PaperService): the snapshot saved per order, the entry zone of an
open position, and level shifts near it, sent once per shift. Fake feed / instruments / levels: never Dhan."""
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

from authfake import StrategyClient, create_app
from paper_api import PaperService
from paper_levels import nearest_zone, opening_order, shifts_near
from store import PaperJsonStore
from test_api import FakeClient
from test_paper_api import CE, SID, Clock, FakeFeed, FakeInstruments, at, buy, full, manual_strategy, sell
from tracker import Tracker

LEVELS = {"R1": 25200.0, "R2": 25300.0, "R3": 25400.0, "S1": 25000.0, "S2": 24900.0, "S3": 24800.0}


# ---------- pure rules ----------
def test_entry_zone_is_the_level_nearest_spot_either_side():
    assert nearest_zone(LEVELS, 25130) == {"slot": "R1", "strike": 25200.0}
    assert nearest_zone(LEVELS, 25060) == {"slot": "S1", "strike": 25000.0}
    assert nearest_zone(LEVELS, 25100) == {"slot": "S1", "strike": 25000.0}  # tie: support
    assert nearest_zone({}, 25100) is None


def t(order_id, side, qty, sid=CE):
    return {"order_id": order_id, "side": side, "qty": qty, "security_id": sid}


def test_opening_order_follows_the_current_position():
    trades = [t("O1", "BUY", 65), t("O2", "BUY", 65), t("O3", "SELL", 130), t("O4", "BUY", 65), t("X", "BUY", 65, sid=1)]
    assert opening_order(trades[:2], CE) == "O1"  # adding to a position keeps the first entry
    assert opening_order(trades[:3], CE) is None  # flat
    assert opening_order(trades, CE) == "O4"  # re-entered after going flat
    assert opening_order(trades, 2) is None


def ch(at_hm, slot, frm, to, reason="oi"):
    return {"at": f"2026-10-21 {at_hm}", "slot": slot, "from": frm, "to": to, "reason": reason}


def test_shifts_near_the_zone_after_entry_only():
    zone = {"slot": "S1", "strike": 25000.0}
    changes = [
        ch("11:30", "S1", 25000.0, 24900.0),  # the zone itself moved
        ch("11:30", "S2", 24900.0, 24800.0, "renumber"),  # follows the S1 move: not counted again
        ch("11:10", "R1", 25200.0, 25300.0),  # 200 pts away: ignored
        ch("10:40", "S2", 24900.0, None, "gone"),  # within 100 pts, slot emptied
        ch("10:00", "S1", 25050.0, 25000.0),  # before the entry snapshot
    ]
    out = shifts_near(changes, zone, "2026-10-21 10:15")
    assert [(s["id"], s["to"]) for s in out] == [("S1|2026-10-21 11:30", 24900.0), ("S2|2026-10-21 10:40", None)]
    assert shifts_near(changes, zone, "2026-10-21 11:30") == []  # a change in the same refresh came before the order


# ---------- service ----------
class FakeLevels:
    def __init__(self):
        self.spot, self.at, self.changes_list, self.calls = 25060.0, "2026-10-21 10:15", [], 0

    def snapshot(self, symbol, expiry):
        return {"symbol": symbol, "expiry": expiry, "date": "2026-10-21", "spot": self.spot, "at": self.at, "levels": LEVELS}

    def changes(self, symbol, expiry, date):
        self.calls += 1
        return list(self.changes_list)


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock, feed, levels = Clock(), FakeFeed(), FakeLevels()
    clock.now = at("10:15")
    manual_strategy(PaperJsonStore(tmp), clock)
    svc = PaperService(PaperJsonStore(tmp), feed, FakeInstruments(), clock=clock, levels=levels)
    c = StrategyClient(create_app(Tracker(FakeClient(), data_dir=tmp, clock=clock), paper=svc), SID)
    sent = []
    svc._send = lambda book, kind, data: sent.append({"type": kind, "data": data})
    yield c, svc, clock, levels, sent, tmp
    shutil.rmtree(tmp, ignore_errors=True)


def test_order_saves_the_levels_and_the_position_shows_its_entry_zone(env):
    c, svc, clock, levels, sent, tmp = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    r = buy(c).json()
    rows = PaperJsonStore(tmp).order_levels(1, "2026-10-21")
    assert [(x["order_id"], x["levels"], x["spot"], x["zone"]) for x in rows] == [
        (r["id"], LEVELS, 25060.0, {"slot": "S1", "strike": 25000.0})]
    pos = c.get("/api/paper/positions").json()["rows"][0]
    assert pos["entryZone"] == {"slot": "S1", "strike": 25000.0, "symbol": "NIFTY", "expiry": "2026-10-27", "spot": 25060.0,
                                "at": "2026-10-21 10:15", "orderId": r["id"]}
    assert pos["levelShifts"] == []
    pushed = [m["data"] for m in sent if m["type"] == "position"]
    assert pushed[-1]["entryZone"]["strike"] == 25000.0  # the live update carries it too


def test_adding_keeps_the_first_entry_zone_and_a_closed_position_has_none(env):
    c, svc, clock, levels, sent, _ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    first = buy(c).json()["id"]
    levels.spot = 25180.0  # nearer R1 now
    buy(c)
    assert c.get("/api/paper/positions").json()["rows"][0]["entryZone"]["orderId"] == first
    sell(c, lots=2)
    pos = c.get("/api/paper/positions").json()["rows"][0]
    assert pos["open_qty"] == 0 and pos["entryZone"] is None and pos["levelShifts"] == []


def test_a_shift_near_the_zone_is_pushed_once(env):
    c, svc, clock, levels, sent, _ = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    svc.tick_timer()
    sent.clear()
    levels.changes_list = [ch("10:47", "S1", 25000.0, 24900.0), ch("10:47", "S2", 24900.0, 24800.0, "renumber")]
    clock.now = at("10:47")
    svc.tick_timer()
    pushed = [m["data"] for m in sent if m["type"] == "position"]
    assert len(pushed) == 1 and [s["id"] for s in pushed[0]["levelShifts"]] == ["S1|2026-10-21 10:47"]
    assert pushed[0]["levelShifts"][0]["to"] == 24900.0
    sent.clear()
    clock.now = at("10:48")
    svc.tick_timer()
    assert [m for m in sent if m["type"] == "position"] == []  # same shift: not sent again
    assert c.get("/api/paper/positions").json()["rows"][0]["levelShifts"][0]["id"] == "S1|2026-10-21 10:47"


def test_no_levels_recorded_still_places_the_order(env):
    c, svc, clock, levels, sent, tmp = env
    levels.snapshot = lambda symbol, expiry: None
    svc.on_packet(full(CE, 100, 99.95, 100))
    assert buy(c).json()["status"] == "FILLED"
    assert PaperJsonStore(tmp).order_levels(1, "2026-10-21") == []
    assert c.get("/api/paper/positions").json()["rows"][0]["entryZone"] is None


def test_restart_keeps_the_entry_zone(env):
    c, svc, clock, levels, sent, tmp = env
    svc.on_packet(full(CE, 100, 99.95, 100))
    buy(c)
    svc2 = PaperService(PaperJsonStore(tmp), FakeFeed(), FakeInstruments(), clock=clock, levels=levels)
    assert svc2.positions(svc2.books[SID])[0]["entryZone"]["slot"] == "S1"
