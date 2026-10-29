"""
mtm_limit.py - the day MTM limit of a manual strategy (Trade Window, Power Scalper; pure).

Day MTM = today's booked P&L − today's charges + the open positions at the live price (PaperService.funds dayPnl).
When it reaches +profit or −loss (₹, either may be off), every pending order is cancelled, every open position is sold
at market and new BUY orders are refused for the rest of that day, even if the limits are changed or MTM comes back.
The limits stay set for the next days until changed.
"""
import json


def parse_limit(profit, loss):
    """Validated {profit, loss} (₹ > 0, or None = off). Raises ValueError."""
    out = {}
    for name, v in (("profit", profit), ("loss", loss)):
        if v is None:
            out[name] = None
            continue
        v = float(v)
        if not v > 0:
            raise ValueError(f"The {name} limit must be above ₹0 (or off).")
        out[name] = round(v, 2)
    return out


def breach(day_pnl, limit):
    """'profit' / 'loss' when day MTM reached that limit, else None."""
    if not limit:
        return None
    if limit.get("profit") is not None and day_pnl >= limit["profit"]:
        return "profit"
    if limit.get("loss") is not None and day_pnl <= -limit["loss"]:
        return "loss"
    return None


def loads(raw, default):
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


def hit_text(hit):
    kind = "Profit" if hit["kind"] == "profit" else "Loss"
    return (f"{kind} MTM limit reached at {hit['at']} (day MTM ₹{hit['pnl']:,.2f}): positions closed, "
            "new buys are off until tomorrow.")
