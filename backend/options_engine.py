"""
options_engine.py - paper engine for multi-leg option positions held across days (ADR 0010). Options strategies only:
Manual / Scalper / the algo keep paper_engine.py (buy-only, intraday).

Pure: no I/O, no clock, no network. The caller passes `now` (IST datetime), the market books and Dhan's margin; each
call returns the fills it made so the service can store and send them. SIMULATION ONLY: nothing here can reach a real
order endpoint.

Rules (ADR 0010)
- Positions are signed (long +, short −) with an average price and live across days; they are rebuilt from every fill
  of the strategy's capital period (restore). Realized P&L = closing qty × (close price − average) × sign.
- A basket is all-or-nothing at market: sells walk the bids, buys the asks (paper_engine.walk_depth); every leg needs
  depth on its side or nothing fills. Orders 09:15-15:15 IST on trading days.
- Margin blocked = Dhan's basket margin of the open legs after the trade (given by the caller), and at least the
  premium of the long legs. Funds: cash = capital + realized − charges + premium of open shorts − premium of open longs;
  available = cash − blocked margin. A basket needs available ≥ 0 after it (margin, debit and charges included).
- Exits at market, one leg or all. Without a new margin figure the blocked margin stays (never less) until flat.
- Expiry settlement: every open leg of the expiry closes at intrinsic value against the given spot (OTM = 0); STT
  0.125 % of the intrinsic value on in-the-money long options, no other charge.
"""
from dataclasses import dataclass, field
from datetime import datetime, time

from holidays import NSE_HOLIDAYS
from paper_charges import Charges, order_charges, r2
from paper_engine import BUY, SELL, OrderError, walk_depth

SESSION_OPEN = time(9, 15)
ORDERS_CLOSE = time(15, 15)
SETTLE_STT_RATE = 0.00125  # 0.125 % of the intrinsic value of exercised (in-the-money) long options


@dataclass
class LegOrder:
    """One leg of a basket: BUY or SELL `lots` of an option (any of them may open, add to, reduce or flip a leg)."""
    security_id: int
    side: str
    lots: int
    lot_size: int
    symbol: str
    expiry: str  # YYYY-MM-DD
    strike: float
    option_type: str  # CE | PE

    @property
    def qty(self):
        return self.lots * self.lot_size


@dataclass
class Fill:
    id: str
    basket_id: str
    security_id: int
    side: str
    qty: int
    price: float
    value: float
    charges: Charges
    time: datetime
    kind: str  # open | close | settle
    realized: float  # P&L this fill booked (0 when it only opened or added)
    symbol: str
    expiry: str
    strike: float
    option_type: str
    lot_size: int
    slippage_capped: bool = False

    def to_dict(self):
        return {"id": self.id, "order_id": self.basket_id, "security_id": self.security_id, "side": self.side,
                "qty": self.qty, "price": round(self.price, 4), "value": self.value, "charges": self.charges.to_dict(),
                "time": self.time.isoformat(), "kind": self.kind, "realized": self.realized, "symbol": self.symbol,
                "expiry": self.expiry, "strike": self.strike, "optionType": self.option_type, "lotSize": self.lot_size,
                "slippageCapped": self.slippage_capped}

    @classmethod
    def from_dict(cls, d):
        c = {k: v for k, v in d["charges"].items() if k != "total"}
        return cls(d["id"], d["order_id"], int(d["security_id"]), d["side"], int(d["qty"]), float(d["price"]),
                   float(d["value"]), Charges(**c), datetime.fromisoformat(d["time"]), d.get("kind", "open"),
                   float(d.get("realized", 0.0)), d["symbol"], d["expiry"], float(d["strike"]), d["optionType"],
                   int(d["lotSize"]), bool(d.get("slippageCapped", False)))


@dataclass
class OptPosition:
    security_id: int
    lot_size: int
    symbol: str
    expiry: str
    strike: float
    option_type: str
    qty: int = 0  # signed units: long +, short −
    avg: float = 0.0  # average price of the open quantity
    realized: float = 0.0  # every fill of this instrument so far

    def apply(self, side, qty, price):
        """Applies a fill; returns the P&L it booked."""
        signed = qty if side == BUY else -qty
        if self.qty == 0 or (self.qty > 0) == (signed > 0):  # opens or adds
            total = abs(self.qty) + qty
            self.avg = (abs(self.qty) * self.avg + qty * price) / total
            self.qty += signed
            return 0.0
        closing = min(qty, abs(self.qty))
        booked = r2(closing * (price - self.avg) * (1 if self.qty > 0 else -1))
        self.realized = r2(self.realized + booked)
        left = qty - closing
        self.qty += signed if not left else (-self.qty)  # reduce to 0 first
        if left:  # flips: the rest opens the other way at this price
            self.qty, self.avg = (left if signed > 0 else -left), price
        elif self.qty == 0:
            self.avg = 0.0
        return booked

    def intrinsic(self, spot):
        return max(0.0, spot - self.strike) if self.option_type == "CE" else max(0.0, self.strike - spot)

    def unrealized(self, ltp):
        return r2((ltp - self.avg) * self.qty) if ltp is not None and self.qty else 0.0

    def to_dict(self, ltp=None):
        return {"security_id": self.security_id, "symbol": self.symbol, "expiry": self.expiry, "strike": self.strike,
                "optionType": self.option_type, "lot_size": self.lot_size, "qty": self.qty,
                "lots": self.qty // self.lot_size if self.qty >= 0 else -((-self.qty) // self.lot_size),
                "avg": round(self.avg, 4), "ltp": ltp, "realized": self.realized, "unrealized": self.unrealized(ltp)}


@dataclass
class Book:
    """Latest market of one instrument (same shape as paper_engine.Book)."""
    ltp: float
    bids: list = field(default_factory=list)  # [(price, qty)] best first
    asks: list = field(default_factory=list)


class OptionsEngine:
    """One capital period of one options strategy. `capital` = the period's starting money."""

    def __init__(self, capital, holidays=NSE_HOLIDAYS):
        if capital <= 0:
            raise ValueError("capital must be positive")
        self.capital = float(capital)
        self.holidays = holidays
        self.positions = {}  # security_id -> OptPosition
        self.fills = []  # [Fill]
        self.books = {}  # security_id -> Book
        self.blocked_margin = 0.0
        self._seq = {}  # (prefix, day) -> n

    # ---------- session, money ----------
    def is_trading_day(self, now):
        return now.weekday() < 5 and now.date().isoformat() not in self.holidays

    def accepting_orders(self, now):
        return self.is_trading_day(now) and SESSION_OPEN <= now.time() < ORDERS_CLOSE

    def open_positions(self):
        return [p for p in self.positions.values() if p.qty]

    def long_premium(self, positions=None):
        """Premium of the open long legs (at their average price): the least margin to block."""
        return r2(sum(p.qty * p.avg for p in (positions or self.positions).values() if p.qty > 0))

    def funds(self):
        realized = sum(f.realized for f in self.fills)
        charges = sum(f.charges.total for f in self.fills)
        premium_flow = sum(-p.qty * p.avg for p in self.positions.values())  # shorts +, longs −
        cash = self.capital + realized - charges + premium_flow
        return {"capital": r2(self.capital), "realized": r2(realized), "charges": r2(charges),
                "premiumOpen": r2(premium_flow), "cash": r2(cash), "blockedMargin": r2(self.blocked_margin),
                "available": r2(cash - self.blocked_margin)}

    def unrealized(self):
        return r2(sum(p.unrealized(self._ltp(p.security_id)) for p in self.positions.values()))

    def _ltp(self, sid):
        b = self.books.get(sid)
        return b.ltp if b else None

    def _id(self, prefix, now):
        key = (prefix, now.date())
        self._seq[key] = self._seq.get(key, 0) + 1
        return f"{prefix}{now:%Y%m%d}-{self._seq[key]:04d}"

    # ---------- market data ----------
    def on_tick(self, security_id, book):
        self.books[security_id] = book

    # ---------- orders ----------
    def place_basket(self, legs, now, margin_after):
        """All-or-nothing basket at market. margin_after: Dhan's basket margin of the open legs after this trade
        (None = Dhan didn't answer: refused). Returns the fills; raises OrderError (nothing changed) otherwise."""
        if not legs:
            raise OrderError("A basket needs at least one leg.")
        if not self.accepting_orders(now):
            raise OrderError("Market closed: orders are accepted 09:15-15:15 IST on trading days.")
        if margin_after is None:
            raise OrderError("Margin unavailable from Dhan right now: the basket was not placed. Try again in a moment.")
        planned = []
        for leg in legs:
            if leg.side not in (BUY, SELL) or leg.lots < 1 or leg.lot_size < 1:
                raise OrderError("Each leg needs BUY / SELL and at least one lot.")
            book = self.books.get(leg.security_id)
            w = walk_depth((book.bids if leg.side == SELL else book.asks) if book else [], leg.qty)
            if w is None:
                raise OrderError(f"No {'buyers' if leg.side == SELL else 'sellers'} for {leg.symbol} {leg.strike:g} "
                                 f"{leg.option_type} {leg.expiry}: nothing was placed.")
            planned.append((leg, w))
        # the book after the basket (on copies), to check funds before anything is filled
        after = {sid: _copy(p) for sid, p in self.positions.items()}
        charges = 0.0
        for leg, (avg, value, _capped) in planned:
            pos = after.setdefault(leg.security_id, _new_position(leg))
            pos.apply(leg.side, leg.qty, avg)
            charges += order_charges(leg.side, value).total
        margin = max(float(margin_after), self.long_premium(after))
        f = self.funds()
        realized_now = sum(p.realized for p in after.values()) - sum(p.realized for p in self.positions.values())
        cash_after = f["cash"] + realized_now - charges + _premium_flow(after) - _premium_flow(self.positions)
        if cash_after - margin < -1e-6:
            raise OrderError(f"Insufficient funds: this basket needs margin Rs {margin:,.2f} with Rs {f['available']:,.2f} "
                             f"available (margin blocked now Rs {self.blocked_margin:,.2f}).")
        basket = self._id("OB", now)
        fills = [self._fill(leg, avg, value, capped, now, basket, kind=None) for leg, (avg, value, capped) in planned]
        self.blocked_margin = margin if self.open_positions() else 0.0
        return fills

    def exit(self, now, margin_after=None, security_id=None):
        """Closes one leg (security_id) or every open leg at market. margin_after: Dhan's margin of what stays open
        (None: the margin blocked now stays, never less, until flat)."""
        if not self.accepting_orders(now):
            raise OrderError("Market closed: orders are accepted 09:15-15:15 IST on trading days.")
        legs = [p for p in self.open_positions() if security_id is None or p.security_id == security_id]
        if not legs:
            raise OrderError("No open position to exit.")
        planned = []
        for p in legs:
            side = SELL if p.qty > 0 else BUY
            book = self.books.get(p.security_id)
            w = walk_depth((book.bids if side == SELL else book.asks) if book else [], abs(p.qty))
            if w is None:
                raise OrderError(f"No {'buyers' if side == SELL else 'sellers'} for {p.symbol} {p.strike:g} {p.option_type}: "
                                 "nothing was exited. Try again in a moment.")
            planned.append((p, side, w))
        basket = self._id("OB", now)
        fills = []
        for p, side, (avg, value, capped) in planned:
            leg = LegOrder(p.security_id, side, abs(p.qty) // p.lot_size, p.lot_size, p.symbol, p.expiry, p.strike, p.option_type)
            if abs(p.qty) % p.lot_size:  # never expected: quantities are whole lots
                leg.lots, leg.lot_size = abs(p.qty), 1
            fills.append(self._fill(leg, avg, value, capped, now, basket, kind="close"))
        if not self.open_positions():
            self.blocked_margin = 0.0
        elif margin_after is not None:
            self.blocked_margin = max(float(margin_after), self.long_premium())
        return fills

    def settle(self, expiry, spot, now):
        """Expiry: every open leg of `expiry` closes at intrinsic value against `spot`. STT on ITM longs only."""
        fills = []
        basket = None
        for p in [p for p in self.open_positions() if p.expiry == expiry]:
            basket = basket or self._id("OB", now)
            price = r2(p.intrinsic(spot))
            qty = abs(p.qty)
            side = SELL if p.qty > 0 else BUY
            value = r2(price * qty)
            stt = r2(value * SETTLE_STT_RATE) if p.qty > 0 and price > 0 else 0.0
            booked = p.apply(side, qty, price)
            f = Fill(self._id("OF", now), basket, p.security_id, side, qty, price, value,
                     Charges(brokerage=0.0, stt=stt, transaction=0.0, sebi=0.0, stamp=0.0, gst=0.0), now, "settle",
                     booked, p.symbol, p.expiry, p.strike, p.option_type, p.lot_size)
            self.fills.append(f)
            fills.append(f)
        if fills and not self.open_positions():
            self.blocked_margin = 0.0
        return fills

    def _fill(self, leg, avg, value, capped, now, basket, kind):
        pos = self.positions.setdefault(leg.security_id, _new_position(leg))
        was = pos.qty
        booked = pos.apply(leg.side, leg.qty, avg)
        kind = kind or ("open" if was == 0 or (was > 0) == (leg.side == BUY) else "close")
        f = Fill(self._id("OF", now), basket, leg.security_id, leg.side, leg.qty, avg, value, order_charges(leg.side, value),
                 now, kind, booked, leg.symbol, leg.expiry, leg.strike, leg.option_type, leg.lot_size, capped)
        self.fills.append(f)
        return f

    # ---------- restart ----------
    def restore(self, fills, blocked_margin=0.0):
        """Rebuilds the period from its stored fills (every day, oldest first) and the margin blocked now."""
        self.fills, self.positions, self._seq = [], {}, {}
        for d in sorted(fills, key=lambda d: (d["time"], d["id"])):
            f = Fill.from_dict(d)
            pos = self.positions.setdefault(f.security_id, OptPosition(f.security_id, f.lot_size, f.symbol, f.expiry,
                                                                       f.strike, f.option_type))
            pos.apply(f.side, f.qty, f.price)
            self.fills.append(f)
            for prefix, i in (("OF", f.id), ("OB", f.basket_id)):
                key = (prefix, f.time.date())
                n = int(i.rsplit("-", 1)[-1]) if "-" in i else 0
                self._seq[key] = max(self._seq.get(key, 0), n)
        self.blocked_margin = float(blocked_margin) if self.open_positions() else 0.0

    def day_rows(self, day):
        """Per instrument, the fills of one IST day as a pt_positions row (buys, sells, realized booked that day)."""
        rows = {}
        for f in self.fills:
            if f.time.date().isoformat() != day:
                continue
            r = rows.setdefault(f.security_id, {"security_id": f.security_id, "lot_size": f.lot_size, "buy_qty": 0,
                                                "buy_value": 0.0, "sell_qty": 0, "sell_value": 0.0, "realized": 0.0})
            k = "buy" if f.side == BUY else "sell"
            r[f"{k}_qty"] += f.qty
            r[f"{k}_value"] = r2(r[f"{k}_value"] + f.value)
            r["realized"] = r2(r["realized"] + f.realized)
        return [{"security_id": r["security_id"], "lot_size": r["lot_size"], "buy_qty": r["buy_qty"], "sell_qty": r["sell_qty"],
                 "avg_buy": round(r["buy_value"] / r["buy_qty"], 4) if r["buy_qty"] else 0.0,
                 "avg_sell": round(r["sell_value"] / r["sell_qty"], 4) if r["sell_qty"] else 0.0,
                 "realized": r["realized"]} for r in rows.values()]


def _new_position(leg):
    return OptPosition(leg.security_id, leg.lot_size, leg.symbol, leg.expiry, leg.strike, leg.option_type)


def _copy(p):
    return OptPosition(p.security_id, p.lot_size, p.symbol, p.expiry, p.strike, p.option_type, p.qty, p.avg, p.realized)


def _premium_flow(positions):
    return sum(-p.qty * p.avg for p in positions.values())
