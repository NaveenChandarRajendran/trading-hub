"""
scalper_api.py - Power Scalper routes (/api/scalper/*). PAPER ONLY (scalper_service.py).

  GET  /api/scalper/account                      account, funds, meta, capital presets
  PUT  /api/scalper/account/capital {capital}     change capital (flat book only)
  POST /api/scalper/account/reset {capital?}      fresh start: new Scalper account, history kept
  GET  /api/scalper/positions | /api/scalper/orders?date=
  POST /api/scalper/orders {securityId, side, lots}   MARKET order in one click
  POST /api/scalper/exit/{securityId} | /api/scalper/exit-all
  PUT  /api/scalper/protection/{securityId} {target?, stop?}   OCO target / stop; null cancels a leg, absent keeps it
  GET  /api/scalper/reports?from=&to=            tiles + day-wise table
  GET  /api/scalper/day?date=                    round trips and fills of one day
  POST /api/scalper/summary?date=                (re)write scalper_daily_summary for a day
  GET  /api/scalper/candles?securityId=          an option's 1-minute candles, today + previous session (Dhan history)
  WS   /ws/scalper                               see scalper_service.py
"""
import asyncio
from datetime import date as Date

from fastapi import HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from dhan_client import DhanError, TokenExpired

from paper_api import MAX_CAPITAL, MIN_CAPITAL, _day
from paper_engine import KEEP, OrderError
from scalper_service import CAPITAL_PRESETS, default_range


class OrderBody(BaseModel):
    securityId: int
    side: str
    lots: int = 1


class CapitalBody(BaseModel):
    capital: float


class ResetBody(BaseModel):
    capital: float | None = None


class ProtectionBody(BaseModel):
    target: float | None = None
    stop: float | None = None


def _check_capital(capital):
    if not MIN_CAPITAL <= capital <= MAX_CAPITAL:
        raise HTTPException(400, f"capital must be between {MIN_CAPITAL:,} and {MAX_CAPITAL:,} rupees "
                                 f"(presets: {', '.join(f'{p:,}' for p in CAPITAL_PRESETS)})")


def register(app, svc):
    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except OrderError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/scalper/account")
    def account():
        s = svc.snapshot()
        return {"meta": s["meta"], "account": s["account"], "funds": s["funds"], "presets": list(CAPITAL_PRESETS)}

    @app.put("/api/scalper/account/capital")
    def set_capital(body: CapitalBody):
        _check_capital(body.capital)
        run(svc.set_capital, body.capital)
        return account()

    @app.post("/api/scalper/account/reset")
    def reset(body: ResetBody | None = None):
        capital = body.capital if body else None
        if capital is not None:
            _check_capital(capital)
        run(svc.reset_account, capital)
        return account()

    @app.get("/api/scalper/positions")
    def positions():
        return {"meta": svc.meta(), "rows": svc.positions(), "funds": svc.funds()}

    @app.get("/api/scalper/orders")
    def orders(date: str = ""):
        return {"meta": svc.meta(), "rows": svc.orders(_day(date, "date"))}

    @app.post("/api/scalper/orders")
    def place(body: OrderBody):
        order = run(svc.place_order, body.securityId, body.side.upper(), body.lots)
        return {"order": order, "funds": svc.funds()}

    @app.post("/api/scalper/exit/{security_id}")
    def exit_one(security_id: int):
        run(svc.exit_position, security_id)
        return positions()

    @app.post("/api/scalper/exit-all")
    def exit_all():
        run(svc.exit_all)
        return positions()

    @app.put("/api/scalper/protection/{security_id}")
    def protection(security_id: int, body: ProtectionBody):
        given = body.model_fields_set
        if not given:
            raise HTTPException(400, "send target and / or stop (a price, or null to cancel)")
        pos = run(svc.set_protection, security_id, target=body.target if "target" in given else KEEP,
                  stop=body.stop if "stop" in given else KEEP)
        return {"position": pos, "orders": [o for o in svc.orders() if o["security_id"] == security_id]}

    @app.get("/api/scalper/reports")
    def reports(from_day: str = Query("", alias="from"), to: str = ""):
        start, end = default_range(svc.clock().date())
        start, end = _day(from_day, "from") or start, _day(to, "to") or end
        if start > end:
            raise HTTPException(400, "from must not be after to")
        return {"meta": {**svc.meta(), "from": start, "to": end}, **svc.reports(start, end)}

    @app.get("/api/scalper/day")
    def day(date: str = ""):
        return {"meta": svc.meta(), **svc.day_view(_day(date, "date") or svc.clock().date().isoformat())}

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
        return {"meta": {**svc.meta(), "securityId": securityId, "name": inst.get("name"), "interval": 1},
                "candles": rows}

    @app.websocket("/ws/scalper")
    async def ws_scalper(ws: WebSocket):
        await ws.accept()
        client = svc.add_client(asyncio.get_running_loop())

        async def pump():
            while True:
                await ws.send_json(await client.queue.get())

        sender = asyncio.create_task(pump())
        try:
            await ws.send_json(svc.snapshot())
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                if kind in ("subscribe", "unsubscribe"):
                    try:
                        svc.client_subscribe(client, msg.get("instruments") or [], add=kind == "subscribe")
                    except (TypeError, ValueError):
                        await ws.send_json({"type": "error", "data": {"message": "instruments must be [[segment, id]]"}})
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            svc.remove_client(client)

    @app.post("/api/scalper/summary")
    def summary(date: str = ""):
        d = _day(date, "date") or svc.clock().date().isoformat()
        Date.fromisoformat(d)
        return {"row": svc.write_summary(d)}
