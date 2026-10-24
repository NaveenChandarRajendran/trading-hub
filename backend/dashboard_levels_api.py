"""
dashboard_levels_api.py - the Dashboard's "Fix zones": a frozen S1-S3 / R1-R3 set per index + expiry, stored in
Postgres (dashboard_fixed_levels) so it survives a page refresh and a backend restart.

    GET    /api/dashboard/fixed-levels?index=NIFTY&expiry=2026-10-27   -> {"fixed": null | {"fixedAt", "levels"}}
    PUT    /api/dashboard/fixed-levels  {"index", "expiry", "levels": {"R1": 22800, ..., "S3": 22200}}
                                         -> {"fixed": {...}} (fixed_at stamped by the server, IST; replaces the active set)
    DELETE /api/dashboard/fixed-levels?index=NIFTY&expiry=2026-10-27   -> {"fixed": null}
The levels are whatever the chart showed when "Fix zones" was ticked (the page sends them).
"""
import re

from fastapi import HTTPException
from pydantic import BaseModel

from dhan_client import SCRIP

SLOTS = ("R1", "R2", "R3", "S1", "S2", "S3")


class FixBody(BaseModel):
    index: str
    expiry: str
    levels: dict[str, float | None]


def _key(index, expiry):
    index = (index or "").strip().upper()
    if index not in SCRIP:
        raise HTTPException(400, f"index must be one of {list(SCRIP)}")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiry or ""):
        raise HTTPException(400, "expiry must look like 2026-10-27")
    return index, expiry


def register(app, store, clock):
    def db(fn, *a):
        try:
            return fn(*a)
        except HTTPException:
            raise
        except Exception as e:  # database unreachable
            raise HTTPException(503, f"Database unavailable: {e}")

    @app.get("/api/dashboard/fixed-levels")
    def get_fixed(index: str = "", expiry: str = ""):
        return {"fixed": db(store.fixed_levels, *_key(index, expiry))}

    @app.put("/api/dashboard/fixed-levels")
    def fix(body: FixBody):
        index, expiry = _key(body.index, body.expiry)
        bad = [k for k in body.levels if k not in SLOTS]
        if bad:
            raise HTTPException(400, f"unknown level slots {bad}; use {', '.join(SLOTS)}")
        levels = {k: v for k, v in body.levels.items() if v is not None}
        if not levels:
            raise HTTPException(400, "no levels to fix")
        return {"fixed": db(store.fix_levels, index, expiry, levels, clock())}

    @app.delete("/api/dashboard/fixed-levels")
    def unfix(index: str = "", expiry: str = ""):
        db(store.unfix_levels, *_key(index, expiry), clock())
        return {"fixed": None}
