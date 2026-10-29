"""
options_service.py - live side of options strategies (ADR 0010): one OptionsEngine per options strategy, loaded from
all its fills (positions carry across days), market books from the paper feed, Dhan's basket margin for every trade,
the 15:30 expiry settlement, and records in the existing tables so reports read options strategies like any other.
PAPER ONLY: nothing here can reach a real order endpoint.

- Ticks: a paper.listeners hook. Option books feed every engine; index ticks keep each index's last spot at or before
  15:30 of every day (the settlement price). Feed keys: every open leg (full) and its index, kept subscribed.
- Margin: Dhan /margincalculator/multi for the legs that stay open after the trade (net quantity, priced at the last
  price, else the average). Dhan can't answer: an entry is refused; an exit still goes through (the margin stays).
- Settlement: a timer (every 20 s) settles every open leg whose expiry day has reached 15:30, at that day's 15:30 spot;
  without a recorded spot (backend down then) it asks `spot_close(symbol, day)` (Dhan's 1-minute candles), else it
  waits and the positions answer lists the leg as pending.
- Records (per fill): op_fills (the full fill), pt_orders (FILLED, source 'builder'), pt_trades, and the day's
  pt_positions rows of the instruments touched (that day's buys, sells and booked P&L); op_state = margin blocked.
"""
import logging
import threading
from datetime import datetime, time

from dhan_client import SCRIP as SPOT_IDS, DhanError, TokenExpired
from dhan_feed import to_book
from holidays import NSE_HOLIDAYS
from options_engine import BUY, SELL, LegOrder, OptionsEngine, OrderError
from options_report import report as build_report
from store import IST

log = logging.getLogger("options")

FNO, IDX = "NSE_FNO", "IDX_I"
SETTLE_AT = time(15, 30)
SETTLE_CHECK_SECONDS = 20
SYMBOL_OF_SPOT = {v: k for k, v in SPOT_IDS.items()}


class OBook:
    def __init__(self, strategy, account, engine):
        self.strategy, self.account, self.engine = strategy, account, engine

    @property
    def account_id(self):
        return self.account["id"]


class OptionsService:
    def __init__(self, store, paper, margin_multi=None, clock=None, spot_close=None, holidays=NSE_HOLIDAYS):
        """paper: paper_api.PaperService (feed, instruments, listeners). margin_multi(scripts) -> {total, ...}
        (DhanClient.margin_multi). spot_close(symbol, 'YYYY-MM-DD') -> the 15:30 spot from Dhan when none was seen."""
        self.store, self.paper = store, paper
        self.instruments = paper.instruments
        self.margin_multi, self.spot_close = margin_multi, spot_close
        self.clock = clock or paper.clock
        self.holidays = holidays
        self.lock = threading.RLock()
        self.books = {}  # strategy id -> OBook
        self.close_spot = {}  # (symbol, 'YYYY-MM-DD') -> last index ltp at or before 15:30
        self.market = {}  # security id -> latest book of every option heard (handed to an engine when it loads)
        self.last_error = ""
        self._timer = None
        paper.listeners.append(self.on_packet)

    # ---------- books ----------
    def book(self, st):
        """The engine of an options strategy (its open capital period), loaded once from every stored fill."""
        with self.lock:
            b = self.books.get(st["id"])
            if b and b.account_id == st["account_id"]:
                return b
            acc = next(a for a in self.store.accounts() if a["id"] == st["account_id"])
            e = OptionsEngine(acc["capital"], holidays=self.holidays)
            e.restore(self.store.options_fills(acc["id"]), self.store.options_margin(acc["id"]))
            e.books = dict(self.market)  # the latest prices, also for an engine loaded after the ticks
            b = self.books[st["id"]] = OBook(st, acc, e)
            self._sync_feed()
            return b

    def load_all(self):
        """Every active options strategy, so settlement and the feed run even with no page open."""
        for st in self.store.all_strategies():
            if st["kind"] == "options" and not st["archived_at"] and st["account_id"]:
                self.book(st)

    def busy(self, st):
        return bool(self.book(st).engine.open_positions())

    def reload(self, st):
        with self.lock:
            self.books.pop(st["id"], None)
            if st["kind"] == "options" and not st["archived_at"] and st["account_id"]:
                self.book(st)

    def live(self, st):
        """(unbooked P&L, open legs) for the strategy cards."""
        e = self.book(st).engine
        with self.lock:
            return e.unrealized(), len(e.open_positions())

    # ---------- market data ----------
    def on_packet(self, pkt, now):
        key = (pkt["segment"], pkt["security_id"])
        if key[0] == IDX and key[1] in SYMBOL_OF_SPOT:
            local = now.astimezone(IST)
            if local.time() <= SETTLE_AT:
                self.close_spot[(SYMBOL_OF_SPOT[key[1]], local.date().isoformat())] = float(pkt["ltp"])
            return
        if key[0] != FNO or pkt["kind"] != "full":
            return
        book = to_book(pkt)
        with self.lock:
            self.market[key[1]] = book
            for b in self.books.values():
                b.engine.on_tick(key[1], book)

    def _sync_feed(self):
        keys = set()
        for b in self.books.values():
            for p in b.engine.open_positions():
                keys.add((FNO, p.security_id))
                if p.symbol in SPOT_IDS:
                    keys.add((IDX, SPOT_IDS[p.symbol]))
        self.paper.set_feed_keys("options", keys)

    # ---------- margin ----------
    def _margin_for(self, engine, changes):
        """Dhan's margin of the legs open after `changes` ({security_id: signed qty change}). 0 when flat after."""
        after = {p.security_id: p.qty for p in engine.open_positions()}
        for sid, d in changes.items():
            after[sid] = after.get(sid, 0) + d
        scripts = []
        for sid, q in after.items():
            if not q:
                continue
            pos = engine.positions.get(sid)
            book = engine.books.get(sid)
            price = book.ltp if book else (pos.avg if pos else 0.0)
            scripts.append({"securityId": sid, "transactionType": BUY if q > 0 else SELL, "quantity": abs(q), "price": price})
        if not scripts:
            return 0.0, ""
        if self.margin_multi is None:
            return None, "no Dhan connection"
        try:
            return float(self.margin_multi(scripts)["total"]), ""
        except TokenExpired:
            return None, "Dhan token expired: send a new one (POST /api/token)"
        except DhanError as e:
            return None, str(e)

    # ---------- commands ----------
    def place_basket(self, st, legs):
        """legs: [{securityId, side 'B' | 'S', lots}]. All-or-nothing at market (OptionsEngine.place_basket)."""
        b = self.book(st)
        orders = []
        for leg in legs:
            inst = self.instruments.get(int(leg["securityId"]))
            if inst is None:
                raise LookupError(f"{leg['securityId']} is not a NIFTY / BANKNIFTY option in Dhan's instrument list")
            side = BUY if leg["side"] in ("B", BUY) else SELL
            orders.append(LegOrder(int(inst["securityId"]), side, int(leg["lots"]), int(inst["lotSize"]), inst["symbol"],
                                   inst["expiry"], float(inst["strike"]), inst["optionType"]))
        changes = {}
        for o in orders:
            changes[o.security_id] = changes.get(o.security_id, 0) + (o.qty if o.side == BUY else -o.qty)
        margin, why = self._margin_for(b.engine, changes)  # outside the lock: Dhan is rate limited
        with self.lock:
            try:
                fills = b.engine.place_basket(orders, self.clock(), margin)
            except OrderError as e:
                if margin is None and why:
                    raise OrderError(f"Margin unavailable from Dhan ({why}): the basket was not placed.") from e
                raise
            self._persist(b, fills)
        return fills

    def exit(self, st, security_id=None):
        b = self.book(st)
        legs = [p for p in b.engine.open_positions() if security_id is None or p.security_id == security_id]
        margin, _ = self._margin_for(b.engine, {p.security_id: -p.qty for p in legs})
        with self.lock:
            fills = b.engine.exit(self.clock(), margin_after=margin, security_id=security_id)
            self._persist(b, fills)
        return fills

    # ---------- expiry ----------
    def settle_due(self, now=None):
        """Settles every open leg whose expiry day has reached 15:30 (today or a missed earlier day)."""
        now = (now or self.clock()).astimezone(IST)
        done = []
        with self.lock:
            books = list(self.books.values())
        for b in books:
            for expiry, symbol in sorted({(p.expiry, p.symbol) for p in b.engine.open_positions()}):
                if expiry > now.date().isoformat() or (expiry == now.date().isoformat() and now.time() < SETTLE_AT):
                    continue
                spot = self.close_spot.get((symbol, expiry))
                if spot is None and self.spot_close:
                    try:
                        spot = self.spot_close(symbol, expiry)
                    except Exception as e:  # noqa: BLE001 - Dhan down: try again on the next round
                        log.warning("15:30 spot of %s %s: %s", symbol, expiry, e)
                    if spot is not None:
                        self.close_spot[(symbol, expiry)] = spot
                if spot is None:
                    self.last_error = f"Settlement of {symbol} {expiry} waits for its 15:30 spot."
                    continue
                at = datetime.fromisoformat(f"{expiry}T15:30:00").replace(tzinfo=IST)
                with self.lock:
                    fills = b.engine.settle(expiry, spot, at, symbol=symbol)
                    self._persist(b, fills)
                done += fills
                log.info("settled %s %s at %.2f: %d legs (strategy %s)", symbol, expiry, spot, len(fills), b.strategy["id"])
        return done

    def pending(self, b, now=None):
        """Open legs whose expiry has passed 15:30 but could not be settled yet (no spot)."""
        now = (now or self.clock()).astimezone(IST)
        today = now.date().isoformat()
        return [p.security_id for p in b.engine.open_positions()
                if p.expiry < today or (p.expiry == today and now.time() >= SETTLE_AT)]

    def start(self):
        """The settlement timer (daemon thread)."""
        def run():
            while True:
                try:
                    self.settle_due()
                except Exception:
                    log.exception("options settlement round failed")
                threading.Event().wait(SETTLE_CHECK_SECONDS)
        self._timer = threading.Thread(target=run, name="options-settle", daemon=True)
        self._timer.start()

    # ---------- records ----------
    def _persist(self, b, fills):
        acc, days = b.account_id, {}
        for f in fills:
            day = f.time.astimezone(IST).date().isoformat()
            d = f.to_dict()
            self.store.save_options_fill(acc, day, d)
            stamp = f.time.isoformat()
            self.store.save_order(acc, day, {
                "id": f.id, "security_id": f.security_id, "side": f.side, "order_type": "MARKET",
                "lots": f.qty // f.lot_size if f.qty % f.lot_size == 0 else f.qty,
                "lot_size": f.lot_size if f.qty % f.lot_size == 0 else 1, "price": None, "trigger_price": None,
                "status": "FILLED", "avg_price": round(f.price, 4), "slippage_capped": f.slippage_capped,
                "reason": "Expiry settlement" if f.kind == "settle" else f"Basket {f.basket_id}", "blocked": 0.0,
                "created_at": stamp, "updated_at": stamp, "filled_at": stamp, "source": "builder", "setup": f.basket_id,
                "variant": "", "oco_group": ""})
            self.store.save_trade(acc, day, {"id": f.id, "order_id": f.id, "security_id": f.security_id, "side": f.side,
                                             "qty": f.qty, "price": round(f.price, 4), "value": f.value,
                                             "charges": f.charges.to_dict(), "time": stamp})
            days.setdefault(day, set()).add(f.security_id)
        for day, sids in days.items():
            for row in b.engine.day_rows(day):
                if row["security_id"] in sids:
                    self.store.save_position(acc, day, row)
        self.store.set_options_margin(acc, b.engine.blocked_margin)
        self._sync_feed()

    # ---------- views ----------
    def positions(self, st):
        b = self.book(st)
        now = self.clock()
        with self.lock:
            e = b.engine
            rows = []
            for p in e.open_positions():
                ltp = e._ltp(p.security_id)
                inst = self.instruments.get(p.security_id) or {}
                rows.append({**p.to_dict(ltp), "name": inst.get("name") or f"{p.symbol} {p.strike:g} {p.option_type}"})
            pend = set(self.pending(b, now))
            return {"strategy": {"id": st["id"], "name": st["name"], "kind": st["kind"]},
                    "positions": [{**r, "settlementPending": r["security_id"] in pend} for r in rows],
                    "funds": e.funds(), "unrealized": e.unrealized(),
                    "meta": {"acceptingOrders": e.accepting_orders(now), "asOf": now.isoformat(), "lastError": self.last_error}}

    def report(self, st):
        """How the strategy did (options_report.py): every capital period's fills, open legs at the live price."""
        accounts = [a for a in self.store.accounts() if a.get("strategy_id") == st["id"]]
        fills = [f for a in accounts for f in self.store.options_fills(a["id"])]
        open_legs, capital = [], 0.0
        if st["account_id"] and not st["archived_at"]:
            e = self.book(st).engine
            with self.lock:
                open_legs = [p.to_dict(e._ltp(p.security_id)) for p in e.open_positions()]
                capital = e.capital
        else:
            capital = next((a["capital"] for a in accounts if a["id"] == st["account_id"]),
                           accounts[-1]["capital"] if accounts else 0.0)
        return {"strategy": {"id": st["id"], "name": st["name"], "kind": st["kind"], "archived": bool(st["archived_at"])},
                **build_report(fills, open_legs, float(capital))}

    @staticmethod
    def fill_view(f):
        return {"id": f.id, "basketId": f.basket_id, "securityId": f.security_id, "side": f.side, "qty": f.qty,
                "price": round(f.price, 4), "value": f.value, "charges": f.charges.total, "kind": f.kind,
                "realized": f.realized, "symbol": f.symbol, "expiry": f.expiry, "strike": f.strike,
                "optionType": f.option_type, "time": f.time.isoformat()}


def dhan_spot_close(client):
    """spot_close for OptionsService: the close of the index's 15:29 one-minute candle on `day` (Dhan history)."""
    from candles import parse_intraday

    def fetch(symbol, day):
        payload = client.intraday(symbol, f"{day} 15:20:00", f"{day} 15:31:00")
        rows = [r for r in parse_intraday(payload)
                if datetime.fromtimestamp(r["time"], IST).time() <= time(15, 29)]
        return rows[-1]["close"] if rows else None
    return fetch

