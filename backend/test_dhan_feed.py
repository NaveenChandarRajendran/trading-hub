"""dhan_feed.py: binary parser and reconnecting client.

The packets below are SYNTHETIC: built byte by byte with the struct formats from the official SDK
(DhanHQ-py marketfeed.py: Full '<BHBIfHIfIIIIIIffff100s', depth '<IIHHff', Ticker/Prev close '<BHBIfI',
disconnect '<BHBIH'). test_captured_frames checks real frames once fixtures/dhan_feed_capture.json exists
(record it with capture_feed.py during market hours)."""
import asyncio
import base64
import json
import struct
from pathlib import Path

import pytest

from dhan_feed import FULL, QUOTE, TICKER, DhanFeed, parse_packets, subscription_messages, to_book

SID = 52175
DEPTH = [  # bid qty, ask qty, bid orders, ask orders, bid price, ask price
    (750, 300, 5, 2, 101.25, 101.35),
    (1500, 975, 9, 6, 101.2, 101.4),
    (225, 450, 2, 3, 101.15, 101.45),
    (0, 75, 0, 1, 0.0, 101.5),   # empty bid level
    (75, 0, 1, 0, 101.05, 0.0),  # empty ask level
]


def full_packet(sid=SID, ltp=101.3, segment=2):
    depth = b"".join(struct.pack("<IIHHff", *lv) for lv in DEPTH)
    return struct.pack("<BHBIfHIfIIIIIIffff100s", 8, 162, segment, sid, ltp, 75, 1792481400, 98.76,
                       1234500, 410000, 395000, 2_150_000, 2_400_000, 1_900_000,
                       95.5, 92.1, 108.0, 90.25, depth)


def ticker_packet(sid=13, ltp=25104.3):
    return struct.pack("<BHBIfI", 2, 16, 0, sid, ltp, 1792481400)


def prev_close_packet(sid=SID):
    return struct.pack("<BHBIfI", 6, 16, 2, sid, 92.1, 2_000_000)


def disconnect_packet(code):
    return struct.pack("<BHBIH", 50, 10, 2, 0, code)


# ---------- parser ----------
def test_full_packet():
    raw = full_packet()
    assert len(raw) == 162
    [p] = parse_packets(raw)
    assert (p["kind"], p["segment"], p["security_id"]) == ("full", "NSE_FNO", SID)
    assert p["ltp"] == 101.3  # float32 101.30000305 rounded to the paisa
    assert (p["ltq"], p["volume"], p["oi"], p["oi_day_high"], p["oi_day_low"]) == (75, 1234500, 2_150_000, 2_400_000, 1_900_000)
    assert (p["open"], p["close"], p["high"], p["low"], p["avg_price"]) == (95.5, 92.1, 108.0, 90.25, 98.76)
    assert (p["total_buy_qty"], p["total_sell_qty"]) == (395000, 410000)
    assert p["depth"][0] == {"bid_qty": 750, "ask_qty": 300, "bid_orders": 5, "ask_orders": 2,
                             "bid_price": 101.25, "ask_price": 101.35}
    assert len(p["depth"]) == 5


def test_full_packet_to_book_drops_empty_levels():
    b = to_book(parse_packets(full_packet())[0])
    assert b.ltp == 101.3
    assert b.bids == [(101.25, 750), (101.2, 1500), (101.15, 225), (101.05, 75)]
    assert b.asks == [(101.35, 300), (101.4, 975), (101.45, 450), (101.5, 75)]


def test_ticker_and_prev_close():
    [t] = parse_packets(ticker_packet())
    assert (t["kind"], t["segment"], t["security_id"], t["ltp"]) == ("ticker", "IDX_I", 13, 25104.3)
    [pc] = parse_packets(prev_close_packet())
    assert (pc["kind"], pc["prev_close"], pc["prev_oi"]) == ("prev_close", 92.1, 2_000_000)


def test_disconnect_reason():
    [d] = parse_packets(disconnect_packet(807))
    assert (d["kind"], d["code"], d["reason"]) == ("disconnect", 807, "Access token expired.")
    assert "code 999" in parse_packets(disconnect_packet(999))[0]["reason"]


def test_several_packets_in_one_frame():
    kinds = [p["kind"] for p in parse_packets(prev_close_packet() + full_packet() + ticker_packet())]
    assert kinds == ["prev_close", "full", "ticker"]


def test_truncated_and_unknown_packets_stop_parsing():
    assert [p["kind"] for p in parse_packets(ticker_packet() + full_packet()[:100])] == ["ticker"]
    assert parse_packets(bytes([99, 0, 0])) == []


# ---------- subscribe messages ----------
def test_subscription_batches_of_100():
    msgs = [json.loads(m) for m in subscription_messages([("NSE_FNO", i) for i in range(250)], FULL)]
    assert [m["InstrumentCount"] for m in msgs] == [100, 100, 50]
    assert msgs[0]["RequestCode"] == 21
    assert msgs[0]["InstrumentList"][1] == {"ExchangeSegment": "NSE_FNO", "SecurityId": "1"}


def test_unsubscribe_codes():
    for mode, code in ((TICKER, 16), (QUOTE, 18), (FULL, 22)):
        assert json.loads(subscription_messages([("IDX_I", 13)], mode, unsubscribe=True)[0])["RequestCode"] == code
    with pytest.raises(ValueError):
        subscription_messages([("IDX_I", 13)], 19)


# ---------- client ----------
class FakeWS:
    def __init__(self, frames):
        self.frames = list(frames)
        self.sent = []

    async def send(self, m):
        self.sent.append(json.loads(m))

    async def recv(self):
        if self.frames:
            return self.frames.pop(0)
        raise ConnectionError("socket closed")

    async def close(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def run_feed(sessions, subs=(("NSE_FNO", SID),)):
    """Runs the client against fake connections; stops when they are used up."""
    packets, urls = [], []
    conns = [FakeWS(s) for s in sessions]
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, on_packet=packets.append, backoff=(0,), market_open=lambda: False)

    def connect(url):
        urls.append(url)
        if not conns:
            feed._stopping = True
            raise ConnectionError("no more fake sessions")
        return conns.pop(0)

    feed._connect = connect
    feed.subscribe(subs)
    used = list(conns)
    asyncio.run(asyncio.wait_for(feed.run(), 5))
    return feed, packets, urls, used


def test_client_passes_packets_and_resubscribes_after_reconnect():
    feed, packets, urls, used = run_feed([[full_packet()], [ticker_packet()]])
    assert [p["kind"] for p in packets] == ["full", "ticker"]
    assert urls[0] == "wss://api-feed.dhan.co?version=2&token=TOKEN&clientId=CID&authType=2"
    for ws in used:  # every connection re-sends the subscriptions
        assert ws.sent == [{"RequestCode": 21, "InstrumentCount": 1,
                            "InstrumentList": [{"ExchangeSegment": "NSE_FNO", "SecurityId": str(SID)}]}]
    assert "Feed connection lost" in feed.status["lastError"]
    assert feed.status["lastPacketAt"] and not feed.status["connected"]


def test_token_expired_disconnect_waits_for_new_token():
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, backoff=(0,), market_open=lambda: False)
    calls = []

    def connect(url):
        calls.append(url)
        return FakeWS([disconnect_packet(807)])

    feed._connect = connect

    async def scenario():
        task = asyncio.create_task(feed.run())
        await asyncio.sleep(0.05)
        assert feed.status["tokenExpired"] and len(calls) == 1  # no retry loop on an expired token
        feed.set_token("NEW")
        await asyncio.sleep(0.05)
        feed._stopping = True
        feed._wake.set()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())
    assert len(calls) >= 2 and "token=NEW" in calls[1]


class SilentWS(FakeWS):
    """A half-open socket: recv() never returns and never raises."""

    async def recv(self):
        if self.frames:
            return self.frames.pop(0)
        await asyncio.Event().wait()


def test_silent_socket_is_detected_logged_and_reconnected():
    events, packets, conns = [], [], [SilentWS([full_packet()]), FakeWS([ticker_packet()])]
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, on_packet=packets.append, backoff=(0,), stale_after=0.2, recv_poll=0.05,
                    market_open=lambda: True, on_event=lambda level, m: events.append(m))

    def connect(url):
        if not conns:
            feed._stopping = True
            raise ConnectionError("no more fake sessions")
        return conns.pop(0)

    feed._connect = connect
    asyncio.run(asyncio.wait_for(feed.run(), 5))
    assert [p["kind"] for p in packets] == ["full", "ticker"]  # data again after the reconnect
    assert any(m.startswith("Feed stale: no packet for") and m.endswith("reconnecting") for m in events)
    assert "Feed reconnect attempt 1 in 0 s" in events and "Feed connected again after 1 attempt" in events
    assert feed.status["reconnects"] >= 1


def test_silent_socket_outside_market_hours_is_left_alone():
    events = []
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, backoff=(0,), stale_after=0.05, recv_poll=0.02, market_open=lambda: False,
                    on_event=lambda level, m: events.append(m))
    feed._connect = lambda url: SilentWS([])

    async def scenario():
        task = asyncio.create_task(feed.run())
        await asyncio.sleep(0.3)
        assert feed.status["connected"] and not events
        feed._stopping = True
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_market_hours():
    from datetime import datetime
    from dhan_feed import IST, nse_market_open
    assert nse_market_open(datetime(2026, 10, 23, 9, 15, tzinfo=IST))
    assert nse_market_open(datetime(2026, 10, 23, 15, 29, tzinfo=IST))
    assert not nse_market_open(datetime(2026, 10, 23, 15, 30, tzinfo=IST))
    assert not nse_market_open(datetime(2026, 10, 24, 11, 0, tzinfo=IST))  # Saturday


def test_subscribe_is_idempotent_and_unsubscribe_removes():
    feed = DhanFeed("CID", "TOKEN")
    feed.subscribe([("NSE_FNO", SID), ("NSE_FNO", "52176")])
    feed.subscribe([("NSE_FNO", SID)])
    assert feed.subscriptions() == {("NSE_FNO", SID): FULL, ("NSE_FNO", 52176): FULL}
    feed.unsubscribe([("NSE_FNO", 52176)])
    assert feed.subscriptions() == {("NSE_FNO", SID): FULL}


# ---------- real capture ----------
CAPTURE = Path(__file__).with_name("fixtures") / "dhan_feed_capture.json"


@pytest.mark.skipif(not CAPTURE.exists(), reason="record fixtures/dhan_feed_capture.json with capture_feed.py")
def test_captured_frames():
    frames = [base64.b64decode(f) for f in json.loads(CAPTURE.read_text())["frames"]]
    packets = [p for f in frames for p in parse_packets(f)]
    assert packets
    for p in packets:
        if p["kind"] == "full":
            b = to_book(p)
            assert p["ltp"] > 0 and b.bids and b.asks and b.best_bid <= b.best_ask


# ---------- reconnect storm fixes (26-Oct-2026: ~1,500 drops and ~245 HTTP 429s between 06:14 and 07:50) ----------
from dhan_feed import feed_window, is_rate_limited  # noqa: E402


def test_feed_window_is_0900_to_1535_on_trading_days():
    from datetime import datetime
    from dhan_feed import IST
    mon = lambda h, m: datetime(2026, 10, 26, h, m, tzinfo=IST)  # noqa: E731
    assert [feed_window(mon(*t)) for t in ((6, 14), (8, 59), (9, 0), (15, 34), (15, 35), (23, 0))] == \
        [False, False, True, True, False, False]
    assert not feed_window(datetime(2026, 10, 24, 10, 0, tzinfo=IST))  # Saturday
    assert not feed_window(datetime(2026, 11, 10, 10, 0, tzinfo=IST))  # NSE holiday


def run_until(feed, seconds):
    async def scenario():
        task = asyncio.create_task(feed.run())
        await asyncio.sleep(seconds)
        feed._stopping = True
        feed._wake.set()
        await asyncio.wait_for(task, 2)
    asyncio.run(scenario())


def test_outside_the_window_it_never_connects_and_logs_one_idle_line():
    events, calls = [], []
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: False, idle_check=0.01, on_event=lambda lv, m: events.append(m))
    feed._connect = lambda url: calls.append(url) or FakeWS([])
    run_until(feed, 0.2)  # about 20 idle checks
    assert calls == []
    assert events == ["Feed idle until 09:00 (connects 09:00-15:35 IST on trading days)"]


def test_an_invalid_token_keeps_the_feed_idle_with_one_line():
    events, calls = [], []
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, token_ok=lambda: False, idle_check=0.01,
                    on_event=lambda lv, m: events.append(m))
    feed._connect = lambda url: calls.append(url) or FakeWS([])
    run_until(feed, 0.1)
    assert calls == [] and events == ["Feed waiting for a valid Dhan token (DH-901): send a new one (POST /api/token)"]


def test_the_window_closing_disconnects_without_reconnecting():
    open_ = [True]
    events, calls = [], []
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: open_[0], recv_poll=0.01, idle_check=0.01, backoff=(0,),
                    on_event=lambda lv, m: events.append(m))
    feed._connect = lambda url: calls.append(url) or SilentWS([])

    async def scenario():
        task = asyncio.create_task(feed.run())
        await asyncio.sleep(0.05)
        assert feed.status["connected"] and len(calls) == 1
        open_[0] = False  # 15:35
        await asyncio.sleep(0.1)
        assert not feed.status["connected"] and len(calls) == 1  # closed, no reconnect attempt
        feed._stopping = True
        feed._wake.set()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())
    assert not any(m.startswith("Feed reconnect attempt") for m in events)
    assert events[-1].startswith("Feed idle until 09:00")


def reconnect_waits(events):
    return [m.split(" in ", 1)[1] for m in events if m.startswith("Feed reconnect attempt")]


def test_a_connection_that_drops_within_10_s_keeps_the_backoff_growing():
    events = []
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, backoff=(0, 0.001, 0.002, 0.003), collapse_sec=0,
                    on_event=lambda lv, m: events.append(m))  # collapse_sec=0: every line, to read the waits
    sessions = [FakeWS([]) for _ in range(5)]  # each one drops at once ("no close frame received or sent")

    def connect(url):
        if not sessions:
            feed._stopping = True
            raise ConnectionError("no more fake sessions")
        return sessions.pop(0)

    feed._connect = connect
    asyncio.run(asyncio.wait_for(feed.run(), 5))
    assert reconnect_waits(events)[:5] == ["0 s", "0.001 s", "0.002 s", "0.003 s", "0.003 s"]
    assert [m for m in events if m.startswith("Feed reconnect attempt")][4].startswith("Feed reconnect attempt 5 ")


def test_a_connection_that_lived_long_enough_resets_the_backoff():
    events = []
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, backoff=(0, 0.001, 0.002), min_uptime=0, collapse_sec=0,
                    on_event=lambda lv, m: events.append(m))
    sessions = [FakeWS([ticker_packet()]) for _ in range(3)]

    def connect(url):
        if not sessions:
            feed._stopping = True
            raise ConnectionError("no more fake sessions")
        return sessions.pop(0)

    feed._connect = connect
    asyncio.run(asyncio.wait_for(feed.run(), 5))
    assert reconnect_waits(events)[:3] == ["0 s", "0 s", "0 s"]  # min_uptime 0: every connection counted as stable


class RateLimited(Exception):
    """What websockets raises when the handshake gets HTTP 429 (InvalidStatus: .response.status_code)."""

    def __init__(self):
        super().__init__("server rejected WebSocket connection: HTTP 429")
        self.response = type("R", (), {"status_code": 429})()


def test_http_429_waits_at_least_60_s_doubling_to_5_min():
    assert is_rate_limited(RateLimited()) and not is_rate_limited(ConnectionError("no close frame received or sent"))
    events, n = [], [0]
    feed = DhanFeed("CID", "TOKEN", in_window=lambda: True, backoff=(0,), collapse_sec=0,
                    rate_limit_backoff=(0.01, 0.02, 0.04, 0.05), on_event=lambda lv, m: events.append(m))

    def connect(url):
        n[0] += 1
        if n[0] > 5:
            feed._stopping = True
        raise RateLimited()

    feed._connect = connect
    asyncio.run(asyncio.wait_for(feed.run(), 5))
    # the real values are 60, 120, 240, 300, 300 s
    assert reconnect_waits(events)[:5] == ["0.01 s (Dhan rate limit, HTTP 429)", "0.02 s (Dhan rate limit, HTTP 429)",
                                           "0.04 s (Dhan rate limit, HTTP 429)", "0.05 s (Dhan rate limit, HTTP 429)",
                                           "0.05 s (Dhan rate limit, HTTP 429)"]
    assert feed.status["rateLimited"] >= 5


def test_repeated_feed_messages_are_collapsed_into_one_line_per_5_minutes():
    clock = [1000.0]
    events = []
    feed = DhanFeed("CID", "TOKEN", monotonic=lambda: clock[0], on_event=lambda lv, m: events.append(m))
    feed._event("warning", "Feed connection lost: no close frame received or sent")  # logged at once
    for i in range(37):
        clock[0] += 5
        feed._event("warning", "Feed connection lost: server rejected WebSocket connection: HTTP 429")
        feed._event("info", f"Feed reconnect attempt {i + 2} in 1 s")
    feed._event("warning", "Feed stale: no packet for 130 s during market hours; reconnecting")  # never collapsed
    assert events == ["Feed connection lost: no close frame received or sent",
                      "Feed reconnect attempt 2 in 1 s",
                      "Feed stale: no packet for 130 s during market hours; reconnecting"]
    clock[0] += 200  # 5 minutes after the first line
    feed._flush_repeats()
    assert events[3:] == [
        "Feed connection lost ×37 in the last 5 min (last: server rejected WebSocket connection: HTTP 429)",
        "Feed reconnect attempts ×36 in the last 5 min (last: Feed reconnect attempt 38 in 1 s)",
    ]
    feed._event("warning", "Feed connection lost: no close frame received or sent")  # a new window: logged again
    assert events[-1] == "Feed connection lost: no close frame received or sent"
