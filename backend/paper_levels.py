"""
paper_levels.py - the OI support / resistance levels at the moment of each paper order, and what happened to them
while the position stayed open. Information only: nothing here ever exits a position or places an order.

- Each order keeps the levels recorded by the tracker (stability rule, sr_levels.py) for its index at order time,
  with the spot of that refresh (table pt_order_levels).
- ENTRY ZONE of an open position: the level nearest spot, on either side, in the snapshot of the BUY that opened it.
- LEVEL SHIFT near the zone: a recorded change, after that snapshot, of a level whose old strike was within
  SHIFT_PTS of the zone strike. Renumbering that follows another shift is not counted again.
Times are 'YYYY-MM-DD HH:MM' IST, like the level history.
"""
from sr_levels import changes_from

SHIFT_PTS = 100


def nearest_zone(levels, spot):
    """{slot: strike} -> {"slot", "strike"} nearest spot (a tie goes to support, then the lower slot), or None."""
    if not levels or not spot:
        return None
    slot, strike = min(levels.items(), key=lambda kv: (abs(kv[1] - spot), kv[0][0] != "S", kv[0]))
    return {"slot": slot, "strike": strike}


def order_snapshot(order_id, snap, at):
    """The pt_order_levels row for one order. snap: TrackerLevels.snapshot(); at: the order time (ISO)."""
    return {"order_id": order_id, "symbol": snap["symbol"], "expiry": snap["expiry"], "date": snap["date"],
            "spot": snap["spot"], "levelsAt": snap["at"], "levels": dict(snap["levels"]),
            "zone": nearest_zone(snap["levels"], snap["spot"]), "created_at": at}


def opening_order(trades, security_id):
    """Order id of the BUY that opened the current position in security_id (quantity went 0 -> above 0), or None
    when flat. trades: the day's fills, oldest first."""
    qty, opener = 0, None
    for t in trades:
        if t["security_id"] != security_id:
            continue
        if t["side"] == "BUY":
            if qty == 0:
                opener = t["order_id"]
            qty += t["qty"]
        else:
            qty -= t["qty"]
            if qty <= 0:
                qty, opener = 0, None
    return opener


def shifts_near(changes, zone, since, pts=SHIFT_PTS):
    """Level changes after `since` whose old strike was within pts of the zone, newest first:
    [{id, at, slot, from, to, reason}] (to None: the slot emptied). id is stable, for "warn once per shift"."""
    out = [{"id": f"{c['slot']}|{c['at']}", **c} for c in changes
           if c["at"] > since and c["reason"] != "renumber" and abs(c["from"] - zone["strike"]) <= pts]
    return sorted(out, key=lambda c: (c["at"], c["slot"]), reverse=True)


class TrackerLevels:
    """Levels source for PaperService, backed by the Trending OI tracker that records them."""

    def __init__(self, tracker):
        self.tracker = tracker

    def snapshot(self, symbol, expiry):
        return self.tracker.levels_snapshot(symbol, expiry)

    def changes(self, symbol, expiry, date):
        return changes_from(self.tracker.store.sr_rows(symbol, expiry, date))
