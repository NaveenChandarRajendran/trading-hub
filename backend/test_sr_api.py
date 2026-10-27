"""Level history end to end: tracker minute polls -> stability rule -> sr_levels rows -> GET /api/sr/history."""
import tempfile
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from authfake import create_app
from store import JsonStore
from tracker import IST, Tracker

KEY = ("NIFTY", "2026-10-27")
PUTS = {22700: 1000, 22600: 900, 22500: 800, 22400: 100}
CALLS = {22900: 1200, 23000: 1500, 23100: 900}


def leg(oi):
    return {"oi": oi, "previous_oi": oi, "last_price": 10.0, "previous_close_price": 10.0}


class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False

    def __init__(self):
        self.spot, self.puts, self.calls = 22811.0, dict(PUTS), dict(CALLS)

    def expiries(self, symbol):
        return ["2026-10-27"]

    def option_chain(self, symbol, expiry):
        strikes = set(self.puts) | set(self.calls)
        return {"spot": self.spot,
                "oc": {float(k): {"ce": leg(self.calls.get(k, 0)), "pe": leg(self.puts.get(k, 0))} for k in strikes}}


def at(hm, day=22):
    h, m = map(int, hm.split(":"))
    return datetime(2026, 10, day, h, m, 3, tzinfo=IST)


def make(tmp=None):
    tmp = tmp or tempfile.mkdtemp()
    fake = FakeClient()
    tr = Tracker(fake, data_dir=tmp, clock=lambda: at("10:00"))
    tr.register(*KEY)
    return fake, tr, TestClient(create_app(tr)), tmp


def poll(tr, *times):
    for hm in times:
        tr.poll_key(KEY, at(hm))


def test_first_poll_opens_six_rows_and_unchanged_polls_write_nothing():
    fake, tr, c, tmp = make()
    poll(tr, "09:16", "09:17", "09:18", "09:19")
    rows = tr.store.sr_rows("NIFTY", "2026-10-27", "2026-10-22")
    assert sorted((r["slot"], r["strike"]) for r in rows) == [
        ("R1", 22900), ("R2", 23000), ("R3", 23100), ("S1", 22700), ("S2", 22600), ("S3", 22500)]
    assert all(r["valid_from"] == "2026-10-22 09:16" and r["valid_to"] is None and r["reason"] == "open" for r in rows)


def test_a_brief_flip_writes_nothing_a_sustained_lead_closes_and_opens_a_row():
    fake, tr, c, tmp = make()
    poll(tr, "09:16")
    fake.puts[22400] = 900  # 12.5 % over S3 (800)
    poll(tr, "09:17", "09:18")
    fake.puts[22400] = 100  # flips back
    poll(tr, "09:19")
    assert len(tr.store.sr_rows("NIFTY", "2026-10-27", "2026-10-22")) == 6
    fake.puts[22400] = 900
    poll(tr, "10:45", "10:46", "10:47")
    rows = tr.store.sr_rows("NIFTY", "2026-10-27", "2026-10-22")
    s3 = [r for r in rows if r["slot"] == "S3"]
    assert [(r["strike"], r["valid_from"], r["valid_to"], r["reason"]) for r in s3] == [
        (22500, "2026-10-22 09:16", "2026-10-22 10:47", "open"),
        (22400, "2026-10-22 10:47", None, "oi"),
    ]
    assert s3[1]["oi"] == 900

    body = c.get("/api/sr/history?symbol=NIFTY&expiry=2026-10-27&date=2026-10-22").json()
    assert body["changes"] == [{"at": "2026-10-22 10:47", "slot": "S3", "from": 22500, "to": 22400, "reason": "oi"}]
    assert [r["strike"] for r in body["current"]["S"]] == [22700, 22600, 22400]
    assert [r["strike"] for r in body["current"]["R"]] == [22900, 23000, 23100]
    assert len(body["segments"]) == 7 and body["meta"]["settings"] == {"leadPct": 10.0, "confirmRefreshes": 3, "range": 500}


def test_a_crossed_level_moves_at_once():
    fake, tr, c, tmp = make()
    poll(tr, "09:16")
    fake.spot = 22650  # through S1 22,700
    poll(tr, "11:02")
    body = c.get("/api/sr/history?symbol=NIFTY&expiry=2026-10-27&date=2026-10-22").json()
    assert {(x["slot"], x["from"], x["to"], x["reason"]) for x in body["changes"]} == {
        ("S1", 22700, 22600, "crossed"), ("S2", 22600, 22500, "renumber"), ("S3", 22500, 22400, "crossed")}
    assert all(x["at"] == "2026-10-22 11:02" for x in body["changes"])


def test_restart_resumes_from_the_open_rows():
    fake, tr, c, tmp = make()
    poll(tr, "09:16")
    fake2, tr2, c2, _ = make(tmp)  # new tracker on the same data folder
    poll(tr2, "09:30")
    assert len(tr2.store.sr_rows("NIFTY", "2026-10-27", "2026-10-22")) == 6  # nothing re-opened
    assert tr2.current_levels("NIFTY", "2026-10-27", "2026-10-22")["S1"]["strike"] == 22700


def test_a_failed_write_is_retried_on_the_next_poll():
    fake, tr, c, tmp = make()
    real = tr.store.sr_write
    tr.store.sr_write = lambda *a: (_ for _ in ()).throw(OSError("disk full"))
    poll(tr, "09:16")
    assert tr.store.sr_rows("NIFTY", "2026-10-27", "2026-10-22") == []
    assert tr.current_levels("NIFTY", "2026-10-27", "2026-10-22")["S1"]["strike"] == 22700  # served from memory
    tr.store.sr_write = real
    poll(tr, "09:17")
    assert len(tr.store.sr_rows("NIFTY", "2026-10-27", "2026-10-22")) == 6


def test_settings_validate_persist_and_apply_from_the_next_refresh():
    fake, tr, c, tmp = make()
    assert c.get("/api/sr/settings").json() == {"leadPct": 10.0, "confirmRefreshes": 3, "range": 500}
    assert c.put("/api/sr/settings", json={"confirmRefreshes": 0}).status_code == 400
    assert c.put("/api/sr/settings", json={"leadPct": 150}).status_code == 400
    saved = c.put("/api/sr/settings", json={"leadPct": 5, "confirmRefreshes": 1}).json()
    assert saved == {"leadPct": 5.0, "confirmRefreshes": 1, "range": 500}
    assert JsonStore(tmp).sr_settings() == saved  # survives a restart
    poll(tr, "09:16")
    fake.puts[22400] = 850  # +6.25 %: enough with the new settings, on the first refresh
    poll(tr, "09:17")
    assert tr.current_levels("NIFTY", "2026-10-27", "2026-10-22")["S3"]["strike"] == 22400


def test_history_errors_and_empty_days():
    fake, tr, c, tmp = make()
    assert c.get("/api/sr/history?symbol=FINNIFTY").status_code == 400
    assert c.get("/api/sr/history?date=22-10-2026").status_code == 400
    old = c.get("/api/sr/history?symbol=NIFTY&expiry=2026-10-27&date=2026-10-20").json()
    assert old["segments"] == [] and old["changes"] == [] and old["meta"]["message"] == "No levels recorded for this day."
    today = c.get("/api/sr/history?symbol=NIFTY").json()  # nearest expiry, today, before the first poll
    assert today["meta"]["expiry"] == "2026-10-27" and today["meta"]["message"].startswith("No levels yet")


def test_levels_snapshot_for_paper_orders():
    fake, tr, c, tmp = make()
    tr.clock = lambda: at("09:17")
    assert tr.levels_snapshot("NIFTY") is None  # nothing recorded yet
    poll(tr, "09:16", "09:17")
    snap = tr.levels_snapshot("NIFTY", "2026-11-03")  # expiry not tracked: the nearest tracked one
    assert (snap["expiry"], snap["spot"], snap["at"]) == ("2026-10-27", 22811.0, "2026-10-22 09:17")
    assert snap["levels"] == {"R1": 22900, "R2": 23000, "R3": 23100, "S1": 22700, "S2": 22600, "S3": 22500}
    assert tr.levels_snapshot("BANKNIFTY") is None


def test_tracker_levels_changes_match_the_history_endpoint():
    from paper_levels import TrackerLevels
    fake, tr, c, tmp = make()
    fake.spot = 22650.0  # S1 22,700 crossed
    poll(tr, "09:16")
    fake.spot = 22811.0
    poll(tr, "09:17")
    tr.clock = lambda: at("09:18")
    assert TrackerLevels(tr).changes(*KEY, "2026-10-22") == c.get("/api/sr/history", params={"expiry": KEY[1]}).json()["changes"]
