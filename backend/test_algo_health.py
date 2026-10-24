"""Reliability of the algo runner (the 23-Oct silent feed): watchdog per index with logged resubscribe / reconnect
attempts, heartbeat, exceptions logged with tracebacks without stopping, page health, and the candle window."""
import os
import shutil
import tempfile

import pytest

from algo_service import AlgoService
from paper_api import PaperService
from store import PaperJsonStore
from test_algo_service import DAY, GOOD_CE, Clock, Instruments, at, candle, make_data, setup_levels, tick
from test_paper_api import FakeFeed


class WatchFeed(FakeFeed):
    def __init__(self):
        super().__init__()
        self.status.update(reconnects=0)
        self.calls = []

    def resubscribe(self):
        self.calls.append("resubscribe")

    def reconnect(self, reason):
        self.calls.append(f"reconnect: {reason}")


@pytest.fixture
def env():
    tmp = tempfile.mkdtemp()
    clock = Clock()
    clock.now = at("09:14")
    store = PaperJsonStore(tmp)
    feed = WatchFeed()
    paper = PaperService(store, feed, Instruments(), clock=clock)
    algo = AlgoService(store, paper, Instruments(), make_data(), clock, mode="paper", log_dir=os.path.join(tmp, "logs"),
                        variant="A", shadows=())
    algo.filters = lambda sym, end, now, r=None: dict(GOOD_CE)
    yield algo, paper, clock, store, feed, tmp
    shutil.rmtree(tmp, ignore_errors=True)


def events(store, kind=None):
    return [e for e in store.algo_events(DAY) if kind is None or e["kind"] == kind]


def run_timer(algo, clock, frm, to, step=1, paper=None):
    """The timer from frm to to; with paper, BANKNIFTY keeps ticking (so only NIFTY can go stale)."""
    from datetime import timedelta
    t, end = frm, to
    while t <= end:
        if paper is not None:
            clock.now = t
            paper.on_packet({"kind": "ticker", "segment": "IDX_I", "security_id": 25, "ltp": 54700})
        clock.now = t
        algo.tick(t)
        t += timedelta(seconds=step)


def test_silent_index_is_logged_retried_with_backoff_and_logged_when_back(env):
    algo, paper, clock, store, feed, _ = env
    setup_levels(algo, paper, clock)
    tick(paper, clock, at("10:00"), 22700)
    feed.status["lastPacketAt"] = __import__("time").time()  # the connection itself still gets packets
    run_timer(algo, clock, at("10:00", 1), at("10:04"), step=5, paper=paper)
    stale = [e["message"] for e in events(store, "stale") if e["message"].startswith("Feed stale: no NIFTY")]
    assert len(stale) == 1 and stale[0].startswith("Feed stale: no NIFTY tick for 12") and "last tick 10:00:00, spot 22,700" in stale[0]
    tries = [e["message"] for e in events(store, "feed") if e["index"] == "NIFTY"]
    assert tries[0] == "Reconnect attempt 1 for NIFTY: resubscribed every instrument; next try in 30 s if still stale"
    assert tries[1].startswith("Reconnect attempt 2 for NIFTY: reconnecting the feed; next try in 60 s")
    assert feed.calls[:2] == ["resubscribe", "reconnect: no NIFTY tick for 151 s"]
    assert algo.status()["meta"]["health"]["state"] == "stale"
    tick(paper, clock, at("10:04", 2), 22710)
    clock.now = at("10:04", 3)
    algo.tick(clock.now)
    back = [e["message"] for e in events(store, "feed") if e["message"].startswith("Feed back")]
    assert back == ["Feed back: NIFTY ticks resumed after 4 min 3 s (no ticks 10:00:00-10:04:03)"]


def test_no_ticks_at_all_after_the_open_is_noticed(env):
    algo, paper, clock, store, feed, _ = env
    run_timer(algo, clock, at("09:15", 1), at("09:17", 30), step=10)
    assert any(m["message"].startswith("Feed stale: no NIFTY tick for") and "none today" in m["message"]
               for m in events(store, "stale"))


def test_heartbeat_every_15_minutes_in_the_session(env):
    algo, paper, clock, store, feed, _ = env
    algo.tick(at("09:10"))  # before the session: nothing
    tick(paper, clock, at("09:15", 3), 22690)
    run_timer(algo, clock, at("09:15", 4), at("09:45", 30), step=30)
    beats = events(store, "heartbeat")
    assert [b["ts"][11:19] for b in beats] == ["09:15:04", "09:30:04", "09:45:04"]
    assert beats[0]["message"].startswith("Heartbeat: NIFTY last tick 09:15:03 spot 22,690 · BANKNIFTY no tick yet")


def test_exceptions_are_logged_with_traceback_and_the_loop_keeps_going(env):
    algo, paper, clock, store, feed, tmp = env
    setup_levels(algo, paper, clock)

    def boom(*a):
        raise ValueError("bad tick")

    algo._minute = boom
    tick(paper, clock, at("10:00"), 22700)  # does not raise into the feed
    tick(paper, clock, at("10:00", 1), 22701)  # same error within a minute: logged once
    errs = [e for e in events(store, "error") if e["message"].startswith("tick handler")]
    assert [e["message"] for e in errs] == ["tick handler: ValueError: bad tick"]
    text = open(os.path.join(tmp, "logs", f"algo-{DAY}.log"), encoding="utf-8").read()
    assert "Traceback (most recent call last)" in text and "ValueError: bad tick" in text
    assert algo.status()["meta"]["health"] == {"state": "error", "reason": "tick handler: ValueError: bad tick (at 10:00:01)"}

    algo._minute = AlgoService._minute.__get__(algo)
    algo.filters = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Dhan down"))
    candle(algo, paper, clock, "10:15", 22700, 22705, 22695, 22700)
    assert any(e["message"] == "NIFTY candle evaluation: RuntimeError: Dhan down" for e in events(store, "error"))
    algo.filters = lambda sym, end, now, r=None: dict(GOOD_CE)
    candle(algo, paper, clock, "10:20", 22700, 22705, 22695, 22702)  # next candle evaluated normally
    assert [c["candle_start"][11:16] for c in store.algo_candles(DAY, "NIFTY")][-1] == "10:15"  # the 10:15-10:20 candle


def test_only_candles_opening_at_or_after_0930_and_inside_the_session(env):
    algo, paper, clock, store, feed, _ = env
    setup_levels(algo, paper, clock)  # 09:30:05: the 09:25-09:30 candle is not evaluated
    assert not store.algo_candles(DAY)
    candle(algo, paper, clock, "09:35", 22700, 22705, 22695, 22702)
    assert [c["candle_start"][11:16] for c in store.algo_candles(DAY, "NIFTY")] == ["09:30"]  # 09:30-09:35
    clock.now = at("15:40")
    algo.tick(clock.now)
    starts = [c["candle_start"][11:16] for c in store.algo_candles(DAY)]
    assert all(s <= "15:25" for s in starts)
    assert not [e for e in events(store, "stale") if "15:35" in e["message"] or "15:40" in e["message"]]
