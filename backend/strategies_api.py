"""
strategies_api.py - the signed-in user's strategies (strategies.py has the rules). Someone else's strategy is 404.

    GET   /api/strategies?archived=false            {"strategies": [...]}, newest activity first
    POST  /api/strategies {name, description?, capital?}      -> {"strategy": {...}}   (kind manual)
    GET   /api/strategies/{id}                       -> {"strategy": {...}}
    PATCH /api/strategies/{id} {name?, description?, notes?}
    PUT   /api/strategies/{id}/capital {capital}     set the open period's capital (flat book)
    POST  /api/strategies/{id}/reset {capital?}      new capital period, history kept (flat book)
    POST  /api/strategies/{id}/archive | /unarchive
    GET   /api/strategies/pick?tool=paper|scalper  {"strategyId"}: the tool's last pick, if still tradable, else the
                                                 newest active manual strategy, else null
    PUT   /api/strategies/pick {tool, strategyId}  remember a tool's pick (th_user_prefs; must be tradable)
    GET   /api/strategies/summary?archived=false {"rows": [{id, booked, unbooked, total, open, lastDay}]} card numbers
"""
from fastapi import HTTPException, Request
from pydantic import BaseModel

from strategies import NotFound, Refused, public


class CreateBody(BaseModel):
    name: str
    description: str = ""
    capital: float | None = None


class EditBody(BaseModel):
    name: str | None = None
    description: str | None = None
    notes: str | None = None


class CapitalBody(BaseModel):
    capital: float


class ResetBody(BaseModel):
    capital: float | None = None


class PickBody(BaseModel):
    tool: str
    strategyId: int


TOOLS = ("paper", "scalper")


def register(app, strategies, live=None):
    """live(strategy) -> (unbooked P&L, open positions) of today's engine (paper books, the algo's broker)."""
    def run(fn, *args, **kw):
        try:
            return {"strategy": public(fn(*args, **kw))}
        except NotFound:
            raise HTTPException(404, "Strategy not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None

    def tool_of(tool):
        if tool not in TOOLS:
            raise HTTPException(400, f"tool must be one of {', '.join(TOOLS)}")
        return f"trading_into.{tool}"

    # registered before /api/strategies/{sid}, so "pick" / "summary" are never read as an id
    @app.get("/api/strategies/pick")
    def get_pick(request: Request, tool: str = ""):
        user, key = request.state.user, tool_of(tool)
        saved = strategies.store.user_pref(user.id, key)
        for sid in ([saved] if saved else []):
            try:
                return {"strategyId": strategies.tradable(user, sid)["id"]}
            except (NotFound, Refused):
                pass
        active = [s for s in strategies.list(user) if s["kind"] == "manual"]
        return {"strategyId": active[0]["id"] if active else None}

    @app.put("/api/strategies/pick")
    def put_pick(body: PickBody, request: Request):
        key = tool_of(body.tool)
        try:
            st = strategies.tradable(request.state.user, body.strategyId)
        except NotFound:
            raise HTTPException(404, "Strategy not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None
        strategies.store.set_user_pref(request.state.user.id, key, st["id"])
        return {"strategyId": st["id"]}

    @app.get("/api/strategies/summary")
    def summary(request: Request, archived: bool = False):
        """Booked = realized - charges of every capital period so far; unbooked = today's open P&L; open = open
        positions. Total = booked + unbooked."""
        rows = []
        accounts = strategies.store.accounts()
        for st in strategies.list(request.state.user, archived):
            accs = [a["id"] for a in accounts if a.get("strategy_id") == st["id"]]
            days = [d for acc in accs for d in strategies.store.day_summary(acc, "2000-01-01", "2999-12-31")]
            booked = round(sum(d["realized"] - d["charges"] for d in days), 2)
            unbooked, open_ = live(st) if live and not st["archived_at"] else (0.0, 0)
            rows.append({"id": st["id"], "booked": booked, "unbooked": round(unbooked, 2),
                         "total": round(booked + unbooked, 2), "open": open_,
                         "lastDay": max((d["date"] for d in days), default=None)})
        return {"rows": rows}

    @app.get("/api/strategies")
    def list_strategies(request: Request, archived: bool = False):
        return {"strategies": [public(s) for s in strategies.list(request.state.user, archived)]}

    @app.post("/api/strategies")
    def create(body: CreateBody, request: Request):
        return run(strategies.create, request.state.user, body.name, body.description, body.capital)

    @app.get("/api/strategies/{sid}")
    def get(sid: str, request: Request):
        return run(strategies.get, request.state.user, sid)

    @app.patch("/api/strategies/{sid}")
    def edit(sid: str, body: EditBody, request: Request):
        return run(strategies.edit, request.state.user, sid, body.name, body.description, body.notes)

    @app.put("/api/strategies/{sid}/capital")
    def set_capital(sid: str, body: CapitalBody, request: Request):
        return run(strategies.set_capital, request.state.user, sid, body.capital)

    @app.post("/api/strategies/{sid}/reset")
    def reset(sid: str, request: Request, body: ResetBody | None = None):
        return run(strategies.reset, request.state.user, sid, body.capital if body else None)

    @app.post("/api/strategies/{sid}/archive")
    def archive(sid: str, request: Request):
        return run(strategies.archive, request.state.user, sid)

    @app.post("/api/strategies/{sid}/unarchive")
    def unarchive(sid: str, request: Request):
        return run(strategies.unarchive, request.state.user, sid)
