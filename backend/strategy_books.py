"""
strategy_books.py - one separate paper account per auto strategy inside the app (owner, 25-Oct-2026): "Trend" and
"Dharani" each start with Rs 1,00,000 of virtual cash, so each strategy's money and results stay apart and can be
compared side by side. PAPER ONLY.

A StrategyBook reuses the paper trading engine (paper_engine.PaperEngine: same fills on the live order book, same
charges, same 15:15 square-off) and is fed the same live ticks as the main paper account (paper_api.PaperService calls
on_tick / on_time for every registered book). It keeps its own orders and trades in data/books/<name>/paper.json.
The owner's own Paper Trading screen (manual trades) is untouched: it stays the main paper account.
It offers the same calls the auto trader's TradingHubAccount uses on PaperService (place_order, order, cancel_order,
open_qty, ltp, has_book, trades, orders, positions, watch, instrument_chain, option_expiries).
"""
import logging
import os
import threading

from paper_engine import PaperEngine
from store import PaperJsonStore

log = logging.getLogger("strategy_books")
BOOK_CAPITAL = 100_000


class StrategyBook:
    def __init__(self, name, service, data_dir="data", capital=BOOK_CAPITAL):
        self.name, self.service = name, service
        self.store = PaperJsonStore(os.path.join(data_dir, "books", name))
        self.account = self.store.active_account() or self.store.create_account(capital, service.clock())
        self.lock = threading.RLock()
        self.engine, self.day = None, None
        self.last_error = ""
        self._unsaved = []
        self._ensure_day(service.clock())

    # ---------- day + persistence ----------
    def _ensure_day(self, now):
        today = now.date()
        if self.day == today:
            return
        acc, day = self.account["id"], today.isoformat()
        opening = self.account["capital"] + self.store.net_before(acc, day)
        engine = PaperEngine(max(opening, 0.01), holidays=self.service.holidays, day=today)
        engine.restore(self.store.orders(acc, day), self.store.trades(acc, day))
        if self.engine is not None:  # keep the live order books across the day roll
            engine.books = self.engine.books
        self.engine, self.day = engine, today

    def _publish(self, events):
        if not events:
            return
        day = self.day.isoformat()
        self._unsaved += [(ev.kind, day, ev.data) for ev in events]
        save = {"order": self.store.save_order, "trade": self.store.save_trade, "position": self.store.save_position}
        while self._unsaved:
            kind, d, data = self._unsaved[0]
            try:
                save[kind](self.account["id"], d, data)
            except Exception as e:
                self.last_error = f"Could not save the {self.name} book, will retry: {e}"
                log.warning("book %s write failed: %s", self.name, e)
                return
            self._unsaved.pop(0)
        self.last_error = ""

    # ---------- fed by PaperService ----------
    def on_tick(self, security_id, book, now):
        with self.lock:
            self._ensure_day(now)
            self._publish(self.engine.on_tick(security_id, book, now))

    def on_time(self, now):
        with self.lock:
            self._ensure_day(now)
            self._publish(self.engine.on_time(now))

    # ---------- what the auto trader calls ----------
    def place_order(self, security_id, side, lots, order_type, price=None, trigger_price=None):
        inst = self.service._instrument(security_id)
        if inst is None:
            raise LookupError(f"{security_id} is not a NIFTY / BANKNIFTY option in Dhan's instrument list")
        now = self.service.clock()
        with self.lock:
            self._ensure_day(now)
            order, events = self.engine.place_order(security_id, side, lots, inst["lotSize"], order_type, now,
                                                    price=price, trigger_price=trigger_price)
            self._publish(events)
            return self.service._with_instrument(order.to_dict())

    def cancel_order(self, order_id):
        with self.lock:
            if order_id not in self.engine.orders:
                raise LookupError(f"No order {order_id} today")
            self._publish(self.engine.cancel_order(order_id, self.service.clock()))
            return self.service._with_instrument(self.engine.orders[order_id].to_dict())

    def order(self, order_id):
        with self.lock:
            o = self.engine.orders.get(order_id)
            return o.to_dict() if o else None

    def open_qty(self, security_id):
        with self.lock:
            p = self.engine.positions.get(int(security_id))
            return p.open_qty if p else 0

    def ltp(self, security_id):
        with self.lock:
            return self.engine._ltp(int(security_id))

    def has_book(self, security_id):
        with self.lock:
            return int(security_id) in self.engine.books

    def trades(self, day=None):
        with self.lock:
            rows = [t.to_dict() for t in self.engine.trades] if day in (None, self.day.isoformat()) \
                else self.store.trades(self.account["id"], day)
        return [self.service._with_instrument(t) for t in rows]

    def orders(self, day=None):
        with self.lock:
            rows = [o.to_dict() for o in sorted(self.engine.orders.values(), key=lambda o: o.created_at)] \
                if day in (None, self.day.isoformat()) else self.store.orders(self.account["id"], day)
        return [self.service._with_instrument(o) for o in rows]

    def positions(self):
        with self.lock:
            return [self.service._with_instrument(p.to_dict(self.engine._ltp(sid))) for sid, p in self.engine.positions.items()]

    def funds(self):
        with self.lock:
            f = self.engine.funds()
            f["startingCapital"] = self.account["capital"]
            f["openingBalance"] = f.pop("capital")
            f["unrealized"] = self.engine.unrealized()
            return f

    def watch(self, security_ids, group=None):
        self.service.watch(security_ids, group=group or f"book-{self.name}")

    def instrument_chain(self, symbol, expiry):
        return self.service.instrument_chain(symbol, expiry)

    def option_expiries(self, symbol):
        return self.service.option_expiries(symbol)

    @property
    def instruments(self):
        return self.service.instruments
