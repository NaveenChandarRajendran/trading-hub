"""
scalper_service.py - Power Scalper: one-click MARKET orders, OCO target / stop and the Scalper's live pages. PAPER ONLY:
orders are filled by paper_engine against the live Dhan feed; nothing here can reach a Dhan order endpoint.

Orders go into the strategy picked in the page's "Trading into" selector, through the paper service's Book of that
strategy (paper_api.py): one engine per strategy, shared with Paper Trading, so funds, positions, OCO legs and the
15:15 square-off are the strategy's whichever screen placed the order. Orders placed here are stored with
source="scalper". The 15:35 daily summary (pt_daily_summary) is written by the paper service for every strategy.

Market data comes from the paper service's feed (a packet listener), so the Scalper shares the one feed connection;
what its pages show stays subscribed (set_feed_keys, Full mode for options).

WebSocket /ws/scalper?strategy=<id>
  server -> client: {"type": "snapshot", "strategyId", "meta", "account", "funds", "positions", "orders"} once (and
    after a {"type": "strategy", "id"} message), then
    "tick"   {segment, securityId, ltp, bid, ask, bidQty, askQty, oi, volume, close, open, high, low} (high / low: day)
    "candle" {segment, securityId, interval: 1, time, open, high, low, close}: the current 1-minute candle
    "volume" {segment, securityId, time, volume}: that minute's traded volume so far (options, index futures)
    "order" | "trade" | "position" | "funds" with "strategyId": the signed-in user's strategies only
    "status": feed / market status
  client -> server: {"type": "subscribe" | "unsubscribe", "instruments": [["NSE_FNO", 52175], ["IDX_I", 13]]}
                    {"type": "strategy", "id": 7}
"""
import logging
import threading
from datetime import datetime, timedelta

from candles import CandleBuilder, VolumeBuilder, parse_intraday, recent_sessions
from dhan_feed import to_book
from holidays import NSE_HOLIDAYS
from paper_engine import BUY, KEEP, MARKET, SELL
from store import IST

log = logging.getLogger("scalper")

CAPITAL_PRESETS = (50_000, 100_000, 200_000, 500_000)
FNO = "NSE_FNO"
SOURCE = "scalper"
HISTORY_TTL_OPEN, HISTORY_TTL_CLOSED = 60, 600  # seconds an option's 1-minute history is reused


class ScalperClient:
    """One /ws/scalper connection: a bounded queue filled from the feed thread, its user and the instruments it shows."""

    def __init__(self, loop, user_id=None, strategy_id=None, size=2000):
        import asyncio
        self.loop, self.queue, self.subs = loop, asyncio.Queue(size), set()
        self.user_id, self.strategy_id = user_id, strategy_id

    def push(self, msg):
        def put():
            try:
                self.queue.put_nowait(msg)
            except Exception:  # full: a stuck tab must never block the feed
                pass
        self.loop.call_soon_threadsafe(put)


class ScalperService:
    def __init__(self, store, paper, instruments, clock=lambda: datetime.now(IST), holidays=NSE_HOLIDAYS, intraday=None):
        """intraday(symbol, from, to, option_id) -> Dhan /charts/intraday payload (market data only), for option history."""
        self.store, self.paper, self.instruments, self.clock, self.holidays = store, paper, instruments, clock, holidays
        self.intraday = intraday
        self.lock = threading.RLock()
        self.clients = set()
        self.candles, self.volumes = CandleBuilder(), VolumeBuilder()
        self._history = {}  # security id -> (fetched at, 1-minute candles)
        self._history_lock = threading.Lock()
        self._feed_status = None
        self._stopping = threading.Event()
        paper.listeners.append(self.on_packet)
        paper.event_listeners.append(self.on_event)

    # ---------- lifecycle ----------
    def start(self):
        threading.Thread(target=self._run_timer, name="scalper-timer", daemon=True).start()

    def stop(self):
        self._stopping.set()

    def _run_timer(self):
        while not self._stopping.wait(1.0):
            try:
                self.tick_timer()
            except Exception:
                log.exception("scalper timer failed")

    def tick_timer(self, now=None):
        """Every second: feed / market status changes to the Scalper pages."""
        status = self.paper.feed_status()
        if status != self._feed_status:
            self._feed_status = status
            self._broadcast({"type": "status", "data": self.paper.meta()})

    # ---------- market data ----------
    def on_packet(self, pkt, now):
        """Paper service listener (feed thread): every packet of an instrument a page shows (or its user holds) goes out
        as a tick, the live 1-minute candle and its volume. Fills are the paper service's job."""
        kind, seg, sid = pkt.get("kind"), pkt.get("segment"), pkt.get("security_id")
        if kind not in ("full", "ticker", "quote"):
            return
        key = (seg, sid)
        clients = list(self.clients)
        watchers = [c for c in clients if key in c.subs]
        holders = [c for c in clients if c not in watchers and seg == FNO and sid in self.paper.held_by(c.user_id)]
        if not watchers and not holders:
            return
        tick = {"segment": seg, "securityId": sid, "ltp": pkt["ltp"]}
        for k in ("close", "open", "high", "low", "oi", "volume"):
            if pkt.get(k) is not None:
                tick[k] = pkt[k]
        if kind == "full":
            book = to_book(pkt)
            tick.update(bid=book.best_bid, ask=book.best_ask, bidQty=book.bids[0][1] if book.bids else 0,
                        askQty=book.asks[0][1] if book.asks else 0)
        out = [{"type": "tick", "data": tick}]
        candle = self.candles.on_tick(key, pkt["ltp"], now) if watchers else None
        if candle:
            out.append({"type": "candle", "data": {"segment": seg, "securityId": sid, "interval": 1, **candle}})
        vol = self.volumes.on_volume(key, pkt.get("volume"), now) if watchers and seg == FNO and kind == "full" else None
        if vol:
            out.append({"type": "volume", "data": {"segment": seg, "securityId": sid, **vol}})
        for c in watchers:
            for m in out:
                c.push(m)
        for c in holders:
            c.push(out[0])

    def on_event(self, book, kind, data):
        """Paper service account event of a strategy: to its owner's Scalper pages only."""
        msg = {"type": kind, "strategyId": book.strategy_id, "data": data}
        for c in list(self.clients):
            if c.user_id == book.user_id:
                c.push(msg)

    # ---------- websocket clients ----------
    def add_client(self, loop, user_id=None, strategy_id=None):
        c = ScalperClient(loop, user_id, strategy_id)
        with self.lock:
            self.clients.add(c)
        return c

    def remove_client(self, c):
        with self.lock:
            self.clients.discard(c)
            self._sync_feed()

    def client_subscribe(self, c, instruments, add=True):
        keys = {(str(seg), int(sid)) for seg, sid in instruments}
        with self.lock:
            c.subs = c.subs | keys if add else c.subs - keys
            self._sync_feed()

    def _broadcast(self, msg):
        for c in list(self.clients):
            c.push(msg)

    def _sync_feed(self):
        """What the Scalper pages show (the books keep their own positions and orders subscribed)."""
        keys = set()
        for c in list(self.clients):
            keys |= c.subs
        try:
            self.paper.set_feed_keys(SOURCE, keys)
        except Exception as e:
            log.warning("scalper feed keys: %s", e)

    def history(self, security_id):
        """1-minute candles (with volume) of one option for today and the previous session, from Dhan's intraday
        history (market data only), cached HISTORY_TTL_OPEN s in market hours. Raises LookupError for an unknown id."""
        inst = self.paper._instrument(security_id)
        if inst is None:
            raise LookupError(f"{security_id} is not a NIFTY / BANKNIFTY option in Dhan's instrument list")
        if self.intraday is None:
            raise RuntimeError("option history is not available (no Dhan client)")
        now = self.clock()
        ttl = HISTORY_TTL_OPEN if self.paper.market_open(now) else HISTORY_TTL_CLOSED
        with self._history_lock:  # one Dhan call serves every tab asking at the same time
            hit = self._history.get(security_id)
            if hit and (now - hit[0]).total_seconds() < ttl:
                return inst, hit[1]
            sessions = recent_sessions(now.date(), holidays=self.holidays)
            # Dhan's toDate is exclusive by date: ask up to the day after the last session (dashboard_api.py)
            frm, to = f"{sessions[0]} 09:15:00", f"{sessions[-1] + timedelta(days=1)} 09:15:00"
            candles = parse_intraday(self.intraday(inst["symbol"], frm, to, security_id))
            self._history[security_id] = (now, candles)
            return inst, candles

    # ---------- state (book = the paper service's Book of the picked strategy) ----------
    def meta(self, book=None):
        return self.paper.meta(book)

    def snapshot(self, book=None):
        if book is None:
            return {"type": "snapshot", "strategyId": None, "meta": self.paper.meta()}
        with self.paper.lock:
            return {"type": "snapshot", "strategyId": book.strategy_id, "meta": self.paper.meta(book),
                    "account": book.account, "funds": self.paper.funds(book), "positions": self.paper.positions(book),
                    "orders": self.paper.orders(book)}

    # ---------- commands ----------
    def place_order(self, book, security_id, side, lots):
        """MARKET BUY / SELL in one click. A SELL only closes an open long (engine rule). Returns the order."""
        if side not in (BUY, SELL):
            raise ValueError("side must be BUY or SELL")
        return self.paper.place_order(book, security_id, side, lots, MARKET, source=SOURCE)

    def exit_position(self, book, security_id):
        self.paper.exit_position(book, security_id, source=SOURCE)

    def exit_all(self, book):
        self.paper.exit_all(book, source=SOURCE)

    def set_protection(self, book, security_id, target=KEEP, stop=KEEP):
        return self.paper.set_protection(book, security_id, target=target, stop=stop, source=SOURCE)

    def exit_partial(self, book, security_id, pct):
        self.paper.exit_partial(book, security_id, pct, source=SOURCE)

    def set_trail(self, book, security_id, distance, step=1.0, after=None):
        return self.paper.set_trail(book, security_id, distance, step, after, source=SOURCE)


def default_range(today, days=30):
    return (today - timedelta(days=days)).isoformat(), today.isoformat()
