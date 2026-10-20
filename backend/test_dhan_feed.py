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
    feed = DhanFeed("CID", "TOKEN", on_packet=packets.append, backoff=(0,))

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
    feed = DhanFeed("CID", "TOKEN", backoff=(0,))
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
