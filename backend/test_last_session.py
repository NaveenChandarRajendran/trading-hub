"""Market closed (weekend / holiday / before 09:15): the Trending OI screen shows the last recorded session."""
import tempfile
from datetime import datetime

from store import JsonStore
from tracker import IST, Tracker


class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False


def snap(day, hm, spot):
    return {"ts": f"{day} {hm}", "spot": spot, "strikes_used": 15, "call_chg": 100.0, "put_chg": 300.0,
            "call_ltp": 0.0, "put_ltp": 0.0, "call_ltp_chg": 0.0, "put_ltp_chg": 0.0}


def test_last_session_is_the_latest_recorded_day_before_today():
    tmp = tempfile.mkdtemp()
    store = JsonStore(tmp)
    store.save("BANKNIFTY", "2026-10-27", "2026-10-21", [55000.0], [], [snap("2026-10-21", "15:29", 1)])
    store.save("BANKNIFTY", "2026-10-27", "2026-10-23", [56000.0], [], [snap("2026-10-23", "09:20", 2), snap("2026-10-23", "15:29", 3)])
    store.save("NIFTY", "2026-10-27", "2026-10-24", [25000.0], [], [snap("2026-10-24", "09:20", 9)])  # other symbol: ignored
    sunday = datetime(2026, 10, 25, 16, 20, tzinfo=IST)
    tr = Tracker(FakeClient(), store=store, clock=lambda: sunday)
    day, strikes, snaps = tr.last_session("BANKNIFTY", "2026-10-27")
    assert day == "2026-10-23" and strikes == [56000.0] and [s["spot"] for s in snaps] == [2, 3]
    assert store.last_day("BANKNIFTY", "2026-10-27", "2026-10-23") == "2026-10-21"
    assert tr.last_session("BANKNIFTY", "2026-11-24") is None
