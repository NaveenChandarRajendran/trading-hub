"""
sr_api.py - OI support / resistance level history (recorded by the tracker every minute, see sr_levels.py).

    GET /api/sr/history?symbol=NIFTY&expiry=2026-10-27&date=2026-10-22
        {"meta": {...}, "current": {"R": [...], "S": [...]}, "segments": [...], "changes": [...]}
    GET /api/sr/settings          -> {"leadPct": 10, "confirmRefreshes": 3, "range": 500}
    PUT /api/sr/settings  {...}   -> the saved settings (shared by every browser; used from the next refresh)
Times are 'YYYY-MM-DD HH:MM' IST. OI is in units.
"""
import re

from fastapi import HTTPException
from pydantic import BaseModel

from dhan_client import SCRIP, DhanError

LIMITS = {"leadPct": (0.0, 100.0), "confirmRefreshes": (1, 30), "range": (50.0, 3000.0)}


class SettingsBody(BaseModel):
    leadPct: float | None = None
    confirmRefreshes: int | None = None
    range: float | None = None


def changes_from(rows):
    """[{at, slot, from, to, reason}] newest first, from the history rows (the day's first set is not a change)."""
    by_slot = {}
    for r in sorted(rows, key=lambda r: r["valid_from"]):
        by_slot.setdefault(r["slot"], []).append(r)
    out = []
    for slot, seq in by_slot.items():
        for prev, cur in zip(seq, seq[1:]):
            out.append({"at": cur["valid_from"], "slot": slot, "from": prev["strike"], "to": cur["strike"], "reason": cur["reason"]})
        last = seq[-1]
        if last.get("valid_to") and not any(r["valid_from"] == last["valid_to"] for r in seq):  # slot left empty
            out.append({"at": last["valid_to"], "slot": slot, "from": last["strike"], "to": None, "reason": "gone"})
    return sorted(out, key=lambda c: (c["at"], c["slot"]), reverse=True)


def register(app, tracker, get_expiries):
    @app.get("/api/sr/history")
    def history(symbol: str = "NIFTY", expiry: str = "", date: str = ""):
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        for name, v in (("expiry", expiry), ("date", date)):
            if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                raise HTTPException(400, f"{name} must look like 2026-10-27")
        if not expiry:
            try:
                expiry = get_expiries(symbol)[0]
            except DhanError as e:
                raise HTTPException(502, str(e))
        today = tracker.clock().strftime("%Y-%m-%d")
        date = date or today
        try:
            rows = tracker.store.sr_rows(symbol, expiry, date)
        except Exception as e:  # database unreachable
            raise HTTPException(503, f"Database unavailable: {e}")
        live = tracker.current_levels(symbol, expiry, date) if date == today else None
        current_rows = live if live is not None else {r["slot"]: r for r in rows if r.get("valid_to") is None}
        current = {side: [current_rows[f"{side}{i}"] for i in (1, 2, 3) if f"{side}{i}" in current_rows] for side in ("R", "S")}
        if not rows:
            message = ("No levels recorded for this day." if date != today else
                       "No levels yet: they are recorded every minute while the market is open, for the tracked expiries.")
        else:
            message = ""
        return {
            "meta": {"symbol": symbol, "expiry": expiry, "date": date, "asOf": tracker.clock().strftime("%Y-%m-%d %H:%M:%S"),
                     "marketOpen": tracker.market_open(), "settings": dict(tracker.sr_settings), "message": message},
            "current": current,
            "segments": rows,
            "changes": changes_from(rows),
        }

    @app.get("/api/sr/settings")
    def get_settings():
        return dict(tracker.sr_settings)

    @app.put("/api/sr/settings")
    def put_settings(body: SettingsBody):
        new = dict(tracker.sr_settings)
        for k, (lo, hi) in LIMITS.items():
            v = getattr(body, k)
            if v is None:
                continue
            if not lo <= v <= hi:
                raise HTTPException(400, f"{k} must be between {lo:g} and {hi:g}")
            new[k] = v
        try:
            tracker.store.save_sr_settings(new)
        except Exception as e:
            raise HTTPException(503, f"Database unavailable: {e}")
        tracker.sr_settings = new
        return new
