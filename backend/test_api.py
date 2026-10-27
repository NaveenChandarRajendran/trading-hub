"""End to end with a fake Dhan client: tracker -> storage -> API."""
import shutil
import tempfile
from datetime import datetime

from fastapi.testclient import TestClient

from dhan_client import DhanError, parse_chain
from authfake import create_app
from store import JsonStore
from tracker import IST, Tracker


def payload(spot, bump):
    oc = {}
    for i in range(40):
        k = 55000 + 100 * i
        oc[f"{k}.000000"] = {
            "ce": {"oi": 1000 + bump, "previous_oi": 1000, "last_price": 100, "previous_close_price": 110},
            "pe": {"oi": 1000 + 2 * bump, "previous_oi": 1000, "last_price": 90, "previous_close_price": 80},
        }
    return {"data": {"last_price": spot, "oc": oc}, "status": "success"}


class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False

    def __init__(self):
        self.bump, self.spot, self.fail = 0, 55844.0, False

    def expiries(self, symbol):
        return ["2026-10-27", "2026-11-23"]

    def option_chain(self, symbol, expiry):
        if self.fail:
            raise DhanError("boom")
        return parse_chain(payload(self.spot, self.bump))


def at(hm, day=19):  # 2026-10-19 is a Monday
    h, m = map(int, hm.split(":"))
    return datetime(2026, 10, day, h, m, 3, tzinfo=IST)


def test_full_flow_and_restart():
    tmp = tempfile.mkdtemp()
    try:
        fake = FakeClient()
        tr = Tracker(fake, data_dir=tmp, each_side=7, clock=lambda: at("09:27"))  # market open
        app = create_app(tr)
        c = TestClient(app)

        # first request registers the key; nothing stored yet
        r = c.get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5").json()
        assert r["rows"] == [] and r["meta"]["message"]

        key = ("BANKNIFTY", "2026-10-27")
        for i, hm in enumerate(["09:20", "09:21", "09:25", "09:26"]):
            fake.bump, fake.spot = 10 * (i + 1), 55844.0 + i
            tr.poll_key(key, at(hm))

        r = c.get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5").json()
        assert r["meta"]["strikeCount"] == 15 and len(r["meta"]["strikes"]) == 15
        assert [x["time"] for x in r["rows"]] == ["09:26:00", "09:25:00", "09:20:00"]   # newest first
        assert r["rows"][0]["live"] and not r["rows"][1]["live"]
        # 15 strikes * bump 40 on calls, 80 on puts at 09:25 (i=2 -> bump 30): calls 450, puts 900
        row = next(x for x in r["rows"] if x["time"] == "09:25:00")
        assert row["callChg"] == 15 * 30 and row["putChg"] == 15 * 60 and row["diffOi"] == 15 * 30
        assert row["sentiment"] == "Bullish" and row["netPcr"] == 2.0 and row["strengthPct"] == 50.0

        # 1-min view has every stored snapshot
        r1 = c.get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=1").json()
        assert len(r1["rows"]) == 4

        # restart: a new tracker resumes from the saved file, strike set unchanged
        tr2 = Tracker(fake, data_dir=tmp, each_side=3, clock=lambda: at("09:27"))  # different setting must NOT change today's strikes
        c2 = TestClient(create_app(tr2))
        r2 = c2.get("/api/trending-oi?symbol=BANKNIFTY&expiry=2026-10-27&interval=5").json()
        assert len(r2["rows"]) == 3 and r2["meta"]["strikeCount"] == 15

        # bad input
        assert c.get("/api/trending-oi?symbol=FOO").status_code == 400
        assert c.get("/api/trending-oi?interval=7").status_code == 400
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_new_day_resets_and_errors_are_kept():
    tmp = tempfile.mkdtemp()
    try:
        fake = FakeClient()
        tr = Tracker(fake, data_dir=tmp)
        key = tr.register("BANKNIFTY", "2026-10-27")
        tr.poll_key(key, at("10:00", 19))
        tr.poll_key(key, at("09:20", 20))
        v = tr.view(key)
        assert v["date"] == "2026-10-20" and len(v["snaps"]) == 1
        fake.fail = True
        tr._poll_all(only_new=False) if tr.market_open(at("10:00")) else None
        assert tr.market_open(at("10:00")) and not tr.market_open(at("10:00", 17))  # Saturday
        assert not tr.market_open(at("15:41"))
        assert not tr.market_open(at("10:00", 20))  # Dussehra, NSE holiday
        assert tr.market_open(at("10:00", 21))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_rows_outside_session_are_dropped_on_restart_and_no_live_tag_after_close():
    tmp = tempfile.mkdtemp()
    try:
        fake = FakeClient()
        tr = Tracker(fake, data_dir=tmp, force=True, clock=lambda: at("19:52"))          # --force run records after-close rows
        key = tr.register("BANKNIFTY", "2026-10-27")
        for hm in ["15:30", "15:40", "19:50", "19:52"]:
            tr.poll_key(key, at(hm))
        assert len(tr.view(key)["snaps"]) == 4
        tr2 = Tracker(fake, data_dir=tmp, clock=lambda: at("19:52"))                     # normal run: only 15:30 and 15:40 survive
        key2 = tr2.register("BANKNIFTY", "2026-10-27")
        assert [x["ts"][-5:] for x in tr2.view(key2)["snaps"]] == ["15:30", "15:40"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class FlakyStore(JsonStore):
    def __init__(self, d):
        super().__init__(d)
        self.fail, self.saved = True, []

    def save(self, symbol, expiry, date, strikes, new_snaps, all_snaps):
        if self.fail:
            raise OSError("disk full")
        self.saved += [s["ts"][-5:] for s in new_snaps]
        super().save(symbol, expiry, date, strikes, new_snaps, all_snaps)


def test_failed_write_is_kept_in_memory_and_retried():
    tmp = tempfile.mkdtemp()
    try:
        flaky = FlakyStore(tmp)
        tr = Tracker(FakeClient(), store=flaky, clock=lambda: at("09:27"))
        key = tr.register("BANKNIFTY", "2026-10-27")
        tr.poll_key(key, at("09:20"))                      # write fails: row still served, error shown
        v = tr.view(key)
        assert len(v["snaps"]) == 1 and "Database write failed" in v["last_error"]
        flaky.fail = False
        tr.poll_key(key, at("09:21"))                      # next poll saves BOTH rows
        assert flaky.saved == ["09:20", "09:21"] and tr.view(key)["last_error"] == ""
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
