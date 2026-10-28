"""
scalper_api.py - Power Scalper routes (/api/scalper/*). PAPER ONLY (scalper_service.py).
Every route that touches an account takes ?strategy=<id>: the signed-in user's own strategy (404 otherwise);
orders need an active manual one. Capital lives on the strategy (/api/strategies/{id}/capital | reset); the two
capital routes below are kept for the page and do the same.

  GET  /api/scalper/account?strategy=            strategy, capital period, funds, meta, capital presets
  PUT  /api/scalper/account/capital?strategy= {capital}     change capital (flat book only)
  POST /api/scalper/account/reset?strategy= {capital?}      new capital period, history kept
  GET  /api/scalper/positions?strategy= | /api/scalper/orders?strategy=&date=
  POST /api/scalper/orders?strategy= {securityId, side, lots}   MARKET order in one click
  POST /api/scalper/exit/{securityId}?strategy= {pct?}   at market: all, or 25 / 50 / 75 % of the open lots
                                                        (rounded down, at least 1 lot) | /api/scalper/exit-all?strategy=
  PUT  /api/scalper/trail/{securityId}?strategy= {distance, step?, after?}   trailing stop in points; distance null = off
  PUT  /api/scalper/protection/{securityId}?strategy= {target?, stop?}   OCO target / stop; null cancels, absent keeps
  GET  /api/scalper/reports?strategy=&from=&to=  tiles + day-wise table
  GET  /api/scalper/day?strategy=&date=          round trips and fills of one day
  POST /api/scalper/summary?strategy=&date=      (re)write the strategy's pt_daily_summary row for a day
  GET  /api/scalper/candles?securityId=          an option's 1-minute candles, today + previous session (Dhan history)
  WS   /ws/scalper?strategy=                     see scalper_service.py
"""
import asyncio
from datetime import date as Date

from fastapi import HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from dhan_client import DhanError, TokenExpired

from paper_api import _day, resolve
from paper_engine import KEEP, OrderError
from scalper_service import CAPITAL_PRESETS, default_range
from strategies import NotFound, Refused, public


class OrderBody(BaseModel):
    securityId: int
    side: str
    lots: int = 1


class CapitalBody(BaseModel):
    capital: float


class ResetBody(BaseModel):
    capital: float | None = None


class ExitBody(BaseModel):
    pct: int = 100


class TrailBody(BaseModel):
    distance: float | None = None
    step: float = 1.0
    after: float | None = None


class ProtectionBody(BaseModel):
    target: float | None = None
    stop: float | None = None


def register(app, svc, strategies):
    paper = svc.paper

    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except OrderError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    def book(request, strategy, trade=False):
        return paper.book(resolve(strategies, request, strategy, trade))

    def account_body(request, strategy):
        st = resolve(strategies, request, strategy)
        s = svc.snapshot(paper.book(st))
        return {"meta": s["meta"], "strategy": public(st), "account": s["account"], "funds": s["funds"],
                "presets": list(CAPITAL_PRESETS)}

    def capital(fn, request, strategy, *args):
        resolve(strategies, request, strategy)
        try:
            fn(request.state.user, strategy, *args)
        except NotFound:
            raise HTTPException(404, "Strategy not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None
        return account_body(request, strategy)

    @app.get("/api/scalper/account")
    def account(request: Request, strategy: str = ""):
        return account_body(request, strategy)

    @app.put("/api/scalper/account/capital")
    def set_capital(body: CapitalBody, request: Request, strategy: str = ""):
        return capital(strategies.set_capital, request, strategy, body.capital)

    @app.post("/api/scalper/account/reset")
    def reset(request: Request, strategy: str = "", body: ResetBody | None = None):
        return capital(strategies.reset, request, strategy, body.capital if body else None)

    def positions_body(b):
        return {"meta": paper.meta(b), "rows": paper.positions(b), "funds": paper.funds(b)}

    @app.get("/api/scalper/positions")
    def positions(request: Request, strategy: str = ""):
        return positions_body(book(request, strategy))

    @app.get("/api/scalper/orders")
    def orders(request: Request, strategy: str = "", date: str = ""):
        b = book(request, strategy)
        return {"meta": paper.meta(b), "rows": paper.orders(b, _day(date, "date"))}

    @app.post("/api/scalper/orders")
    def place(body: OrderBody, request: Request, strategy: str = ""):
        b = book(request, strategy, trade=True)
        order = run(svc.place_order, b, body.securityId, body.side.upper(), body.lots)
        return {"order": order, "funds": paper.funds(b)}

    @app.post("/api/scalper/exit/{security_id}")
    def exit_one(security_id: int, request: Request, body: ExitBody | None = None, strategy: str = ""):
        b = book(request, strategy, trade=True)
        pct = body.pct if body else 100
        if pct == 100:
            run(svc.exit_position, b, security_id)
        else:
            run(svc.exit_partial, b, security_id, pct)
        return positions_body(b)

    @app.put("/api/scalper/trail/{security_id}")
    def trail(security_id: int, body: TrailBody, request: Request, strategy: str = ""):
        b = book(request, strategy, trade=True)
        pos = run(svc.set_trail, b, security_id, body.distance, body.step, body.after)
        return {"position": pos, "orders": [o for o in paper.orders(b) if o["security_id"] == security_id]}

    @app.post("/api/scalper/exit-all")
    def exit_all(request: Request, strategy: str = ""):
        b = book(request, strategy, trade=True)
        run(svc.exit_all, b)
        return positions_body(b)

    @app.put("/api/scalper/protection/{security_id}")
    def protection(security_id: int, body: ProtectionBody, request: Request, strategy: str = ""):
        given = body.model_fields_set
        if not given:
            raise HTTPException(400, "send target and / or stop (a price, or null to cancel)")
        b = book(request, strategy, trade=True)
        pos = run(svc.set_protection, b, security_id, target=body.target if "target" in given else KEEP,
                  stop=body.stop if "stop" in given else KEEP)
        return {"position": pos, "orders": [o for o in paper.orders(b) if o["security_id"] == security_id]}

    @app.get("/api/scalper/reports")
    def reports(request: Request, strategy: str = "", from_day: str = Query("", alias="from"), to: str = ""):
        b = book(request, strategy)
        start, end = default_range(svc.clock().date())
        start, end = _day(from_day, "from") or start, _day(to, "to") or end
        if start > end:
            raise HTTPException(400, "from must not be after to")
        return {"meta": {**paper.meta(b), "from": start, "to": end}, **paper.reports(b, start, end)}

    @app.get("/api/scalper/day")
    def day(request: Request, strategy: str = "", date: str = ""):
        b = book(request, strategy)
        return {"meta": paper.meta(b), **paper.day_view(b, _day(date, "date") or svc.clock().date().isoformat())}

    @app.get("/api/scalper/candles")
    def candles(securityId: int):  # noqa: N803 (query name used by the page)
        try:
            inst, rows = svc.history(securityId)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except TokenExpired as e:
            raise HTTPException(401, f"{e} Send a new one with POST /api/token.")
        except (DhanError, RuntimeError) as e:
            raise HTTPException(502, str(e))
        return {"meta": {**paper.meta(), "securityId": securityId, "name": inst.get("name"), "interval": 1},
                "candles": rows}

    @app.websocket("/ws/scalper")
    async def ws_scalper(ws: WebSocket):
        user = ws.state.user

        def pick(value):
            """A manual strategy of this user -> its Book; anything else -> None (prices only)."""
            try:
                st = strategies.get(user, value) if value else None
            except (NotFound, Refused):
                return None
            return paper.book(st) if st and st["kind"] == "manual" else None
        b = pick(ws.query_params.get("strategy"))
        await ws.accept()
        client = svc.add_client(asyncio.get_running_loop(), user.id, b.strategy_id if b else None)

        async def pump():
            while True:
                await ws.send_json(await client.queue.get())

        sender = asyncio.create_task(pump())
        try:
            await ws.send_json(svc.snapshot(b))
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                if kind in ("subscribe", "unsubscribe"):
                    try:
                        svc.client_subscribe(client, msg.get("instruments") or [], add=kind == "subscribe")
                    except (TypeError, ValueError):
                        await ws.send_json({"type": "error", "data": {"message": "instruments must be [[segment, id]]"}})
                elif kind == "strategy":
                    b = pick(str(msg.get("id") or ""))
                    client.strategy_id = b.strategy_id if b else None
                    await ws.send_json(svc.snapshot(b))
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            svc.remove_client(client)

    @app.post("/api/scalper/summary")
    def summary(request: Request, strategy: str = "", date: str = ""):
        b = book(request, strategy)
        d = _day(date, "date") or svc.clock().date().isoformat()
        Date.fromisoformat(d)
        return {"row": paper.write_summary(b, d)}
