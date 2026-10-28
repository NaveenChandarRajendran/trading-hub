"""
paper_api.py - paper trading service + routes (/api/paper/*, /ws/paper). SIMULATION ONLY: orders are filled by
paper_engine against the live Dhan feed; nothing here calls a Dhan order endpoint.

One Book per strategy (users and strategies, docs/users-and-strategies.md): the strategy's open capital period
(pt_accounts row) and its PaperEngine for the IST trading day. Paper Trading and Power Scalper both trade through these
books, so a strategy has ONE set of funds, positions, OCO legs and one 15:15 square-off whichever screen placed the
order. Every engine event is written to the store and pushed only to the WebSocket connections of the strategy's
owner; market data (ticks, candles, volume) is shared. A timer runs the 15:15 square-off, the day roll-over and the
15:35 daily summary (pt_daily_summary) of every book, so stop-losses and the square-off work while the browser is
closed (the backend must run). The algo trades into its own strategy through algo_service.AlgoBroker.

Every /api/paper route that touches an account takes ?strategy=<id> (the signed-in user's own; 404 otherwise).
Orders need an active manual strategy.

WebSocket /ws/paper?strategy=<id>   (strategy optional: the Dashboard only wants candles)
  server -> client: {"type": "status"|"tick"|"candle"|"volume", "data": {...}}
                    {"type": "funds"|"order"|"trade"|"position", "strategyId": 7, "data": {...}}  (owner only)
  "candle": the current 1-minute candle of a subscribed index (IDX_I), built from its ticks (candles.py), for the
  Dashboard chart: {"segment", "securityId", "interval": 1, "time", "open", "high", "low", "close"}
  "volume": the current minute's volume of a subscribed index future (the chart's volume bars):
  {"segment", "securityId", "time", "volume"}
                    plus {"type": "snapshot", "strategyId", ...} right after connecting and after a "strategy" message
  client -> server: {"type": "subscribe" | "unsubscribe", "instruments": [["NSE_FNO", 52175], ["IDX_I", 13]]}
                    {"type": "strategy", "id": 7}   switch the strategy the snapshot is for
The backend always keeps open positions and pending orders subscribed, whatever the clients ask for.
"""
import asyncio
import logging
import threading
from datetime import date as Date
from datetime import datetime, time, timedelta

from fastapi import HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from candles import CandleBuilder, VolumeBuilder
from dhan_client import SCRIP as SPOT_IDS  # index security IDs on the feed (IDX_I): NIFTY 13, BANKNIFTY 25
from dhan_feed import FULL, TICKER, to_book
from holidays import NSE_HOLIDAYS
from paper_charges import RATES as CHARGE_RATES
from paper_engine import KEEP, OPEN_STATES, OrderError, PaperEngine
from paper_levels import opening_order, order_snapshot, shifts_near
from scalper_reports import day_rows, round_trips, summary_row, tiles
from store import IST

log = logging.getLogger("paper")

DEFAULT_CAPITAL = 100_000
CAPITAL_PRESETS = (100_000, 200_000, 500_000)
MIN_CAPITAL, MAX_CAPITAL = 10_000, 10_00_00_000  # Rs 10k .. Rs 10 crore
FNO = "NSE_FNO"
IDX = "IDX_I"
SESSION_CLOSE = (15, 30)
SUMMARY_AT = time(15, 35)  # pt_daily_summary of every book with fills
CLIENT_QUEUE = 2000  # messages buffered per WebSocket client; ticks are dropped first when it is full
SHIFT_CHECK_SEC = 20  # how often open positions are checked for new S/R level shifts
ACCOUNT_EVENTS = ("order", "trade", "position", "funds")


def now_ist():
    return datetime.now(IST)


class _Client:
    def __init__(self, loop, user_id=None, strategy_id=None):
        self.loop = loop
        self.queue = asyncio.Queue(CLIENT_QUEUE)
        self.subs = set()  # {(segment, security_id)}
        self.user_id, self.strategy_id = user_id, strategy_id

    def push(self, msg):
        def put():
            try:
                self.queue.put_nowait(msg)
            except asyncio.QueueFull:
                pass  # a stuck browser tab must not block the engine
        self.loop.call_soon_threadsafe(put)


class Book:
    """One strategy's paper trading state for the IST day. Use only with PaperService.lock held."""

    def __init__(self, strategy, account):
        self.strategy_id, self.user_id, self.name = strategy["id"], strategy["user_id"], strategy["name"]
        self.account = dict(account)
        self.engine, self.day = None, None
        self.order_levels = {}  # order id -> pt_order_levels row, today
        self.shift_ids = {}  # security id -> level shift ids last sent, to push a position when a new shift appears
        self.traded = set()  # instruments an order was tried on today (kept subscribed)
        self.sources = {}  # order id -> "manual" | "scalper": which screen placed it
        self.unsaved = []  # (kind, day, data) whose store write failed; retried on the next write
        self.last_error = ""
        self.summary_day = None

    def busy(self):
        e = self.engine
        return any(p.open_qty > 0 for p in e.positions.values()) or any(o.status in OPEN_STATES for o in e.orders.values())

    def held_ids(self):
        e = self.engine
        return ({sid for sid, p in e.positions.items() if p.open_qty > 0}
                | {o.security_id for o in e.orders.values() if o.status in OPEN_STATES})


class PaperService:
    def __init__(self, store, feed, instruments, clock=now_ist, holidays=NSE_HOLIDAYS, levels=None):
        self.store, self.feed, self.instruments, self.clock, self.holidays = store, feed, instruments, clock, holidays
        self.levels = levels  # paper_levels.TrackerLevels: S/R levels saved with each order (optional)
        self.calendar = PaperEngine(1.0, holidays=holidays)  # trading days / order hours only (no account)
        self._next_shift_check = None
        self.listeners = []  # fn(pkt, now) for every market packet (the algo, the Scalper's pages)
        self.event_listeners = []  # fn(book, kind, data) for every account event (the /ws/scalper clients)
        self._extra_subs = {}  # owner -> feed keys kept subscribed for it (the algo's indices and options)
        self.lock = threading.RLock()
        self.clients = set()
        self.books = {}  # strategy id -> Book
        self._feed_subs = set()
        self._feed_status = None
        self._timer = None
        self._stopping = threading.Event()
        self.candles = CandleBuilder()  # current 1-minute candle per subscribed index, for the Dashboard chart
        self.volumes = VolumeBuilder()  # current minute's volume per subscribed index future, same chart
        feed.on_packet = self.on_packet
        with self.lock:  # every active manual strategy, so stops and the square-off run after a restart
            for st in self.store.all_strategies():
                if st["kind"] == "manual" and not st["archived_at"] and st["account_id"]:
                    self._load(st)
            self._sync_feed()

    # ---------- books ----------
    def _load(self, st):
        acc = next(a for a in self.store.accounts() if a["id"] == st["account_id"])
        book = self.books[st["id"]] = Book(st, acc)
        self._ensure_day(book, self.clock())
        return book

    def book(self, strategy):
        """The Book of a strategy dict (strategies.Strategies has checked the owner). Manual strategies only."""
        with self.lock:
            b = self.books.get(strategy["id"])
            if b is None or b.account["id"] != strategy["account_id"]:
                b = self._load(strategy)
                self._sync_feed()
            return b

    def busy(self, strategy):
        """Open position or pending order today (strategies.Strategies asks before capital changes / archive)."""
        with self.lock:
            b = self.books.get(strategy["id"])
            if b is not None:
                return b.busy()
        day = self.clock().date().isoformat()
        return bool(strategy["account_id"]) and self.store.book_open(strategy["account_id"], day)

    def reload(self, strategy):
        """After a capital change, reset or archive: the next use loads the strategy's open period again."""
        with self.lock:
            old = self.books.pop(strategy["id"], None)
            if strategy["kind"] == "manual" and not strategy["archived_at"] and strategy["account_id"]:
                b = self._load(strategy)
                if old and old.engine:  # keep the last prices
                    b.engine.books = dict(old.engine.books)
                self._send(b, "funds", self.funds(b))
            self._sync_feed()

    def _ensure_day(self, book, now):
        today = now.date()
        if book.day == today:
            return
        acc, day = book.account["id"], today.isoformat()
        opening = book.account["capital"] + self.store.net_before(acc, day)
        engine = PaperEngine(max(opening, 0.01), holidays=self.holidays, day=today)
        orders = self.store.orders(acc, day)
        engine.restore(orders, self.store.trades(acc, day))
        if book.engine:  # keep the last prices across a day change
            engine.books = dict(book.engine.books)
        book.engine, book.day = engine, today
        book.sources = {o["id"]: o.get("source") or "manual" for o in orders}
        book.order_levels = {r["order_id"]: r for r in self.store.order_levels(acc, day)}
        book.shift_ids, book.traded = {}, set()

    # ---------- lifecycle ----------
    def start(self):
        self.feed.start()
        self._timer = threading.Thread(target=self._run_timer, name="paper-timer", daemon=True)
        self._timer.start()

    def stop(self):
        self._stopping.set()
        self.feed.stop()

    def _run_timer(self):
        while not self._stopping.wait(1.0):
            try:
                self.tick_timer()
            except Exception:
                log.exception("paper timer failed")

    def tick_timer(self, now=None):
        """Every second: day roll-over, 15:15 square-off and the 15:35 summary of every book, feed status changes."""
        now = now or self.clock()
        with self.lock:
            shifts = self._next_shift_check is None or now >= self._next_shift_check
            if shifts:
                self._next_shift_check = now + timedelta(seconds=SHIFT_CHECK_SEC)
            for b in list(self.books.values()):
                self._ensure_day(b, now)
                self._publish(b, b.engine.on_time(now))
                if shifts:
                    self._push_new_shifts(b)
                if (self.calendar.is_trading_day(now) and now.time() >= SUMMARY_AT and b.summary_day != now.date()):
                    b.summary_day = now.date()
                    if b.engine.trades:
                        self.write_summary(b, now.date().isoformat())
        status = self.feed_status()
        if status != self._feed_status:
            self._feed_status = status
            self._broadcast({"type": "status", "data": self.meta()})

    # ---------- state ----------
    def market_open(self, now=None):
        now = now or self.clock()
        t = (now.hour, now.minute)
        return self.calendar.is_trading_day(now) and (9, 15) <= t < SESSION_CLOSE

    def feed_status(self):
        s = self.feed.status
        return (s.get("connected"), s.get("tokenExpired"), s.get("lastError"))

    def meta(self, book=None, message=""):
        now = self.clock()
        fs = self.feed.status
        last = fs.get("lastPacketAt")
        if not message:
            if fs.get("tokenExpired"):
                message = "Dhan token expired. POST a new one to /api/token."
            elif not self.market_open(now):
                message = "Market closed. Showing the last session."
            elif not fs.get("connected"):
                message = "Live feed not connected; reconnecting."
        m = {"asOf": now.strftime("%Y-%m-%d %H:%M:%S"), "marketOpen": self.market_open(now),
             "acceptingOrders": self.calendar.accepting_orders(now), "tokenExpired": bool(fs.get("tokenExpired")),
             "feedConnected": bool(fs.get("connected")),
             "lastTickAt": datetime.fromtimestamp(last, IST).strftime("%H:%M:%S") if last else None,
             "lastError": (book.last_error if book else "") or fs.get("lastError") or "", "message": message}
        if book:
            m.update(strategyId=book.strategy_id, strategy=book.name)
        return m

    def funds(self, book):
        f = book.engine.funds()
        f["startingCapital"] = book.account["capital"]
        f["openingBalance"] = f.pop("capital")
        f["unrealized"] = book.engine.unrealized()
        f["dayPnl"] = round(f["realized"] - f["charges"] + f["unrealized"], 2)
        return f

    def _instrument(self, security_id):
        try:
            return self.instruments.get(security_id)
        except Exception as e:
            log.warning("instrument lookup failed: %s", e)
            return None

    def _with_instrument(self, d):
        inst = self._instrument(d["security_id"]) or {}
        return {**d, "name": inst.get("name", str(d["security_id"])), "symbol": inst.get("symbol"),
                "optionType": inst.get("optionType"), "strike": inst.get("strike"), "expiry": inst.get("expiry")}

    def _position(self, book, sid, p):
        t, s = book.engine.protection(sid)
        trail = ({"distance": s.trail_distance, "step": s.trail_step, "after": s.trail_after, "high": s.trail_high}
                 if s and s.trail_distance else None)
        pos = self._with_instrument({**p.to_dict(book.engine._ltp(sid)), "trail": trail,
                                     "target": t.price if t else None, "targetOrderId": t.id if t else None,
                                     "stop": s.trigger_price if s else None, "stopOrderId": s.id if s else None})
        return self._with_zone(book, pos)

    def positions(self, book):
        with self.lock:
            return [self._position(book, sid, p) for sid, p in book.engine.positions.items()]

    # ---------- S/R levels at entry (paper_levels.py; information only, never exits) ----------
    def _with_zone(self, book, pos):
        """Adds entryZone (the level nearest spot when the opening BUY was placed) and levelShifts (levels within
        100 pts of it that moved since) to an open position. Call with self.lock held."""
        pos = {**pos, "entryZone": None, "levelShifts": []}
        if pos["open_qty"] <= 0:
            book.shift_ids.pop(pos["security_id"], None)
            return pos
        opener = opening_order([t.to_dict() for t in book.engine.trades], pos["security_id"])
        lv = book.order_levels.get(opener)
        if not lv or not lv["zone"]:
            return pos
        pos["entryZone"] = {**lv["zone"], "symbol": lv["symbol"], "expiry": lv["expiry"], "spot": lv["spot"],
                            "at": lv["levelsAt"], "orderId": opener}
        try:
            changes = self.levels.changes(lv["symbol"], lv["expiry"], lv["date"]) if self.levels else []
        except Exception as e:  # level history unreadable: the zone still shows
            log.warning("level history for %s %s: %s", lv["symbol"], lv["expiry"], e)
            changes = []
        pos["levelShifts"] = shifts_near(changes, lv["zone"], lv["levelsAt"])
        book.shift_ids[pos["security_id"]] = [s["id"] for s in pos["levelShifts"]]
        return pos

    def _push_new_shifts(self, book):
        """Levels are recorded every minute by the tracker: push a position again when its shifts changed."""
        if not self.levels:
            return
        for sid, p in book.engine.positions.items():
            if p.open_qty <= 0:
                continue
            before = book.shift_ids.get(sid)
            pos = self._position(book, sid, p)
            if before is not None and [s["id"] for s in pos["levelShifts"]] != before:
                self._send(book, "position", pos)

    def _save_order_levels(self, book, order, inst, now):
        """Keeps the index's current S/R levels with the order. Never blocks the order."""
        if not self.levels or not order.get("id"):
            return
        try:
            snap = self.levels.snapshot(inst["symbol"], inst["expiry"])
        except Exception as e:
            log.warning("S/R levels for order %s: %s", order["id"], e)
            return
        if snap:
            row = order_snapshot(order["id"], snap, now.isoformat())
            book.order_levels[order["id"]] = row
            book.unsaved.append(("levels", book.day.isoformat(), row))

    def orders(self, book, day=None):
        with self.lock:
            if day in (None, book.day.isoformat()):
                rows = [o.to_dict() for o in sorted(book.engine.orders.values(), key=lambda o: o.created_at)]
                rows = [{**o, "source": book.sources.get(o["id"], "manual")} for o in rows]
            else:
                rows = self.store.orders(book.account["id"], day)
        return [self._with_instrument(o) for o in rows]

    def trades(self, book, day=None):
        """Fills of a day of the strategy's open capital period (today from the engine)."""
        with self.lock:
            if day in (None, book.day.isoformat()):
                rows = [t.to_dict() for t in book.engine.trades]
            else:
                rows = self.store.trades(book.account["id"], day)
        return [self._with_instrument(t) for t in rows]

    def pnl(self, account_ids, from_day, to_day):
        """Day P&L of one or more capital periods (pt_accounts ids) added up per day: the P&L calendar's rows."""
        days = {}
        for acc in account_ids:
            for r in self.store.day_summary(acc, from_day, to_day):
                d = days.setdefault(r["date"], {"date": r["date"], "realized": 0.0, "charges": 0.0, "trades": 0})
                d["realized"], d["charges"] = d["realized"] + r["realized"], d["charges"] + r["charges"]
                d["trades"] += r["trades"]
        rows = [{**d, "realized": round(d["realized"], 2), "charges": round(d["charges"], 2)}
                for _, d in sorted(days.items())]
        for r in rows:
            r["net"] = round(r["realized"] - r["charges"], 2)
        return rows

    # ---------- reports (round trips: scalper_reports.py) ----------
    def _trips_by_day(self, book, from_day, to_day):
        fills = [self._with_instrument(t) for t in self.store.trades_between(book.account["id"], from_day, to_day)]
        by_day = {}
        for t in fills:
            by_day.setdefault(t["date"], []).append(t)
        return {d: round_trips(rows) for d, rows in by_day.items()}

    def reports(self, book, from_day, to_day):
        """Tiles + day-wise table of a strategy's open capital period for a date range."""
        trips = self._trips_by_day(book, from_day, to_day)
        days = day_rows(self.store.day_summary(book.account["id"], from_day, to_day),
                        {d: closed for d, (closed, _open) in trips.items()})
        all_closed = [t for closed, _open in trips.values() for t in closed]
        return {"tiles": tiles(days, all_closed), "days": days}

    def day_view(self, book, day):
        """One day: its round trips (closed and still open) and every fill."""
        fills = [self._with_instrument(t) for t in self.store.trades_between(book.account["id"], day, day)]
        closed, still_open = round_trips(fills)
        row = next(iter(day_rows(self.store.day_summary(book.account["id"], day, day), {day: closed})), None)
        return {"date": day, "day": row, "trades": closed, "open": still_open, "fills": fills}

    def write_summary(self, book, day):
        """pt_daily_summary row of a strategy for a day (15:35 IST, or on demand)."""
        view = self.day_view(book, day)
        row = {**summary_row(book.account["id"], day, view["day"], view["trades"]), "strategy_id": book.strategy_id}
        try:
            self.store.save_daily_summary(row)
        except Exception as e:
            book.last_error = f"Daily summary not saved: {e}"
            log.warning("daily summary of strategy %s: %s", book.strategy_id, e)
        return row

    # ---------- persistence + broadcast ----------
    def _publish(self, book, events, source=None):
        """Stores and sends engine events (to the strategy's owner only). Call with self.lock held."""
        if not events:
            return
        day = book.day.isoformat()
        for ev in events:
            data = ev.data
            if ev.kind == "order":
                if data["id"] not in book.sources:
                    book.sources[data["id"]] = source or "manual"
                data = {**data, "source": book.sources[data["id"]]}
            book.unsaved.append((ev.kind, day, data))
        self._flush(book)
        for ev in events:
            data = self._with_instrument(ev.data)
            if ev.kind == "position":
                data = self._position(book, ev.data["security_id"], book.engine.positions[ev.data["security_id"]])
            elif ev.kind == "order":
                data = {**data, "source": book.sources.get(data["id"], "manual")}
            self._send(book, ev.kind, data)
        # an order change without a position event (a target / stop placed, moved or cancelled) still changes the
        # position's target / stop: send the position again
        sent = {ev.data["security_id"] for ev in events if ev.kind == "position"}
        for sid in dict.fromkeys(ev.data["security_id"] for ev in events if ev.kind == "order"):
            if sid not in sent and sid in book.engine.positions:
                self._send(book, "position", self._position(book, sid, book.engine.positions[sid]))
        self._send(book, "funds", self.funds(book))
        self._sync_feed()

    def _flush(self, book):
        acc = book.account["id"]
        save = {"order": self.store.save_order, "trade": self.store.save_trade, "position": self.store.save_position,
                "levels": self.store.save_order_levels}
        while book.unsaved:
            kind, day, data = book.unsaved[0]
            try:
                save[kind](acc, day, data)
            except Exception as e:
                book.last_error = f"Database write failed, will retry: {e}"
                log.warning("paper store write failed: %s", e)
                return
            book.unsaved.pop(0)
        book.last_error = ""

    def _send(self, book, kind, data):
        """An account event: only to the owner's connections (and the owner's Scalper pages via event_listeners)."""
        msg = {"type": kind, "strategyId": book.strategy_id, "data": data}
        for c in list(self.clients):
            if c.user_id == book.user_id:
                c.push(msg)
        for fn in list(self.event_listeners):
            try:
                fn(book, kind, data)
            except Exception:
                log.exception("account event listener failed")

    def _broadcast(self, msg):
        for c in list(self.clients):
            c.push(msg)

    def held_by(self, user_id):
        """Instrument ids an owner's books hold (their ticks go to that owner's pages)."""
        out = set()
        with self.lock:
            for b in list(self.books.values()):
                if b.user_id == user_id and b.engine:
                    out |= b.held_ids()
        return out

    def _sync_feed(self):
        """Feed subscriptions = what the clients show + every book's open positions, pending orders and tries."""
        need = set()
        for b in self.books.values():
            if b.engine:
                need |= {(FNO, sid) for sid in b.held_ids()} | b.traded
        for c in list(self.clients):
            need |= c.subs
        for keys in self._extra_subs.values():
            need |= keys
        add, drop = need - self._feed_subs, self._feed_subs - need
        for mode in (FULL, TICKER):
            keys = [k for k in add if (k[0] == FNO) == (mode == FULL)]
            if keys:
                self.feed.subscribe(keys, mode)
        if drop:
            self.feed.unsubscribe(list(drop))
        self._feed_subs = need

    def set_feed_keys(self, owner, keys):
        """Keeps these (segment, security id) keys subscribed for `owner` (e.g. the algo), whatever the pages ask for."""
        keys = {tuple(k) for k in keys}
        with self.lock:
            if self._extra_subs.get(owner) != keys:
                self._extra_subs[owner] = keys
                self._sync_feed()

    # ---------- market data ----------
    def on_packet(self, pkt):
        """Called from the feed thread for every packet."""
        if pkt["kind"] not in ("full", "ticker", "quote"):
            return
        key, now = (pkt["segment"], pkt["security_id"]), self.clock()
        tick = {"segment": key[0], "securityId": key[1], "ltp": pkt["ltp"]}
        held_users = set()
        if pkt["kind"] == "full":
            book = to_book(pkt)
            tick.update(bid=book.best_bid, ask=book.best_ask, bidQty=book.bids[0][1] if book.bids else 0,
                        askQty=book.asks[0][1] if book.asks else 0, oi=pkt["oi"], volume=pkt["volume"],
                        close=pkt["close"])
            if key[0] == FNO:
                with self.lock:
                    for b in list(self.books.values()):
                        self._ensure_day(b, now)
                        self._publish(b, b.engine.on_tick(key[1], book, now))
                        if key[1] in b.engine.positions:
                            held_users.add(b.user_id)
        msg = {"type": "tick", "data": tick}
        for c in list(self.clients):
            if key in c.subs or (key[0] == FNO and c.user_id in held_users):
                c.push(msg)
        if key[0] == FNO and pkt["kind"] == "full" and key[1] in self.instruments.future_ids():
            vol = self.volumes.on_volume(key, pkt.get("volume"), now)
            if vol:
                vmsg = {"type": "volume", "data": {"segment": key[0], "securityId": key[1], **vol}}
                for c in list(self.clients):
                    if key in c.subs:
                        c.push(vmsg)
        if key[0] == IDX:
            candle = self.candles.on_tick(key, pkt["ltp"], now)
            if candle:
                cmsg = {"type": "candle", "data": {"segment": key[0], "securityId": key[1], "interval": 1, **candle}}
                for c in list(self.clients):
                    if key in c.subs:
                        c.push(cmsg)
        for fn in list(self.listeners):
            try:
                fn(pkt, now)
            except Exception:
                log.exception("packet listener failed")

    # ---------- commands (book = the strategy's Book; strategies.Strategies.tradable checked owner + kind) ----------
    def place_order(self, book, security_id, side, lots, order_type, price=None, trigger_price=None, source="manual"):
        inst = self._instrument(security_id)
        if inst is None:
            raise LookupError(f"{security_id} is not a NIFTY / BANKNIFTY option in Dhan's instrument list")
        now = self.clock()
        with self.lock:
            self._ensure_day(book, now)
            if (FNO, security_id) not in book.traded:  # keep it subscribed for the day, so the next try has a price
                book.traded.add((FNO, security_id))
                self._sync_feed()
            order, events = book.engine.place_order(security_id, side, lots, inst["lotSize"], order_type, now,
                                                    price=price, trigger_price=trigger_price)
            book.sources[order.id] = source
            self._save_order_levels(book, order.to_dict(), inst, now)  # before the events: the position shows its zone
            self._publish(book, events, source)
            self._flush(book)
            return self._with_instrument({**order.to_dict(), "source": source})

    def modify_order(self, book, order_id, **changes):
        with self.lock:
            self._known(book, order_id)
            self._publish(book, book.engine.modify_order(order_id, self.clock(), **changes))
            return self._with_instrument(book.engine.orders[order_id].to_dict())

    def cancel_order(self, book, order_id):
        with self.lock:
            self._known(book, order_id)
            self._publish(book, book.engine.cancel_order(order_id, self.clock()))
            return self._with_instrument(book.engine.orders[order_id].to_dict())

    @staticmethod
    def _known(book, order_id):
        if order_id not in book.engine.orders:
            raise LookupError(f"No order {order_id} today")

    def exit_position(self, book, security_id, source="manual"):
        with self.lock:
            self._publish(book, book.engine.exit_position(security_id, self.clock()), source)

    def exit_all(self, book, source="manual"):
        with self.lock:
            self._publish(book, book.engine.exit_all(self.clock()), source)

    def exit_partial(self, book, security_id, pct, source="manual"):
        """Sells pct (25 / 50 / 75 / 100) of a position's open lots at market (paper_engine.exit_partial)."""
        with self.lock:
            self._publish(book, book.engine.exit_partial(security_id, pct, self.clock()), source)

    def set_trail(self, book, security_id, distance, step=1.0, after=None, source="scalper"):
        """Trailing stop on (distance in points) or off (None) for a position (paper_engine.set_trail)."""
        with self.lock:
            self._publish(book, book.engine.set_trail(security_id, self.clock(), distance, step, after), source)
            return next(p for p in self.positions(book) if p["security_id"] == security_id)

    def set_protection(self, book, security_id, target=KEEP, stop=KEEP, source="scalper"):
        """Target / stop of an open position as an OCO pair (None cancels a leg, KEEP leaves it)."""
        with self.lock:
            self._publish(book, book.engine.set_protection(security_id, self.clock(), target=target, stop=stop), source)
            return next(p for p in self.positions(book) if p["security_id"] == security_id)

    # ---------- websocket clients ----------
    def add_client(self, loop, user_id=None, strategy_id=None):
        c = _Client(loop, user_id, strategy_id)
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

    def snapshot(self, book=None):
        with self.lock:
            if book is None:
                return {"type": "snapshot", "strategyId": None, "meta": self.meta()}
            return {"type": "snapshot", "strategyId": book.strategy_id, "meta": self.meta(book),
                    "funds": self.funds(book), "positions": self.positions(book), "orders": self.orders(book)}


# ======================================================================= routes
class CapitalBody(BaseModel):
    capital: float


class ResetBody(BaseModel):
    capital: float | None = None


class OrderBody(BaseModel):
    securityId: int
    side: str
    lots: int
    orderType: str
    price: float | None = None
    triggerPrice: float | None = None
    attach: dict | None = None


class ModifyBody(BaseModel):
    lots: int | None = None
    price: float | None = None
    triggerPrice: float | None = None


def _day(value, name):
    if not value:
        return None
    try:
        return Date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(400, f"{name} must be YYYY-MM-DD")


def resolve(strategies, request, value, trade=False, manual=True):
    """?strategy=<id> -> the signed-in user's strategy dict. trade: must take orders (active, manual). manual: needs a
    paper Book (the algo's strategy is shown by the algo pages). Someone else's strategy is 404, like a missing one."""
    from strategies import NotFound, Refused
    if not value:
        raise HTTPException(400, "Pick a strategy (?strategy=<id>).")
    try:
        st = (strategies.tradable if trade else strategies.get)(request.state.user, value)
    except NotFound:
        raise HTTPException(404, "Strategy not found.") from None
    except Refused as e:
        raise HTTPException(e.status, e.message) from None
    if manual and st["kind"] != "manual":
        raise HTTPException(400, "The algo's strategy is shown in Algo (paper).")
    return st


def strategy_accounts(svc, strategies, request, value):
    """?strategy=<id> | all -> pt_accounts ids (every capital period) of that strategy or of all the user's ones."""
    if (value or "").lower() == "all":
        ids = {s["id"] for s in strategies.store.strategies(request.state.user.id)}
    else:
        ids = {resolve(strategies, request, value, manual=False)["id"]}
    return [a["id"] for a in svc.store.accounts() if a.get("strategy_id") in ids]


def register(app, svc, strategies):
    """Adds the paper trading routes to the FastAPI app (called from main.create_app)."""
    from strategies import NotFound, Refused, public

    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except OrderError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    def book(request, strategy, trade=False):
        return svc.book(resolve(strategies, request, strategy, trade))

    def account_body(request, strategy):
        st = resolve(strategies, request, strategy)
        b = svc.book(st)
        return {"meta": svc.meta(b), "strategy": public(st), "account": b.account, "funds": svc.funds(b),
                "presets": list(CAPITAL_PRESETS), "chargeRates": CHARGE_RATES}

    def capital(fn, request, strategy, *args):
        try:
            fn(request.state.user, strategy, *args)
        except NotFound:
            raise HTTPException(404, "Strategy not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None
        return account_body(request, strategy)

    @app.get("/api/paper/account")
    def get_account(request: Request, strategy: str = ""):
        return account_body(request, strategy)

    @app.post("/api/paper/account")
    def set_capital(body: CapitalBody, request: Request, strategy: str = ""):
        resolve(strategies, request, strategy)
        return capital(strategies.set_capital, request, strategy, body.capital)

    @app.post("/api/paper/account/reset")
    def reset(request: Request, strategy: str = "", body: ResetBody | None = None):
        resolve(strategies, request, strategy)
        return capital(strategies.reset, request, strategy, body.capital if body else None)

    @app.post("/api/paper/orders")
    def place(body: OrderBody, request: Request, strategy: str = ""):
        if body.attach:
            raise HTTPException(400, "attached SL / target is not available yet")
        b = book(request, strategy, trade=True)
        o = run(svc.place_order, b, body.securityId, body.side.upper(), body.lots, body.orderType.upper(),
                price=body.price, trigger_price=body.triggerPrice)
        return {"id": o["id"], "status": o["status"], "qty": o["qty"], "reason": o["reason"], "order": o}

    @app.put("/api/paper/orders/{order_id}")
    def modify(order_id: str, body: ModifyBody, request: Request, strategy: str = ""):
        return run(svc.modify_order, book(request, strategy, trade=True), order_id, lots=body.lots, price=body.price,
                   trigger_price=body.triggerPrice)

    @app.delete("/api/paper/orders/{order_id}")
    def cancel(order_id: str, request: Request, strategy: str = ""):
        return run(svc.cancel_order, book(request, strategy, trade=True), order_id)

    @app.get("/api/paper/orders")
    def orders(request: Request, strategy: str = "", date: str = ""):
        b = book(request, strategy)
        return {"meta": svc.meta(b), "rows": svc.orders(b, _day(date, "date"))}

    def positions_body(b):
        return {"meta": svc.meta(b), "rows": svc.positions(b), "funds": svc.funds(b)}

    @app.get("/api/paper/positions")
    def positions(request: Request, strategy: str = ""):
        return positions_body(book(request, strategy))

    @app.post("/api/paper/positions/exit-all")
    def exit_all(request: Request, strategy: str = ""):
        b = book(request, strategy, trade=True)
        run(svc.exit_all, b)
        return positions_body(b)

    @app.post("/api/paper/positions/{security_id}/exit")
    def exit_one(security_id: int, request: Request, strategy: str = ""):
        b = book(request, strategy, trade=True)
        run(svc.exit_position, b, security_id)
        return positions_body(b)

    @app.get("/api/paper/pnl")
    def pnl(request: Request, from_day: str = Query("", alias="from"), to: str = "", strategy: str = ""):
        today = svc.clock().date()
        to_day = _day(to, "to") or today.isoformat()
        start = _day(from_day, "from") or (Date.fromisoformat(to_day) - timedelta(days=365)).isoformat()
        if start > to_day:
            raise HTTPException(400, "from must not be after to")
        holidays = sorted(d for d in svc.holidays if start <= d <= to_day)
        accounts = strategy_accounts(svc, strategies, request, strategy)
        return {"meta": {**svc.meta(), "from": start, "to": to_day, "holidays": holidays, "strategy": strategy or ""},
                "rows": svc.pnl(accounts, start, to_day)}

    @app.get("/api/paper/chain")
    def chain(symbol: str = "NIFTY", expiry: str = ""):
        """Strikes with CE / PE security IDs and lot size, from Dhan's instrument list (no rate-limited REST call).
        Live prices come over /ws/paper: subscribe to the strikes shown and to the index (spotSecurityId)."""
        symbol = symbol.upper()
        if symbol not in SPOT_IDS:
            raise HTTPException(400, f"symbol must be one of {list(SPOT_IDS)}")
        try:
            expiries = svc.instruments.expiries(symbol, svc.clock().date().isoformat())
            expiry = _day(expiry, "expiry") or (expiries[0] if expiries else "")
            rows = svc.instruments.chain(symbol, expiry) if expiry else []
        except Exception as e:
            raise HTTPException(502, f"could not load Dhan instrument list: {e}")
        if expiry and not rows:
            raise HTTPException(404, f"no {symbol} options for expiry {expiry}")
        slim = lambda leg: {"securityId": leg["securityId"], "name": leg["name"]} if leg else None  # noqa: E731
        lot = next((r[k]["lotSize"] for r in rows for k in ("ce", "pe") if r[k]), None)
        return {"meta": svc.meta(), "symbol": symbol, "expiry": expiry, "expiries": expiries, "lotSize": lot,
                "spot": {"segment": "IDX_I", "securityId": SPOT_IDS[symbol]},
                "rows": [{"strike": r["strike"], "ce": slim(r["ce"]), "pe": slim(r["pe"])} for r in rows]}

    @app.get("/api/paper/trades")
    def trades(request: Request, date: str = "", strategy: str = ""):
        day = _day(date, "date") or svc.clock().date().isoformat()
        if (strategy or "").lower() == "all":
            rows = []
            for st in strategies.store.strategies(request.state.user.id):
                for acc in strategy_accounts(svc, strategies, request, str(st["id"])):
                    rows += [{**svc._with_instrument(t), "strategyId": st["id"], "strategy": st["name"]}
                             for t in svc.store.trades(acc, day)]
            return {"meta": svc.meta(), "rows": rows}
        st = resolve(strategies, request, strategy, manual=False)
        rows = [svc._with_instrument(t) for acc in strategy_accounts(svc, strategies, request, str(st["id"]))
                for t in svc.store.trades(acc, day)]
        return {"meta": svc.meta(), "rows": rows}

    @app.websocket("/ws/paper")
    async def ws_paper(ws: WebSocket):
        user = ws.state.user

        def pick(value):
            """A manual strategy of this user -> its Book; anything else -> None (prices only)."""
            try:
                st = strategies.get(user, value) if value else None
            except (NotFound, Refused):
                return None
            return svc.book(st) if st and st["kind"] == "manual" else None
        b = pick(ws.query_params.get("strategy"))
        await ws.accept()
        client = svc.add_client(asyncio.get_running_loop(), user.id, b.strategy_id if b else None)

        async def pump():
            while True:
                await ws.send_json(await client.queue.get())

        sender = asyncio.create_task(pump())
        try:
            await ws.send_json(svc.snapshot(b))
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                if kind in ("subscribe", "unsubscribe"):
                    try:
                        svc.client_subscribe(client, msg.get("instruments") or [], add=kind == "subscribe")
                    except (TypeError, ValueError):
                        await ws.send_json({"type": "error", "data": {"message": "instruments must be [[segment, id]]"}})
                elif kind == "strategy":
                    b = pick(str(msg.get("id") or ""))
                    client.strategy_id = b.strategy_id if b else None
                    await ws.send_json(svc.snapshot(b))
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            svc.remove_client(client)
