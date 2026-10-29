"""
options_api.py - options strategies (ADR 0010; options_service.py). PAPER ONLY. ?strategy=<id> is the signed-in user's
own options strategy (someone else's: 404; another kind: 400; archived: 409 for trading).

    POST /api/options/basket?strategy= {legs: [{securityId, side B|S, lots}]}   all-or-nothing at market
         -> {fills, ...positions}; 409 with the reason when refused (no market on a leg, margin, funds, hours)
    POST /api/options/exit?strategy= {securityId?}     one leg, or every open leg without securityId
    GET  /api/options/positions?strategy=              open legs (ltp, P&L), funds, margin blocked, pending settlement
    GET  /api/options/report?strategy=                 summary, months, trades (options_report.py)
    GET  /api/options/portfolios                       every options strategy of the user with its report summary
"""
from fastapi import HTTPException, Request
from pydantic import BaseModel

from options_engine import OrderError
from paper_api import resolve


class BasketLeg(BaseModel):
    securityId: int
    side: str
    lots: int


class BasketBody(BaseModel):
    legs: list[BasketLeg]


class ExitBody(BaseModel):
    securityId: int | None = None


def register(app, svc, strategies):
    def options_strategy(request, value, trade=False):
        st = resolve(strategies, request, value, manual=False)
        if st["kind"] != "options":
            raise HTTPException(400, "Pick an Options strategy (create one on the Strategies page).")
        if trade and st["archived_at"]:
            raise HTTPException(409, "This strategy is archived. Unarchive it to trade into it.")
        return st

    def run(fn, *a, **k):
        try:
            return fn(*a, **k)
        except OrderError as e:
            raise HTTPException(409, str(e)) from None
        except LookupError as e:
            raise HTTPException(404, str(e)) from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/api/options/basket")
    def basket(body: BasketBody, request: Request, strategy: str = ""):
        st = options_strategy(request, strategy, trade=True)
        if not body.legs or len(body.legs) > 8:
            raise HTTPException(400, "A basket has 1 to 8 legs.")
        if any(l.side not in ("B", "S") or l.lots < 1 or l.lots > 100 for l in body.legs):
            raise HTTPException(400, "Each leg needs side B / S and 1 to 100 lots.")
        fills = run(svc.place_basket, st, [l.model_dump() for l in body.legs])
        return {"fills": [svc.fill_view(f) for f in fills], **svc.positions(st)}

    @app.post("/api/options/exit")
    def exit_(request: Request, body: ExitBody | None = None, strategy: str = ""):
        st = options_strategy(request, strategy, trade=True)
        fills = run(svc.exit, st, body.securityId if body else None)
        return {"fills": [svc.fill_view(f) for f in fills], **svc.positions(st)}

    @app.get("/api/options/positions")
    def positions(request: Request, strategy: str = ""):
        return svc.positions(options_strategy(request, strategy))

    @app.get("/api/options/report")
    def report(request: Request, strategy: str = ""):
        return svc.report(options_strategy(request, strategy))

    @app.get("/api/options/portfolios")
    def portfolios(request: Request):
        rows = [s for s in strategies.store.strategies(request.state.user.id) if s["kind"] == "options"]
        out = []
        for st in rows:
            r = svc.report(st)
            out.append({**r["strategy"], "summary": r["summary"], "updatedAt": max(
                (t["closedAt"] or t["entered"] for t in r["trades"]), default=None)})
        return {"rows": sorted(out, key=lambda r: (r["archived"], -(r["id"])))}
