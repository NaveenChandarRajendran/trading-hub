"""
paper_engine.py - paper-trading engine for NSE index options: option buying only, intraday only.

Pure: no I/O, no clock, no network. The caller passes `now` (an IST datetime) and every market tick; each call
returns the events it produced (order / trade / position) so the API layer can store and broadcast them.
SIMULATION ONLY: nothing in this module can reach a real order endpoint.

Rules (docs/features/paper-trade.md):
- Quantity is in units = lots x lot size. A SELL may only close an existing long: its quantity can't exceed the open
  quantity minus quantity already in pending SELL orders. No short selling.
- New orders and modifications are accepted 09:15-15:15 IST on trading days. At 15:15 every pending order is
  cancelled and every open position is sold at market (auto square-off).
- Market BUY walks the asks best -> worse (SELL walks the bids); average price = VWAP of the levels used. If the visible
  depth can't fill the quantity, the rest fills at the worst visible level and the order is flagged slippage_capped.
- Limit BUY fills when best ask <= limit, at the best ask (SELL: best bid >= limit, at the best bid). LTP alone never fills.
- SL-M SELL triggers when LTP <= trigger, then fills as market. SL SELL triggers the same way, then rests as a limit
  at its price. BUY stops mirror this (LTP >= trigger).
- No partial fills apart from the depth walk.
- A BUY blocks premium x qty + estimated charges. Available = capital + realized - charges - (avg x open qty of
  open positions) - funds blocked by pending BUYs.
"""
from dataclasses import asdict, dataclass, field
from datetime import datetime, time

from holidays import NSE_HOLIDAYS
from paper_charges import order_charges, r2

BUY, SELL = "BUY", "SELL"
MARKET, LIMIT, SL, SLM = "MARKET", "LIMIT", "SL", "SL-M"
ORDER_TYPES = (MARKET, LIMIT, SL, SLM)
PENDING, TRIGGERED, FILLED, CANCELLED, REJECTED = "PENDING", "TRIGGERED", "FILLED", "CANCELLED", "REJECTED"
OPEN_STATES = (PENDING, TRIGGERED)

TICK_SIZE = 0.05
SESSION_OPEN = time(9, 15)
SQUARE_OFF = time(15, 15)


class OrderError(ValueError):
    """A modify / cancel / exit that can't be applied. The order book is left unchanged."""


def _on_tick_grid(p):
    return abs(round(p / TICK_SIZE) * TICK_SIZE - p) < 1e-6


def walk_depth(levels, qty):
    """Fills qty against depth levels [(price, qty)] best first. Returns (avg, value, slippage_capped) or None if empty."""
    left, value, last = qty, 0.0, None
    for price, avail in levels:
        if price <= 0 or avail <= 0:
            continue
        take = min(left, avail)
        value += take * price
        left -= take
        last = price
        if not left:
            break
    if last is None:
        return None
    value += left * last  # depth exhausted: the rest at the worst visible level
    return value / qty, r2(value), left > 0


@dataclass
class Book:
    """Latest market state of one instrument (from the Full feed packet)."""
    ltp: float
    bids: list = field(default_factory=list)  # [(price, qty)]
    asks: list = field(default_factory=list)

    def __post_init__(self):
        self.bids = sorted(((p, q) for p, q in self.bids if p > 0 and q > 0), key=lambda x: -x[0])
        self.asks = sorted(((p, q) for p, q in self.asks if p > 0 and q > 0), key=lambda x: x[0])

    @property
    def best_bid(self):
        return self.bids[0][0] if self.bids else None

    @property
    def best_ask(self):
        return self.asks[0][0] if self.asks else None


@dataclass
class Order:
    id: str
    security_id: int
    side: str
    order_type: str
    lots: int
    lot_size: int
    price: float | None
    trigger_price: float | None
    status: str
    created_at: datetime
    updated_at: datetime
    avg_price: float | None = None
    filled_at: datetime | None = None
    slippage_capped: bool = False
    reason: str = ""
    blocked: float = 0.0  # funds held for a pending BUY

    @property
    def qty(self):
        return self.lots * self.lot_size

    def to_dict(self):
        d = asdict(self)
        d["qty"] = self.qty
        for k in ("created_at", "updated_at", "filled_at"):
            d[k] = d[k].isoformat() if d[k] else None
        return d


@dataclass
class Trade:
    id: str
    order_id: str
    security_id: int
    side: str
    qty: int
    price: float  # average fill price
    value: float
    charges: object  # paper_charges.Charges
    time: datetime

    def to_dict(self):
        return {"id": self.id, "order_id": self.order_id, "security_id": self.security_id, "side": self.side,
                "qty": self.qty, "price": self.price, "value": self.value, "charges": self.charges.to_dict(),
                "time": self.time.isoformat()}


@dataclass
class Position:
    """Day position of one instrument. Realized P&L uses average prices: sell value - sold qty x avg buy."""
    security_id: int
    lot_size: int
    buy_qty: int = 0
    buy_value: float = 0.0
    sell_qty: int = 0
    sell_value: float = 0.0

    @property
    def open_qty(self):
        return self.buy_qty - self.sell_qty

    @property
    def avg_buy(self):
        return self.buy_value / self.buy_qty if self.buy_qty else 0.0

    @property
    def avg_sell(self):
        return self.sell_value / self.sell_qty if self.sell_qty else 0.0

    @property
    def realized(self):
        return r2(self.sell_value - self.sell_qty * self.avg_buy)

    def unrealized(self, ltp):
        return r2((ltp - self.avg_buy) * self.open_qty) if ltp is not None and self.open_qty else 0.0

    def to_dict(self, ltp=None):
        return {"security_id": self.security_id, "lot_size": self.lot_size, "open_qty": self.open_qty,
                "open_lots": self.open_qty // self.lot_size, "buy_qty": self.buy_qty, "sell_qty": self.sell_qty,
                "avg_buy": round(self.avg_buy, 4), "avg_sell": round(self.avg_sell, 4), "ltp": ltp,
                "realized": self.realized, "unrealized": self.unrealized(ltp)}


@dataclass
class Event:
    kind: str  # "order" | "trade" | "position"
    data: dict


class PaperEngine:
    def __init__(self, capital, holidays=NSE_HOLIDAYS):
        if capital <= 0:
            raise ValueError("capital must be positive")
        self.capital = float(capital)
        self.holidays = holidays
        self.orders = {}      # id -> Order
        self.trades = []      # [Trade]
        self.positions = {}   # security_id -> Position
        self.books = {}       # security_id -> Book
        self.squared_off_on = None
        self._seq = {"PT": 0, "TR": 0}

    # ---------- session and money ----------
    def is_trading_day(self, now):
        return now.weekday() < 5 and now.date().isoformat() not in self.holidays

    def accepting_orders(self, now):
        return self.is_trading_day(now) and SESSION_OPEN <= now.time() < SQUARE_OFF

    def funds(self):
        realized = sum(p.realized for p in self.positions.values())
        charges = sum(t.charges.total for t in self.trades)
        in_positions = sum(p.avg_buy * p.open_qty for p in self.positions.values())
        in_orders = sum(o.blocked for o in self.orders.values() if o.status in OPEN_STATES)
        used = in_positions + in_orders
        return {"capital": r2(self.capital), "realized": r2(realized), "charges": r2(charges),
                "used": r2(used), "available": r2(self.capital + realized - charges - used)}

    def unrealized(self):
        return r2(sum(p.unrealized(self._ltp(p.security_id)) for p in self.positions.values()))

    def _available(self):
        return self.funds()["available"]

    def _ltp(self, security_id):
        b = self.books.get(security_id)
        return b.ltp if b else None

    def _next_id(self, prefix):
        self._seq[prefix] += 1
        return f"{prefix}{self._seq[prefix]:05d}"

    def _pending_sell_qty(self, security_id, exclude=None):
        return sum(o.qty for o in self.orders.values()
                   if o.security_id == security_id and o.side == SELL and o.status in OPEN_STATES and o.id != exclude)

    # ---------- validation ----------
    @staticmethod
    def _check_shape(side, order_type, lots, lot_size, price, trigger_price):
        """Bad input (400 at the API). Returns (price, trigger) normalised for the order type."""
        if side not in (BUY, SELL):
            raise ValueError("side must be BUY or SELL")
        if order_type not in ORDER_TYPES:
            raise ValueError(f"orderType must be one of {', '.join(ORDER_TYPES)}")
        if not isinstance(lots, int) or lots < 1:
            raise ValueError("lots must be a whole number of at least 1")
        if not isinstance(lot_size, int) or lot_size < 1:
            raise ValueError("lot_size must be a whole number of at least 1")
        need_price = order_type in (LIMIT, SL)
        need_trigger = order_type in (SL, SLM)
        price = price if need_price else None
        trigger_price = trigger_price if need_trigger else None
        for name, v, needed in (("price", price, need_price), ("triggerPrice", trigger_price, need_trigger)):
            if not needed:
                continue
            if v is None or v <= 0:
                raise ValueError(f"{name} is required for {order_type} orders and must be above 0")
            if not _on_tick_grid(v):
                raise ValueError(f"{name} must be a multiple of {TICK_SIZE}")
        if order_type == SL:
            if side == SELL and price > trigger_price:
                raise ValueError("for an SL sell, the limit price can't be above the trigger price")
            if side == BUY and price < trigger_price:
                raise ValueError("for an SL buy, the limit price can't be below the trigger price")
        return price, trigger_price

    def _business_reject(self, o, now, book, triggered=False):
        """Reason the order can't be accepted right now, or ''."""
        if not self.accepting_orders(now):
            return "Market closed: orders are accepted 09:15-15:15 IST on trading days."
        if book is None:
            return "No live price for this instrument yet."
        if o.side == SELL:
            pos = self.positions.get(o.security_id)
            can_sell = (pos.open_qty if pos else 0) - self._pending_sell_qty(o.security_id, exclude=o.id)
            if o.qty > can_sell:
                return (f"Sell quantity {o.qty} exceeds the {max(can_sell, 0)} units you can sell. "
                        "Only open positions can be sold; short selling is not allowed.")
        if o.order_type in (SL, SLM) and not triggered:
            if o.side == SELL and o.trigger_price >= book.ltp:
                return f"Trigger {o.trigger_price} must be below LTP {book.ltp} for a sell stop."
            if o.side == BUY and o.trigger_price <= book.ltp:
                return f"Trigger {o.trigger_price} must be above LTP {book.ltp} for a buy stop."
        if o.side == BUY:
            need = self._buy_block(o, book)
            if need is None:
                return "No sellers in the market depth."
            have = self._available() + o.blocked
            if need > have:
                return f"Insufficient funds: need Rs {need:,.2f}, available Rs {have:,.2f}."
        return ""

    def _buy_block(self, o, book):
        """Premium x qty + estimated charges for a BUY. Market uses the depth walk, others their price / trigger."""
        if o.order_type == MARKET:
            w = walk_depth(book.asks, o.qty)
            if w is None:
                return None
            value = w[1]
        else:
            value = (o.price if o.order_type in (LIMIT, SL) else o.trigger_price) * o.qty
        return r2(value + order_charges(BUY, value).total)

    # ---------- orders ----------
    def place_order(self, security_id, side, lots, lot_size, order_type, now, price=None, trigger_price=None):
        """Returns (order, events). Bad input raises ValueError; business rules give a REJECTED order."""
        price, trigger_price = self._check_shape(side, order_type, lots, lot_size, price, trigger_price)
        o = Order(id=self._next_id("PT"), security_id=security_id, side=side, order_type=order_type, lots=lots,
                  lot_size=lot_size, price=price, trigger_price=trigger_price, status=PENDING,
                  created_at=now, updated_at=now)
        self.orders[o.id] = o
        book = self.books.get(security_id)
        reason = self._business_reject(o, now, book)
        if not reason and order_type == MARKET and walk_depth(book.bids if side == SELL else book.asks, o.qty) is None:
            reason = f"No {'buyers' if side == SELL else 'sellers'} in the market depth."
        if reason:
            o.status, o.reason = REJECTED, reason
            return o, [Event("order", o.to_dict())]
        if side == BUY:
            o.blocked = self._buy_block(o, book)
        return o, [Event("order", o.to_dict())] + self._evaluate(o, book, now)

    def modify_order(self, order_id, now, lots=None, price=None, trigger_price=None):
        """Changes a pending order. Raises OrderError (order unchanged) if it can't be modified."""
        o = self._open_order(order_id, "modified")
        if o.status == TRIGGERED and trigger_price is not None and trigger_price != o.trigger_price:
            raise OrderError("The trigger has already been hit; only the limit price can change.")
        new_lots = o.lots if lots is None else lots
        new_price = o.price if price is None else price
        new_trigger = o.trigger_price if trigger_price is None else trigger_price
        new_price, new_trigger = self._check_shape(o.side, o.order_type, new_lots, o.lot_size, new_price, new_trigger)
        old = (o.lots, o.price, o.trigger_price)
        o.lots, o.price, o.trigger_price = new_lots, new_price, new_trigger
        book = self.books.get(o.security_id)
        reason = self._business_reject(o, now, book, triggered=o.status == TRIGGERED)
        if reason:
            o.lots, o.price, o.trigger_price = old
            raise OrderError(reason)
        if o.side == BUY:
            o.blocked = self._buy_block(o, book)
        o.updated_at = now
        return [Event("order", o.to_dict())] + self._evaluate(o, book, now)

    def cancel_order(self, order_id, now, reason="Cancelled by you."):
        o = self._open_order(order_id, "cancelled")
        return [self._cancel(o, now, reason)]

    def _open_order(self, order_id, verb):
        o = self.orders.get(order_id)
        if o is None:
            raise OrderError(f"Unknown order {order_id}.")
        if o.status not in OPEN_STATES:
            raise OrderError(f"Order {order_id} is {o.status}; only pending orders can be {verb}.")
        return o

    def _cancel(self, o, now, reason):
        o.status, o.reason, o.blocked, o.updated_at = CANCELLED, reason, 0.0, now
        return Event("order", o.to_dict())

    # ---------- market data ----------
    def on_tick(self, security_id, book, now):
        """New Full packet for one instrument. Runs pending orders for it, and the 15:15 square-off when due."""
        self.books[security_id] = book
        if self._square_off_due(now):
            return self.square_off(now)
        if not self.accepting_orders(now):
            return []
        events = []
        for o in sorted((o for o in self.orders.values() if o.security_id == security_id and o.status in OPEN_STATES),
                        key=lambda o: o.created_at):
            events += self._evaluate(o, book, now)
        return events

    def on_time(self, now):
        """Timer hook (call every few seconds): runs the 15:15 square-off even when no tick arrives."""
        return self.square_off(now) if self._square_off_due(now) else []

    def _square_off_due(self, now):
        return (self.is_trading_day(now) and now.time() >= SQUARE_OFF and self.squared_off_on != now.date())

    def _evaluate(self, o, book, now):
        if o.order_type in (SL, SLM) and o.status == PENDING:
            hit = book.ltp <= o.trigger_price if o.side == SELL else book.ltp >= o.trigger_price
            if not hit:
                return []
            o.status, o.updated_at = TRIGGERED, now
            if o.order_type == SL:
                return [Event("order", o.to_dict())] + self._evaluate(o, book, now)
        if o.order_type == MARKET or o.order_type == SLM:
            w = walk_depth(book.bids if o.side == SELL else book.asks, o.qty)
            return self._fill(o, w[0], w[1], w[2], now) if w else []  # triggered SL-M with empty depth waits
        if o.side == BUY and book.best_ask is not None and book.best_ask <= o.price:
            return self._fill(o, book.best_ask, r2(book.best_ask * o.qty), False, now)
        if o.side == SELL and book.best_bid is not None and book.best_bid >= o.price:
            return self._fill(o, book.best_bid, r2(book.best_bid * o.qty), False, now)
        return []

    def _fill(self, o, avg, value, capped, now):
        pos = self.positions.get(o.security_id)
        charges = order_charges(o.side, value)
        if o.side == SELL and (pos is None or o.qty > pos.open_qty):
            o.status, o.reason, o.updated_at = REJECTED, "Position already closed; nothing left to sell.", now
            return [Event("order", o.to_dict())]
        if o.side == BUY and value + charges.total > self._available() + o.blocked:
            o.status, o.reason, o.blocked, o.updated_at = REJECTED, "Insufficient funds at fill price.", 0.0, now
            return [Event("order", o.to_dict())]
        if pos is None:
            pos = self.positions[o.security_id] = Position(o.security_id, o.lot_size)
        if o.side == BUY:
            pos.buy_qty += o.qty
            pos.buy_value = r2(pos.buy_value + value)
        else:
            pos.sell_qty += o.qty
            pos.sell_value = r2(pos.sell_value + value)
        o.status, o.avg_price, o.filled_at, o.updated_at = FILLED, round(avg, 4), now, now
        o.slippage_capped, o.blocked = capped, 0.0
        t = Trade(self._next_id("TR"), o.id, o.security_id, o.side, o.qty, round(avg, 4), value, charges, now)
        self.trades.append(t)
        return [Event("order", o.to_dict()), Event("trade", t.to_dict()),
                Event("position", pos.to_dict(self._ltp(o.security_id)))]

    # ---------- exits ----------
    def exit_position(self, security_id, now):
        """Sells the whole open quantity at market. Pending SELLs for the instrument are cancelled first."""
        pos = self.positions.get(security_id)
        if pos is None or pos.open_qty <= 0:
            raise OrderError("No open position to exit.")
        if not self.accepting_orders(now):
            raise OrderError("Market closed: orders are accepted 09:15-15:15 IST on trading days.")
        book = self.books.get(security_id)
        if book is None or not book.bids:
            raise OrderError("No buyers in the market depth; try again in a moment.")
        return self._exit(pos, now, "Exit position", book)

    def exit_all(self, now):
        events = []
        for sid, pos in list(self.positions.items()):
            if pos.open_qty > 0:
                events += self.exit_position(sid, now)
        return events

    def square_off(self, now):
        """15:15 auto square-off: cancel every pending order, then sell every open position at market."""
        self.squared_off_on = now.date()
        events = [self._cancel(o, now, "Cancelled at the 15:15 auto square-off.")
                  for o in self.orders.values() if o.status in OPEN_STATES]
        for pos in self.positions.values():
            if pos.open_qty > 0:
                events += self._exit(pos, now, "Auto square-off 15:15", self.books.get(pos.security_id))
        return events

    def _exit(self, pos, now, reason, book):
        events = [self._cancel(o, now, f"Cancelled: {reason.lower()}.")
                  for o in self.orders.values()
                  if o.security_id == pos.security_id and o.side == SELL and o.status in OPEN_STATES]
        o = Order(id=self._next_id("PT"), security_id=pos.security_id, side=SELL, order_type=MARKET,
                  lots=pos.open_qty // pos.lot_size, lot_size=pos.lot_size, price=None, trigger_price=None,
                  status=PENDING, created_at=now, updated_at=now, reason=reason)
        if pos.open_qty % pos.lot_size:  # never expected: quantities are whole lots
            o.lots, o.lot_size = pos.open_qty, 1
        self.orders[o.id] = o
        events.append(Event("order", o.to_dict()))
        w = walk_depth(book.bids, o.qty) if book else None
        if w is None:  # square-off with no visible bids: fill at LTP and flag it
            ltp = book.ltp if book else pos.avg_buy
            w = (ltp, r2(ltp * o.qty), True)
        return events + self._fill(o, *w, now)
