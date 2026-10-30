"""
mtm_limit.py - the day MTM limit of a manual strategy (Trade Window, Power Scalper; pure).

Day MTM = today's booked P&L − today's charges + the open positions at the live price (PaperService.funds dayPnl).
When it reaches +profit or −loss (₹, either may be off), every pending order is cancelled, every open position is sold
at market and new BUY orders are refused for the rest of that day, even if the limits are changed or MTM comes back.

Profit lock (Naveen, 30-Oct): "at +2,500 I set target 3,000 and lock 2,000: if the market goes my way I exit at 3k, if
not at 2k, in profit either way". The lock arms once day MTM has been above it that day (at once when it already is),
then fires the same way when day MTM falls back to it. Whichever of target, loss, lock or a position's own stop is
reached first acts first. The limits stay set for the next days until changed; the lock re-arms each day.
"""
import json


def parse_limit(profit, loss, lock=None):
    """Validated {profit, loss, lock} (profit / loss ₹ > 0, lock ₹ ≥ 0 and below the target; None = off).
    Raises ValueError."""
    out = {}
    if lock is not None:
        lock = round(float(lock), 2)
        if lock < 0:
            raise ValueError("The profit lock must be ₹0 or more (or off).")
        if profit is not None and lock >= float(profit):
            raise ValueError("The profit lock must be below the profit target.")
    out["lock"] = lock
    for name, v in (("profit", profit), ("loss", loss)):
        if v is None:
            out[name] = None
            continue
        v = float(v)
        if not v > 0:
            raise ValueError(f"The {name} limit must be above ₹0 (or off).")
        out[name] = round(v, 2)
    return out


def breach(day_pnl, limit, lock_armed=False):
    """'profit' / 'loss' / 'lock' when day MTM reached that limit, else None."""
    if not limit:
        return None
    if limit.get("profit") is not None and day_pnl >= limit["profit"]:
        return "profit"
    if limit.get("loss") is not None and day_pnl <= -limit["loss"]:
        return "loss"
    if lock_armed and limit.get("lock") is not None and day_pnl <= limit["lock"]:
        return "lock"
    return None


def arms(day_pnl, limit):
    """True when day MTM is above the profit lock (it arms it for the day)."""
    return bool(limit) and limit.get("lock") is not None and day_pnl > limit["lock"]


def is_set(limit):
    return bool(limit) and any(limit.get(k) is not None for k in ("profit", "loss", "lock"))


def loads(raw, default):
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


def hit_text(hit):
    if hit["kind"] == "lock":
        return (f"Profit lock reached at {hit['at']} (day MTM ₹{hit['pnl']:,.2f}): positions closed with the profit kept, "
                "new buys are off until tomorrow.")
    kind = "Profit" if hit["kind"] == "profit" else "Loss"
    return (f"{kind} MTM limit reached at {hit['at']} (day MTM ₹{hit['pnl']:,.2f}): positions closed, "
            "new buys are off until tomorrow.")
