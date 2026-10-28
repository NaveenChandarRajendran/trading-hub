"""
builder_api.py - Strategy Builder routes (designs only: nothing here places an order; builder.py has the draft rules).

    GET    /api/builder/drafts                       {"drafts": [...]} the signed-in user's, newest first
    POST   /api/builder/drafts {name, symbol, multiplier, legs}           -> {"draft"}
    PUT    /api/builder/drafts/{id} {name?, symbol?, multiplier?, legs?}  -> {"draft"}  (someone else's: 404)
    DELETE /api/builder/drafts/{id}
    POST   /api/builder/margin {legs: [{securityId, side B|S, qty, price}]}
           -> {total, span, exposure, hedgeBenefit} from Dhan's basket margin calculator (cached 30 s per basket);
              502 "margin unavailable" when Dhan can't answer, 401 when the token expired
    GET    /api/builder/positions?strategy=<id>     open positions of the user's own manual strategy, as legs
"""
import threading
import time

from fastapi import HTTPException, Request
from pydantic import BaseModel

from builder import Drafts, public_draft
from dhan_client import DhanError, TokenExpired
from paper_api import resolve
from strategies import NotFound, Refused

MARGIN_TTL_SECONDS = 30
MARGIN_MAX_LEGS = 8


class DraftBody(BaseModel):
    name: str
    symbol: str
    multiplier: int = 1
    legs: list[dict]


class DraftEdit(BaseModel):
    name: str | None = None
    symbol: str | None = None
    multiplier: int | None = None
    legs: list[dict] | None = None


class MarginLeg(BaseModel):
    securityId: int
    side: str
    qty: int
    price: float


class MarginBody(BaseModel):
    legs: list[MarginLeg]


def register(app, drafts: Drafts, paper, strategies, margin_multi=None, clock=time.monotonic):
    """margin_multi(scripts) -> {total, span, exposure, hedgeBenefit} (DhanClient.margin_multi); None = unavailable."""
    cache, lock = {}, threading.Lock()

    def run(fn, *a, **k):
        try:
            return fn(*a, **k)
        except NotFound:
            raise HTTPException(404, "Not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None

    @app.get("/api/builder/drafts")
    def list_drafts(request: Request):
        return {"drafts": [public_draft(d) for d in drafts.list(request.state.user)]}

    @app.post("/api/builder/drafts")
    def create(body: DraftBody, request: Request):
        return {"draft": public_draft(run(drafts.create, request.state.user, body.name, body.symbol, body.multiplier, body.legs))}

    @app.put("/api/builder/drafts/{did}")
    def update(did: str, body: DraftEdit, request: Request):
        return {"draft": public_draft(run(drafts.update, request.state.user, did, body.name, body.symbol, body.multiplier, body.legs))}

    @app.delete("/api/builder/drafts/{did}")
    def delete(did: str, request: Request):
        run(drafts.delete, request.state.user, did)
        return {"ok": True}

    @app.post("/api/builder/margin")
    def margin(body: MarginBody):
        legs = body.legs
        if not legs or len(legs) > MARGIN_MAX_LEGS:
            raise HTTPException(400, f"Send 1 to {MARGIN_MAX_LEGS} legs.")
        if any(l.side not in ("B", "S") or l.qty <= 0 or l.price < 0 for l in legs):
            raise HTTPException(400, "Each leg needs side B / S, a quantity above 0 and a price of 0 or more.")
        if margin_multi is None:
            raise HTTPException(503, "Margin unavailable: no Dhan connection.")
        key = tuple(sorted((l.securityId, l.side, l.qty, round(l.price, 2)) for l in legs))
        with lock:
            hit = cache.get(key)
            if hit and clock() - hit[0] < MARGIN_TTL_SECONDS:
                return {**hit[1], "cached": True}
        scripts = [{"securityId": l.securityId, "transactionType": "BUY" if l.side == "B" else "SELL",
                    "quantity": l.qty, "price": l.price} for l in legs]
        try:
            m = margin_multi(scripts)
        except TokenExpired as e:
            raise HTTPException(401, f"{e} Send a new one with POST /api/token.") from None
        except DhanError as e:
            raise HTTPException(502, f"Margin unavailable: {e}") from None
        with lock:
            cache[key] = (clock(), m)
            if len(cache) > 200:  # designs change often: keep the cache small
                for k in sorted(cache, key=lambda k: cache[k][0])[:100]:
                    cache.pop(k, None)
        return {**m, "cached": False}

    @app.get("/api/builder/positions")
    def positions(request: Request, strategy: str = ""):
        st = resolve(strategies, request, strategy)
        rows = [p for p in paper.positions(paper.book(st)) if p["open_qty"] > 0 and p.get("optionType")]
        return {"strategy": {"id": st["id"], "name": st["name"]}, "legs": [
            {"securityId": p["security_id"], "name": p["name"], "symbol": p["symbol"], "expiry": p["expiry"],
             "strike": p["strike"], "type": p["optionType"], "side": "B", "lots": p["open_qty"] // p["lot_size"],
             "lotSize": p["lot_size"], "price": round(p["avg_buy"], 2)} for p in rows]}
