"""
paper_api.py - paper trading service + routes (/api/paper/*, /ws/paper). SIMULATION ONLY: orders are filled by
paper_engine against the live Dhan feed; nothing here calls a Dhan order endpoint.

PaperService owns one PaperEngine per IST trading day for the active account. Every engine event is written to the
store (Postgres or data/paper.json) and pushed to the open /ws/paper connections. A timer runs the 15:15 square-off
and the day roll-over, so stop-losses and the square-off work while the browser is closed (the backend must run).

WebSocket /ws/paper
  server -> client: {"type": "status"|"funds"|"order"|"trade"|"position"|"tick"|"candle", "data": {...}}
  "candle": the current 1-minute candle of a subscribed index (IDX_I), built from its ticks (candles.py), for the
  Dashboard chart: {"segment", "securityId", "interval": 1, "time", "open", "high", "low", "close"}
  "volume": the current minute's volume of a subscribed index future (the chart's volume bars):
  {"segment", "securityId", "time", "volume"}
                    plus one {"type": "snapshot", ...} right after connecting
  client -> server: {"type": "subscribe" | "unsubscribe", "instruments": [["NSE_FNO", 52175], ["IDX_I", 13]]}
The backend always keeps open positions and pending orders subscribed, whatever the clients ask for.
"""
import asyncio
import logging
import threading
from datetime import date as Date
from datetime import datetime, timedelta

from fastapi import HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from candles import CandleBuilder, VolumeBuilder
from dhan_client import SCRIP as SPOT_IDS  # index security IDs on the feed (IDX_I): NIFTY 13, BANKNIFTY 25
from dhan_feed import FULL, TICKER, to_book
from holidays import NSE_HOLIDAYS
from paper_charges import RATES as CHARGE_RATES
from paper_engine import OPEN_STATES, OrderError, PaperEngine
from paper_levels import opening_order, order_snapshot, shifts_near
from store import IST

log = logging.getLogger("paper")

DEFAULT_CAPITAL = 100_000
CAPITAL_PRESETS = (100_000, 200_000, 500_000)
MIN_CAPITAL, MAX_CAPITAL = 10_000, 10_00_00_000  # Rs 10k .. Rs 10 crore
FNO = "NSE_FNO"
IDX = "IDX_I"
SESSION_CLOSE = (15, 30)
CLIENT_QUEUE = 2000  # messages buffered per WebSocket client; ticks are dropped first when it is full


SHIFT_CHECK_SEC = 20  # how often open positions are checked for new S/R level shifts
# P&L / trades account filter -> pt_accounts.name (None = the manual account); "all" = the three together
ACCOUNTS = {"manual": None, "algo": "Algo", "scalper": "Scalper"}


def now_ist():
    return datetime.now(IST)


class _Client:
    def __init__(self, loop):
        self.loop = loop
        self.queue = asyncio.Queue(CLIENT_QUEUE)
        self.subs = set()  # {(segment, security_id)}

    def push(self, msg):
        def put():
            try:
                self.queue.put_nowait(msg)
            except asyncio.QueueFull:
                pass  # a stuck browser tab must not block the engine
        self.loop.call_soon_threadsafe(put)


class PaperService:
    def __init__(self, store, feed, instruments, clock=now_ist, holidays=NSE_HOLIDAYS, levels=None):
        self.store, self.feed, self.instruments, self.clock, self.holidays = store, feed, instruments, clock, holidays
        self.levels = levels  # paper_levels.TrackerLevels: S/R levels saved with each order (optional)
        self._order_levels = {}  # order id -> pt_order_levels row, today
        self._shift_ids = {}  # security id -> level shift ids last sent, to push a position when a new shift appears
        self._next_shift_check = None
        self.listeners = []  # fn(pkt, now) for every market packet (the algo, algo_service.py)
        self._extra_subs = {}  # owner -> feed keys kept subscribed for it (the algo's indices and options)
        self.lock = threading.RLock()
        self.clients = set()
        self.last_error = ""
        self._unsaved = []  # (kind, day, data) whose store write failed; retried on the next write
        self._feed_subs = set()
        self._feed_status = None
        self._timer = None
        self._stopping = threading.Event()
        self.candles = CandleBuilder()  # current 1-minute candle per subscribed index, for the Dashboard chart
        self.volumes = VolumeBuilder()  # current minute's volume per subscribed index future, same chart
        self.account = store.active_account() or store.create_account(DEFAULT_CAPITAL, clock())
        self.engine, self.day = None, None
        feed.on_packet = self.on_packet
        self._ensure_day(clock())

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

    def tick_timer(self):
        """Every second: day roll-over, 15:15 square-off, feed status changes."""
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            self._publish(self.engine.on_time(now))
            if self._next_shift_check is None or now >= self._next_shift_check:
                self._next_shift_check = now + timedelta(seconds=SHIFT_CHECK_SEC)
                self._push_new_shifts()
        status = self.feed_status()
        if status != self._feed_status:
            self._feed_status = status
            self._broadcast({"type": "status", "data": self.meta()})

    def _ensure_day(self, now):
        today = now.date()
        if self.day == today:
            return
        acc, day = self.account["id"], today.isoformat()
        opening = self.account["capital"] + self.store.net_before(acc, day)
        engine = PaperEngine(max(opening, 0.01), holidays=self.holidays, day=today)
        engine.restore(self.store.orders(acc, day), self.store.trades(acc, day))
        self.engine, self.day = engine, today
        self._order_levels = {r["order_id"]: r for r in self.store.order_levels(acc, day)}
        self._shift_ids = {}
        self._traded = set()  # instruments an order was tried on today
        self._sync_feed()

    # ---------- state ----------
    def market_open(self, now=None):
        now = now or self.clock()
        t = (now.hour, now.minute)
        return self.engine.is_trading_day(now) and (9, 15) <= t < SESSION_CLOSE

    def feed_status(self):
        s = self.feed.status
        return (s.get("connected"), s.get("tokenExpired"), s.get("lastError"))

    def meta(self, message=""):
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
        return {"asOf": now.strftime("%Y-%m-%d %H:%M:%S"), "marketOpen": self.market_open(now),
                "acceptingOrders": self.engine.accepting_orders(now), "tokenExpired": bool(fs.get("tokenExpired")),
                "feedConnected": bool(fs.get("connected")),
                "lastTickAt": datetime.fromtimestamp(last, IST).strftime("%H:%M:%S") if last else None,
                "lastError": self.last_error or fs.get("lastError") or "", "message": message,
                "accountId": self.account["id"]}

    def funds(self):
        f = self.engine.funds()
        f["startingCapital"] = self.account["capital"]
        f["openingBalance"] = f.pop("capital")
        f["unrealized"] = self.engine.unrealized()
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

    def positions(self):
        with self.lock:
            return [self._with_zone(self._with_instrument(p.to_dict(self.engine._ltp(sid))))
                    for sid, p in self.engine.positions.items()]

    # ---------- S/R levels at entry (paper_levels.py; information only, never exits) ----------
    def _with_zone(self, pos):
        """Adds entryZone (the level nearest spot when the opening BUY was placed) and levelShifts (levels within
        100 pts of it that moved since) to an open position. Call with self.lock held."""
        pos = {**pos, "entryZone": None, "levelShifts": []}
        if pos["open_qty"] <= 0:
            self._shift_ids.pop(pos["security_id"], None)
            return pos
        opener = opening_order([t.to_dict() for t in self.engine.trades], pos["security_id"])
        lv = self._order_levels.get(opener)
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
        self._shift_ids[pos["security_id"]] = [s["id"] for s in pos["levelShifts"]]
        return pos

    def _push_new_shifts(self):
        """Levels are recorded every minute by the tracker: push a position again when its shifts changed."""
        if not self.levels:
            return
        for sid, p in self.engine.positions.items():
            if p.open_qty <= 0:
                continue
            before = self._shift_ids.get(sid)
            pos = self._with_zone(self._with_instrument(p.to_dict(self.engine._ltp(sid))))
            if before is not None and [s["id"] for s in pos["levelShifts"]] != before:
                self._broadcast({"type": "position", "data": pos})

    def _save_order_levels(self, order, inst, now):
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
            self._order_levels[order["id"]] = row
            self._unsaved.append(("levels", self.day.isoformat(), row))

    def orders(self, day=None):
        with self.lock:
            if day in (None, self.day.isoformat()):
                rows = [o.to_dict() for o in sorted(self.engine.orders.values(), key=lambda o: o.created_at)]
            else:
                rows = self.store.orders(self.account["id"], day)
        return [self._with_instrument(o) for o in rows]

    def trades(self, day=None, account=None):
        """Fills of a day: the manual account (today from the engine), or a named one ("Algo", "Scalper") from the
        store; "all": every account's, each fill tagged with its account."""
        if account == "all":
            return [{**t, "account": label} for label, name in (("Manual", None), ("Algo", "Algo"), ("Scalper", "Scalper"))
                    for t in self.trades(day, name)]
        with self.lock:
            if account:
                acc = self.store.active_account(account)
                rows = self.store.trades(acc["id"], day or self.day.isoformat()) if acc else []
            elif day in (None, self.day.isoformat()):
                rows = [t.to_dict() for t in self.engine.trades]
            else:
                rows = self.store.trades(self.account["id"], day)
        return [self._with_instrument(t) for t in rows]

    def pnl(self, from_day, to_day, account=None):
        """Day P&L of the manual account, or of a named one ("Algo", "Scalper": same pt_ tables); "all": the three
        accounts added up per day."""
        if account == "all":
            days = {}
            for name in ACCOUNTS.values():
                for r in self.pnl(from_day, to_day, name):
                    d = days.setdefault(r["date"], {"date": r["date"], "realized": 0.0, "charges": 0.0, "trades": 0})
                    d["realized"], d["charges"] = d["realized"] + r["realized"], d["charges"] + r["charges"]
                    d["trades"] += r["trades"]
            rows = [{**d, "realized": round(d["realized"], 2), "charges": round(d["charges"], 2)}
                    for _, d in sorted(days.items())]
            for r in rows:
                r["net"] = round(r["realized"] - r["charges"], 2)
            return rows
        with self.lock:
            acc = self.account if not account else self.store.active_account(account)
            if acc is None:
                return []
            rows = self.store.day_summary(acc["id"], from_day, to_day)
        for r in rows:
            r["net"] = round(r["realized"] - r["charges"], 2)
        return rows

    # ---------- persistence + broadcast ----------
    def _publish(self, events):
        """Stores and broadcasts engine events. Call with self.lock held."""
        if not events:
            return
        day = self.day.isoformat()
        self._unsaved += [(ev.kind, day, ev.data) for ev in events]
        self._flush()
        for ev in events:
            data = self._with_instrument(ev.data)
            self._broadcast({"type": ev.kind, "data": self._with_zone(data) if ev.kind == "position" else data})
        self._broadcast({"type": "funds", "data": self.funds()})
        self._sync_feed()

    def _flush(self):
        acc = self.account["id"]
        save = {"order": self.store.save_order, "trade": self.store.save_trade, "position": self.store.save_position,
                "levels": self.store.save_order_levels}
        while self._unsaved:
            kind, day, data = self._unsaved[0]
            try:
                save[kind](acc, day, data)
            except Exception as e:
                self.last_error = f"Database write failed, will retry: {e}"
                log.warning("paper store write failed: %s", e)
                return
            self._unsaved.pop(0)
        self.last_error = ""

    def _broadcast(self, msg):
        for c in list(self.clients):
            c.push(msg)

    def _sync_feed(self):
        """Feed subscriptions = what the clients show + open positions + pending orders."""
        need = {(FNO, p.security_id) for p in self.engine.positions.values() if p.open_qty > 0} | self._traded
        need |= {(FNO, o.security_id) for o in self.engine.orders.values() if o.status in OPEN_STATES}
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
        if pkt["kind"] == "full":
            book = to_book(pkt)
            tick.update(bid=book.best_bid, ask=book.best_ask, bidQty=book.bids[0][1] if book.bids else 0,
                        askQty=book.asks[0][1] if book.asks else 0, oi=pkt["oi"], volume=pkt["volume"],
                        close=pkt["close"])
            if key[0] == FNO:
                with self.lock:
                    self._ensure_day(now)
                    self._publish(self.engine.on_tick(key[1], book, now))
        msg = {"type": "tick", "data": tick}
        for c in list(self.clients):
            if key in c.subs or (key[0] == FNO and key[1] in self.engine.positions):
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

    # ---------- commands ----------
    def place_order(self, security_id, side, lots, order_type, price=None, trigger_price=None):
        inst = self._instrument(security_id)
        if inst is None:
            raise LookupError(f"{security_id} is not a NIFTY / BANKNIFTY option in Dhan's instrument list")
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            if (FNO, security_id) not in self._traded:  # keep it subscribed for the day, so the next try has a price
                self._traded.add((FNO, security_id))
                self._sync_feed()
            order, events = self.engine.place_order(security_id, side, lots, inst["lotSize"], order_type, now,
                                                    price=price, trigger_price=trigger_price)
            self._save_order_levels(order.to_dict(), inst, now)  # before the events, so the position shows its zone
            self._publish(events)
            self._flush()
            return self._with_instrument(order.to_dict())

    def modify_order(self, order_id, **changes):
        with self.lock:
            self._known(order_id)
            self._publish(self.engine.modify_order(order_id, self.clock(), **changes))
            return self._with_instrument(self.engine.orders[order_id].to_dict())

    def cancel_order(self, order_id):
        with self.lock:
            self._known(order_id)
            self._publish(self.engine.cancel_order(order_id, self.clock()))
            return self._with_instrument(self.engine.orders[order_id].to_dict())

    def _known(self, order_id):
        if order_id not in self.engine.orders:
            raise LookupError(f"No order {order_id} today")

    def exit_position(self, security_id):
        with self.lock:
            self._publish(self.engine.exit_position(security_id, self.clock()))

    def exit_all(self):
        with self.lock:
            self._publish(self.engine.exit_all(self.clock()))

    def _busy(self):
        e = self.engine
        return any(p.open_qty > 0 for p in e.positions.values()) or any(o.status in OPEN_STATES for o in e.orders.values())

    def set_capital(self, capital):
        with self.lock:
            if self._busy():
                raise OrderError("Exit open positions and cancel pending orders before changing capital.")
            self.store.set_capital(self.account["id"], capital)
            self.account["capital"] = float(capital)
            self.day = None
            self._ensure_day(self.clock())
            self._broadcast({"type": "funds", "data": self.funds()})

    def reset_account(self, capital=None):
        with self.lock:
            if self._busy():
                raise OrderError("Exit open positions and cancel pending orders before resetting the account.")
            now = self.clock()
            self.store.archive_account(self.account["id"], now)
            self.account = self.store.create_account(capital or self.account["capital"], now)
            self.day = None
            self._ensure_day(now)
            self._broadcast({"type": "funds", "data": self.funds()})
            return self.account

    # ---------- websocket clients ----------
    def add_client(self, loop):
        c = _Client(loop)
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

    def snapshot(self):
        with self.lock:
            return {"type": "snapshot", "meta": self.meta(), "funds": self.funds(), "positions": self.positions(),
                    "orders": self.orders()}


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


def _check_capital(capital):
    if not MIN_CAPITAL <= capital <= MAX_CAPITAL:
        raise HTTPException(400, f"capital must be between {MIN_CAPITAL:,} and {MAX_CAPITAL:,} rupees "
                                 f"(presets: {', '.join(f'{p:,}' for p in CAPITAL_PRESETS)})")


def _account(value):
    """?account= of /pnl and /trades -> the pt_accounts name (None = manual), or "all"."""
    v = (value or "manual").lower()
    if v == "all":
        return "all"
    if v not in ACCOUNTS:
        raise HTTPException(400, "account must be manual, algo, scalper or all")
    return ACCOUNTS[v]


def _day(value, name):
    if not value:
        return None
    try:
        return Date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(400, f"{name} must be YYYY-MM-DD")


def register(app, svc):
    """Adds the paper trading routes to the FastAPI app (called from main.create_app)."""

    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except OrderError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/paper/account")
    def get_account():
        return {"meta": svc.meta(), "account": svc.account, "funds": svc.funds(), "presets": list(CAPITAL_PRESETS),
                "chargeRates": CHARGE_RATES}

    @app.post("/api/paper/account")
    def set_capital(body: CapitalBody):
        _check_capital(body.capital)
        run(svc.set_capital, body.capital)
        return get_account()

    @app.post("/api/paper/account/reset")
    def reset(body: ResetBody | None = None):
        capital = body.capital if body else None
        if capital is not None:
            _check_capital(capital)
        run(svc.reset_account, capital)
        return get_account()

    @app.post("/api/paper/orders")
    def place(body: OrderBody):
        if body.attach:
            raise HTTPException(400, "attached SL / target is not available yet")
        o = run(svc.place_order, body.securityId, body.side.upper(), body.lots, body.orderType.upper(),
                price=body.price, trigger_price=body.triggerPrice)
        return {"id": o["id"], "status": o["status"], "qty": o["qty"], "reason": o["reason"], "order": o}

    @app.put("/api/paper/orders/{order_id}")
    def modify(order_id: str, body: ModifyBody):
        return run(svc.modify_order, order_id, lots=body.lots, price=body.price, trigger_price=body.triggerPrice)

    @app.delete("/api/paper/orders/{order_id}")
    def cancel(order_id: str):
        return run(svc.cancel_order, order_id)

    @app.get("/api/paper/orders")
    def orders(date: str = ""):
        return {"meta": svc.meta(), "rows": svc.orders(_day(date, "date"))}

    @app.get("/api/paper/positions")
    def positions():
        return {"meta": svc.meta(), "rows": svc.positions(), "funds": svc.funds()}

    @app.post("/api/paper/positions/exit-all")
    def exit_all():
        run(svc.exit_all)
        return positions()

    @app.post("/api/paper/positions/{security_id}/exit")
    def exit_one(security_id: int):
        run(svc.exit_position, security_id)
        return positions()

    @app.get("/api/paper/pnl")
    def pnl(from_day: str = Query("", alias="from"), to: str = "", account: str = ""):  # "from" is a keyword
        today = svc.clock().date()
        to_day = _day(to, "to") or today.isoformat()
        start = _day(from_day, "from") or (Date.fromisoformat(to_day) - timedelta(days=365)).isoformat()
        if start > to_day:
            raise HTTPException(400, "from must not be after to")
        holidays = sorted(d for d in svc.holidays if start <= d <= to_day)
        name = _account(account)
        return {"meta": {**svc.meta(), "from": start, "to": to_day, "holidays": holidays,
                         "account": "All" if name == "all" else name or "Manual"},
                "rows": svc.pnl(start, to_day, name)}

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
    def trades(date: str = "", account: str = ""):
        return {"meta": svc.meta(), "rows": svc.trades(_day(date, "date"), _account(account))}

    @app.websocket("/ws/paper")
    async def ws_paper(ws: WebSocket):
        await ws.accept()
        client = svc.add_client(asyncio.get_running_loop())

        async def pump():
            while True:
                await ws.send_json(await client.queue.get())

        sender = asyncio.create_task(pump())
        try:
            await ws.send_json(svc.snapshot())
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                if kind in ("subscribe", "unsubscribe"):
                    try:
                        svc.client_subscribe(client, msg.get("instruments") or [], add=kind == "subscribe")
                    except (TypeError, ValueError):
                        await ws.send_json({"type": "error", "data": {"message": "instruments must be [[segment, id]]"}})
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            svc.remove_client(client)
