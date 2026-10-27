"""
dhan_feed.py - Dhan live market feed (WebSocket, API v2): binary packet parser + reconnecting client.

Read-only market data; it never places orders. Layout checked against the official SDK
(github.com/dhan-oss/DhanHQ-py, src/dhanhq/marketfeed.py, read 20-Oct-2026):
- URL  wss://api-feed.dhan.co?version=2&token=<token>&clientId=<id>&authType=2
- Subscribe with JSON {"RequestCode": 15|17|21, "InstrumentCount": n, "InstrumentList": [{"ExchangeSegment": "NSE_FNO",
  "SecurityId": "52175"}]}, at most 100 instruments per message. Unsubscribe = subscribe code + 1. Code 12 disconnects.
- Responses are little-endian binary; header <BHBI = response code, message length, segment, security id.
  Byte 0: 2 ticker, 4 quote, 5 OI, 6 prev close, 7 market status, 8 full, 50 server disconnect (+ u16 reason).
- Full (162 bytes): LTP f32, LTQ u16, LTT u32, avg f32, volume, total sell qty, total buy qty, OI, OI day high,
  OI day low (u32), open/close/high/low f32, then 5 depth levels <IIHHff (bid qty, ask qty, bid orders,
  ask orders, bid price, ask price).
Prices arrive as float32 and are rounded to the paisa. LTT is kept as Dhan's raw epoch value (check against a
capture whether it is UTC or IST-shifted before displaying it).
"""
import asyncio
import json
import logging
import os
import struct
import threading
import time

from datetime import datetime, time as dtime, timedelta, timezone

from holidays import NSE_HOLIDAYS
from paper_engine import Book

log = logging.getLogger("dhan_feed")

FEED_URL = "wss://api-feed.dhan.co?version=2&token={token}&clientId={client_id}&authType=2"
TICKER, QUOTE, FULL = 15, 17, 21  # subscribe request codes; unsubscribe is code + 1
DISCONNECT_REQUEST = 12
MAX_PER_MESSAGE = 100

SEGMENTS = {0: "IDX_I", 1: "NSE_EQ", 2: "NSE_FNO", 3: "NSE_CURRENCY", 4: "BSE_EQ", 5: "MCX_COMM",
            7: "BSE_CURRENCY", 8: "BSE_FNO"}
DISCONNECT_REASONS = {
    805: "Too many active WebSocket connections for this client.",
    806: "Data API subscription required.",
    807: "Access token expired.",
    808: "Invalid client ID.",
    809: "Authentication failed.",
}
TOKEN_EXPIRED = 807

_HEADER = "<BHBI"
_DEPTH = struct.Struct("<IIHHff")
# response code -> (kind, struct, field names after the header)
_PACKETS = {
    2: ("ticker", struct.Struct(_HEADER + "fI"), ("ltp", "ltt")),
    4: ("quote", struct.Struct(_HEADER + "fHIfIIIffff"),
        ("ltp", "ltq", "ltt", "avg_price", "volume", "total_sell_qty", "total_buy_qty", "open", "close", "high", "low")),
    5: ("oi", struct.Struct(_HEADER + "I"), ("oi",)),
    6: ("prev_close", struct.Struct(_HEADER + "fI"), ("prev_close", "prev_oi")),
    7: ("status", struct.Struct(_HEADER), ()),
    8: ("full", struct.Struct(_HEADER + "fHIfIIIIIIffff100s"),
        ("ltp", "ltq", "ltt", "avg_price", "volume", "total_sell_qty", "total_buy_qty", "oi", "oi_day_high",
         "oi_day_low", "open", "close", "high", "low", "depth")),
    50: ("disconnect", struct.Struct(_HEADER + "H"), ("code",)),
}
_PRICE_FIELDS = {"ltp", "avg_price", "open", "close", "high", "low", "prev_close"}


def _depth(raw):
    levels = []
    for i in range(5):
        bq, aq, bo, ao, bp, ap = _DEPTH.unpack_from(raw, i * _DEPTH.size)
        levels.append({"bid_qty": bq, "ask_qty": aq, "bid_orders": bo, "ask_orders": ao,
                       "bid_price": round(bp, 2), "ask_price": round(ap, 2)})
    return levels


def parse_packets(data):
    """Parses one WebSocket frame (one or more packets back to back) into dicts with a 'kind' key.
    Unknown or truncated packets end parsing; whatever was parsed before them is returned."""
    out, pos = [], 0
    while pos < len(data):
        spec = _PACKETS.get(data[pos])
        if spec is None:
            log.warning("unknown feed response code %s; %d bytes skipped", data[pos], len(data) - pos)
            break
        kind, st, names = spec
        if len(data) - pos < st.size:
            log.warning("truncated %s packet (%d of %d bytes)", kind, len(data) - pos, st.size)
            break
        values = st.unpack_from(data, pos)
        pkt = {"kind": kind, "segment": SEGMENTS.get(values[2], str(values[2])), "security_id": values[3]}
        for name, v in zip(names, values[4:]):
            pkt[name] = _depth(v) if name == "depth" else round(v, 2) if name in _PRICE_FIELDS else v
        if kind == "disconnect":
            pkt["reason"] = DISCONNECT_REASONS.get(pkt["code"], f"Server disconnected (code {pkt['code']}).")
        out.append(pkt)
        pos += st.size
    return out


def to_book(full):
    """Full packet -> paper_engine.Book (empty levels are dropped by Book)."""
    d = full["depth"]
    return Book(full["ltp"], bids=[(x["bid_price"], x["bid_qty"]) for x in d],
                asks=[(x["ask_price"], x["ask_qty"]) for x in d])


def subscription_messages(instruments, mode=FULL, unsubscribe=False):
    """JSON messages for [(segment, security_id)], at most 100 instruments each."""
    if mode not in (TICKER, QUOTE, FULL):
        raise ValueError("mode must be TICKER (15), QUOTE (17) or FULL (21)")
    code = mode + 1 if unsubscribe else mode
    items = list(instruments)
    return [json.dumps({"RequestCode": code, "InstrumentCount": len(batch),
                        "InstrumentList": [{"ExchangeSegment": seg, "SecurityId": str(sid)} for seg, sid in batch]})
            for batch in (items[i:i + MAX_PER_MESSAGE] for i in range(0, len(items), MAX_PER_MESSAGE))]


class FeedDisconnected(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code = code


class FeedStale(Exception):
    """No packet for too long during market hours: the connection may be half-open, so it is dropped and re-made."""


IST = timezone(timedelta(hours=5, minutes=30))
STALE_AFTER = 120  # seconds without any packet during market hours -> reconnect
RECV_POLL = 5  # seconds: recv() never waits longer than this, so a silent socket is noticed
FEED_FROM, FEED_TO = dtime(9, 0), dtime(15, 35)  # the feed connects only inside this window on trading days
IDLE_CHECK = 60  # seconds between window / token checks while idle
MIN_UPTIME = 10  # a connection that drops sooner counts as a failed attempt: the backoff keeps growing
RATE_LIMIT_BACKOFF = (60, 120, 240, 300)  # Dhan rejected the connection with HTTP 429
COLLAPSE_SEC = 300  # repeated feed messages: the first is logged, then one summary line per 5 minutes
# messages that repeat during a reconnect storm, by prefix -> the summary's label
COLLAPSE = {"Feed connection lost": "Feed connection lost", "Feed reconnect attempt": "Feed reconnect attempts",
            "Feed connected again": "Feed connected again"}


def nse_market_open(now=None):
    """09:15-15:30 IST on NSE trading days: when packets are expected for subscribed instruments."""
    now = now or datetime.now(IST)
    return (now.weekday() < 5 and now.date().isoformat() not in NSE_HOLIDAYS
            and dtime(9, 15) <= now.time() < dtime(15, 30))


def feed_window(now=None):
    """09:00-15:35 IST on NSE trading days: the only time the feed connects (Dhan drops and rate-limits
    connections outside market hours, which caused a reconnect storm on 26-Oct-2026)."""
    now = now or datetime.now(IST)
    return (now.weekday() < 5 and now.date().isoformat() not in NSE_HOLIDAYS
            and FEED_FROM <= now.time() < FEED_TO)


def is_rate_limited(e):
    """True when Dhan rejected the WebSocket handshake with HTTP 429 (websockets raises InvalidStatus /
    InvalidStatusCode; the status sits on .response.status_code or .status_code)."""
    status = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "status_code", None)
    return status == 429 or "HTTP 429" in str(e)


def _default_connect(url):
    import websockets  # imported here so the parser works without the package installed
    return websockets.connect(url, max_size=None, ping_interval=None)  # Dhan's server sends the pings


class DhanFeed:
    """Keeps one feed connection open, reconnecting with backoff, and re-subscribes everything after a reconnect.
    Runs its own asyncio loop in a daemon thread (start/stop); on_packet(pkt) is called from that thread.
    After a token-expired disconnect (807) it waits for set_token() instead of retrying.
    Watchdog: recv() is polled every recv_poll s; with no packet for stale_after s while market_open(), the connection
    is dropped and re-made with backoff (a half-open socket otherwise blocks recv() forever, silently).
    on_event(level, message) reports every disconnect, stale feed and reconnect attempt (the algo logs them); a
    message that repeats (connection lost, reconnect attempt) is logged once and then summarised every 5 minutes.
    Connects only while in_window() (09:00-15:35 IST on trading days) and token_ok() (the REST client has not seen
    DH-901). A connection that lives less than min_uptime s counts as a failed attempt; HTTP 429 waits 60 s, doubling
    up to 5 min."""

    def __init__(self, client_id=None, token=None, on_packet=None, connect=_default_connect,
                 backoff=(1, 2, 5, 10, 30), stale_after=STALE_AFTER, market_open=nse_market_open, on_event=None,
                 recv_poll=RECV_POLL, in_window=feed_window, token_ok=lambda: True, min_uptime=MIN_UPTIME,
                 rate_limit_backoff=RATE_LIMIT_BACKOFF, idle_check=IDLE_CHECK, collapse_sec=COLLAPSE_SEC,
                 monotonic=time.monotonic):
        self.client_id = client_id or os.getenv("DHAN_CLIENT_ID", "")
        self.token = token or os.getenv("DHAN_ACCESS_TOKEN", "")
        self.on_packet = on_packet or (lambda pkt: None)
        self._connect = connect
        self.backoff = backoff
        self.stale_after, self.market_open, self.recv_poll = stale_after, market_open, recv_poll
        self.on_event = on_event or (lambda level, message: None)
        self.in_window, self.token_ok, self.min_uptime = in_window, token_ok, min_uptime
        self.rate_limit_backoff, self.idle_check = rate_limit_backoff, idle_check
        self.collapse_sec, self._mono = collapse_sec, monotonic
        self._repeats = {}  # summary label -> {"since", "count", "last"} of suppressed messages
        self.status = {"connected": False, "tokenExpired": False, "lastError": "", "lastPacketAt": None,
                       "stale": False, "reconnects": 0, "connectedAt": None, "idle": "", "rateLimited": 0}
        self._subs = {}  # (segment, security_id) -> mode
        self._lock = threading.Lock()
        self._stopping = False
        self._loop = None
        self._ws = None
        self._wake = None
        self._thread = None

    # ---------- thread-safe controls ----------
    def subscribe(self, instruments, mode=FULL):
        new = []
        with self._lock:
            for key in instruments:
                key = (key[0], int(key[1]))
                if self._subs.get(key) != mode:
                    self._subs[key] = mode
                    new.append(key)
        self._send_threadsafe(subscription_messages(new, mode) if new else [])

    def unsubscribe(self, instruments):
        by_mode = {}
        with self._lock:
            for key in instruments:
                mode = self._subs.pop((key[0], int(key[1])), None)
                if mode:
                    by_mode.setdefault(mode, []).append((key[0], int(key[1])))
        for mode, keys in by_mode.items():
            self._send_threadsafe(subscription_messages(keys, mode, unsubscribe=True))

    def subscriptions(self):
        with self._lock:
            return dict(self._subs)

    def set_token(self, token):
        self.token = token.strip()
        self.status["tokenExpired"] = False
        self._wake_threadsafe()

    def resubscribe(self):
        """Sends every subscription again on the open connection (an instrument that went quiet)."""
        by_mode = {}
        for key, mode in self.subscriptions().items():
            by_mode.setdefault(mode, []).append(key)
        for mode, keys in by_mode.items():
            self._send_threadsafe(subscription_messages(keys, mode))

    def reconnect(self, reason):
        """Drops the connection; the run loop reconnects with backoff."""
        self._event("warning", f"Feed reconnect requested: {reason}")
        if self._loop and self._ws:
            asyncio.run_coroutine_threadsafe(self._ws.close(), self._loop)

    def _event(self, level, message):
        label = next((v for k, v in COLLAPSE.items() if message.startswith(k)), None)
        if label:
            now = self._mono()
            r = self._repeats.get(label)
            if r and now - r["since"] < self.collapse_sec:
                r["count"] += 1
                r["last"] = message
                return  # summarised later
            self._flush_repeats(now)
            self._repeats[label] = {"since": now, "count": 0, "last": message}
        self._emit(level, message)

    def _flush_repeats(self, now=None, force=False):
        """One line per label whose 5-minute window is over: "Feed connection lost ×37 in the last 5 min"."""
        now = self._mono() if now is None else now
        for label, r in list(self._repeats.items()):
            if force or now - r["since"] >= self.collapse_sec:
                if r["count"]:
                    detail = r["last"].split(": ", 1)[1] if ": " in r["last"] else r["last"]
                    mins = max(1, round(min(now - r["since"], self.collapse_sec) / 60))
                    self._emit("warning", f"{label} ×{r['count']} in the last {mins} min (last: {detail})")
                del self._repeats[label]

    def _emit(self, level, message):
        getattr(log, level, log.info)(message)
        try:
            self.on_event(level, message)
        except Exception:
            log.exception("feed on_event failed")

    def _idle_reason(self):
        """Why the feed should not connect now ("" = connect)."""
        if not self.in_window():
            return f"Feed idle until {FEED_FROM:%H:%M} (connects {FEED_FROM:%H:%M}-{FEED_TO:%H:%M} IST on trading days)"
        if not self.token_ok():
            return "Feed waiting for a valid Dhan token (DH-901): send a new one (POST /api/token)"
        return ""

    def start(self):
        self._thread = threading.Thread(target=lambda: asyncio.run(self.run()), name="dhan-feed", daemon=True)
        self._thread.start()

    def stop(self):
        self._stopping = True
        if self._loop and self._ws:
            asyncio.run_coroutine_threadsafe(self._close(), self._loop)
        self._wake_threadsafe()

    def _send_threadsafe(self, messages):
        if messages and self._loop and self._ws:
            asyncio.run_coroutine_threadsafe(self._send(messages), self._loop)

    def _wake_threadsafe(self):
        if self._loop and self._wake:
            self._loop.call_soon_threadsafe(self._wake.set)

    # ---------- loop ----------
    async def _send(self, messages):
        try:
            for m in messages:
                await self._ws.send(m)
        except Exception as e:  # the receive loop notices the broken connection and reconnects
            log.warning("feed send failed: %s", e)

    async def _close(self):
        try:
            await self._ws.send(json.dumps({"RequestCode": DISCONNECT_REQUEST}))
            await self._ws.close()
        except Exception:
            pass

    def _handle(self, frame):
        if isinstance(frame, str):  # text frames are not market data
            return
        for pkt in parse_packets(frame):
            if pkt["kind"] == "disconnect":
                raise FeedDisconnected(pkt["code"], pkt["reason"])
            self.status["lastPacketAt"] = time.time()
            try:
                self.on_packet(pkt)
            except Exception:
                log.exception("on_packet failed")

    async def _wait(self, seconds):
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
        except asyncio.TimeoutError:
            pass

    async def run(self):
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        attempt = 0
        limited = 0  # consecutive HTTP 429 rejections
        while not self._stopping:
            self._flush_repeats()
            if self.status["tokenExpired"] or not (self.client_id and self.token):
                if not self.status["tokenExpired"]:
                    self.status["lastError"] = "DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set"
                await self._wait(3600)
                continue
            idle = self._idle_reason()
            if idle:
                if self.status["idle"] != idle:  # one line per idle period, not one per check
                    self._flush_repeats(force=True)
                    self.status["idle"] = idle
                    self._event("info", idle)
                attempt = limited = 0
                await self._wait(self.idle_check)
                continue
            self.status["idle"] = ""
            stable = False
            try:
                async with self._connect(FEED_URL.format(token=self.token, client_id=self.client_id)) as ws:
                    self._ws = ws
                    connected_at = time.time()
                    self.status.update(connected=True, lastError="", stale=False, connectedAt=connected_at)
                    if attempt:
                        self._event("info", f"Feed connected again after {attempt} attempt{'s' if attempt > 1 else ''}")
                    by_mode = {}
                    for key, mode in self.subscriptions().items():
                        by_mode.setdefault(mode, []).append(key)
                    for mode, keys in by_mode.items():
                        await self._send(subscription_messages(keys, mode))
                    while not self._stopping:
                        try:
                            frame = await asyncio.wait_for(ws.recv(), self.recv_poll)
                        except asyncio.TimeoutError:
                            frame = None
                        if frame is not None:
                            self._handle(frame)
                        if not stable and time.time() - connected_at >= self.min_uptime:
                            stable = True  # survived: the next drop starts the backoff from the beginning
                            attempt = limited = 0
                        if not self.in_window():
                            break  # 15:35: close and go idle
                        last = max(self.status["lastPacketAt"] or 0, connected_at)
                        if self.market_open() and time.time() - last > self.stale_after:
                            raise FeedStale(f"no packet for {time.time() - last:.0f} s during market hours")
            except FeedDisconnected as e:
                self.status["lastError"] = str(e)
                if e.code == TOKEN_EXPIRED:
                    self.status["tokenExpired"] = True
                self._event("warning", f"Feed disconnected by Dhan: {e}")
            except FeedStale as e:
                self.status.update(lastError=f"Feed stale: {e}", stale=True)
                self._event("warning", f"Feed stale: {e}; reconnecting")
            except Exception as e:
                if not self._stopping:
                    if is_rate_limited(e):
                        limited += 1
                    self.status["lastError"] = f"Feed connection lost: {e or e.__class__.__name__}"
                    self._event("warning", f"Feed connection lost: {e or e.__class__.__name__}")
            finally:
                self._ws = None
                self.status["connected"] = False
            if self._stopping:
                break
            if not self.in_window():
                continue  # closed at the end of the window: no reconnect, the loop goes idle
            if not self.status["tokenExpired"]:
                wait = self.backoff[min(attempt, len(self.backoff) - 1)]
                if limited:  # HTTP 429: at least 60 s, doubling up to 5 min
                    wait = max(wait, self.rate_limit_backoff[min(limited - 1, len(self.rate_limit_backoff) - 1)])
                attempt += 1
                self.status.update(reconnects=self.status["reconnects"] + 1, rateLimited=limited)
                self._event("info", f"Feed reconnect attempt {attempt} in {wait} s"
                                    + (" (Dhan rate limit, HTTP 429)" if limited else ""))
                await self._wait(wait)
