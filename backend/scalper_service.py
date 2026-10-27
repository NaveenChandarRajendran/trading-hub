"""
scalper_service.py - Power Scalper: the "Scalper" paper account (its own capital, P&L and reports). PAPER ONLY: orders
are filled by paper_engine against the live Dhan feed; nothing here can reach a Dhan order endpoint.

One PaperEngine per IST trading day for the active "Scalper" account (pt_accounts.name), like the algo's: every order
is stored with source="scalper". Market data comes from the paper service's feed (a packet listener), so the Scalper
shares the one feed connection; its open positions and pending orders stay subscribed (set_feed_keys). A timer runs
the 15:15 square-off and writes scalper_daily_summary at 15:35 IST. Manual and Algo accounts are never touched.
"""
import logging
import threading
from datetime import datetime, time, timedelta

from dhan_feed import to_book
from holidays import NSE_HOLIDAYS
from paper_engine import BUY, KEEP, MARKET, OPEN_STATES, SELL, OrderError, PaperEngine
from scalper_reports import day_rows, round_trips, summary_row, tiles
from store import IST

log = logging.getLogger("scalper")

ACCOUNT_NAME = "Scalper"
DEFAULT_CAPITAL = 100_000
CAPITAL_PRESETS = (50_000, 100_000, 200_000, 500_000)
SUMMARY_AT = time(15, 35)
FNO = "NSE_FNO"
SOURCE = "scalper"


class ScalperService:
    def __init__(self, store, paper, instruments, clock=lambda: datetime.now(IST), holidays=NSE_HOLIDAYS):
        self.store, self.paper, self.instruments, self.clock, self.holidays = store, paper, instruments, clock, holidays
        self.lock = threading.RLock()
        self.account = store.active_account(ACCOUNT_NAME) or store.create_account(DEFAULT_CAPITAL, clock(),
                                                                                    name=ACCOUNT_NAME)
        self.engine, self.day = None, None
        self.listeners = []  # fn(kind, data) for every engine event (the /ws/scalper clients, step 2)
        self.last_error = ""
        self._unsaved = []
        self._summary_day = None
        self._stopping = threading.Event()
        self._ensure_day(clock())
        paper.listeners.append(self.on_packet)

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
        """Every second: day roll-over, 15:15 square-off, the 15:35 daily summary."""
        now = now or self.clock()
        with self.lock:
            self._ensure_day(now)
            self._publish(self.engine.on_time(now))
            if (self.engine.is_trading_day(now) and now.time() >= SUMMARY_AT and self._summary_day != now.date()):
                self.write_summary(now.date().isoformat())
                self._summary_day = now.date()

    def _ensure_day(self, now):
        if self.day == now.date():
            return
        acc, day = self.account["id"], now.date().isoformat()
        opening = self.account["capital"] + self.store.net_before(acc, day)
        engine = PaperEngine(max(opening, 0.01), holidays=self.holidays, day=now.date())
        engine.restore(self.store.orders(acc, day), self.store.trades(acc, day))
        if self.engine:  # keep the last prices across a day / capital change
            engine.books = dict(self.engine.books)
        self.engine, self.day = engine, now.date()
        self._sync_feed()

    # ---------- market data ----------
    def on_packet(self, pkt, now):
        """Paper service listener (feed thread): every Full packet of an option updates the Scalper's book."""
        if pkt.get("kind") != "full" or pkt.get("segment") != FNO:
            return
        with self.lock:
            self._ensure_day(now)
            self._publish(self.engine.on_tick(pkt["security_id"], to_book(pkt), now))

    def _held_keys(self):
        e = self.engine
        ids = {sid for sid, p in e.positions.items() if p.open_qty > 0}
        ids |= {o.security_id for o in e.orders.values() if o.status in OPEN_STATES}
        return {(FNO, sid) for sid in ids}

    def _sync_feed(self):
        """Open positions and pending orders always stay subscribed (Full mode), whatever the pages show."""
        try:
            self.paper.set_feed_keys(SOURCE, self._held_keys())
        except Exception as e:
            log.warning("scalper feed keys: %s", e)

    # ---------- persistence ----------
    def _publish(self, events):
        """Stores engine events (source="scalper") and passes them to the listeners. Call with self.lock held."""
        if not events:
            return
        day = self.day.isoformat()
        for ev in events:
            data = dict(ev.data)
            if ev.kind == "order":
                data.update(source=SOURCE)
            self._unsaved.append((ev.kind, day, data))
        self._flush()
        for ev in events:
            self._notify(ev.kind, self._with_instrument(ev.data))
        self._notify("funds", self.funds())
        self._sync_feed()

    def _flush(self):
        save = {"order": self.store.save_order, "trade": self.store.save_trade, "position": self.store.save_position}
        while self._unsaved:
            kind, day, data = self._unsaved[0]
            try:
                save[kind](self.account["id"], day, data)
            except Exception as e:  # kept and retried with the next write
                self.last_error = f"Database write failed, will retry: {e}"
                log.warning("scalper store write failed: %s", e)
                return
            self._unsaved.pop(0)
        self.last_error = ""

    def _notify(self, kind, data):
        for fn in list(self.listeners):
            try:
                fn(kind, data)
            except Exception:
                log.exception("scalper listener failed")

    # ---------- state ----------
    def meta(self):
        m = self.paper.meta()
        return {**m, "accountId": self.account["id"], "account": ACCOUNT_NAME,
                "acceptingOrders": self.engine.accepting_orders(self.clock()),
                "lastError": self.last_error or m.get("lastError", "")}

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
            out = []
            for sid, p in self.engine.positions.items():
                t, s = self.engine.protection(sid)
                out.append(self._with_instrument({**p.to_dict(self.engine._ltp(sid)),
                                                  "target": t.price if t else None, "targetOrderId": t.id if t else None,
                                                  "stop": s.trigger_price if s else None,
                                                  "stopOrderId": s.id if s else None}))
            return out

    def orders(self, day=None):
        with self.lock:
            if day in (None, self.day.isoformat()):
                rows = [o.to_dict() for o in sorted(self.engine.orders.values(), key=lambda o: o.created_at)]
            else:
                rows = self.store.orders(self.account["id"], day)
        return [self._with_instrument(o) for o in rows]

    def snapshot(self):
        with self.lock:
            return {"meta": self.meta(), "account": self.account, "funds": self.funds(),
                    "positions": self.positions(), "orders": self.orders()}

    # ---------- commands ----------
    def place_order(self, security_id, side, lots):
        """MARKET BUY / SELL in one click. A SELL only closes an open long (engine rule). Returns the order."""
        inst = self._instrument(security_id)
        if inst is None:
            raise LookupError(f"{security_id} is not a NIFTY / BANKNIFTY option in Dhan's instrument list")
        if side not in (BUY, SELL):
            raise ValueError("side must be BUY or SELL")
        with self.lock:
            now = self.clock()
            self._ensure_day(now)
            order, events = self.engine.place_order(security_id, side, lots, inst["lotSize"], MARKET, now)
            self._publish(events)
            return self._with_instrument(order.to_dict())

    def exit_position(self, security_id):
        with self.lock:
            self._publish(self.engine.exit_position(security_id, self.clock()))

    def exit_all(self):
        with self.lock:
            self._publish(self.engine.exit_all(self.clock()))

    def set_protection(self, security_id, target=KEEP, stop=KEEP):
        """Target / stop of an open position as an OCO pair (None cancels a leg, KEEP leaves it)."""
        with self.lock:
            self._publish(self.engine.set_protection(security_id, self.clock(), target=target, stop=stop))
            return next(p for p in self.positions() if p["security_id"] == security_id)

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
            self._notify("funds", self.funds())

    def reset_account(self, capital=None):
        """Fresh start: archives the Scalper account (its history stays) and opens a new one."""
        with self.lock:
            if self._busy():
                raise OrderError("Exit open positions and cancel pending orders before resetting the account.")
            now = self.clock()
            self.store.archive_account(self.account["id"], now)
            self.account = self.store.create_account(capital or self.account["capital"], now, name=ACCOUNT_NAME)
            self.day = None
            self._ensure_day(now)
            self._notify("funds", self.funds())
            return self.account

    # ---------- reports ----------
    def _trips_by_day(self, from_day, to_day):
        fills = [self._with_instrument(t) for t in self.store.trades_between(self.account["id"], from_day, to_day)]
        by_day = {}
        for t in fills:
            by_day.setdefault(t["date"], []).append(t)
        return {d: round_trips(rows) for d, rows in by_day.items()}

    def reports(self, from_day, to_day):
        """Tiles + day-wise table of the Scalper account for a date range (fills since the last reset)."""
        trips = self._trips_by_day(from_day, to_day)
        days = day_rows(self.store.day_summary(self.account["id"], from_day, to_day),
                        {d: closed for d, (closed, _open) in trips.items()})
        all_closed = [t for closed, _open in trips.values() for t in closed]
        return {"tiles": tiles(days, all_closed), "days": days}

    def day_view(self, day):
        """One day: its round trips (closed and still open) and every fill."""
        fills = [self._with_instrument(t) for t in self.store.trades_between(self.account["id"], day, day)]
        closed, still_open = round_trips(fills)
        row = next(iter(day_rows(self.store.day_summary(self.account["id"], day, day), {day: closed})), None)
        return {"date": day, "day": row, "trades": closed, "open": still_open, "fills": fills}

    def write_summary(self, day):
        """scalper_daily_summary row of a day (15:35 IST, or on demand)."""
        view = self.day_view(day)
        row = summary_row(self.account["id"], day, view["day"], view["trades"])
        try:
            self.store.scalper_save_summary(row)
        except Exception as e:
            self.last_error = f"Scalper summary not saved: {e}"
            log.warning("scalper summary: %s", e)
        return row


def default_range(today, days=30):
    return (today - timedelta(days=days)).isoformat(), today.isoformat()
