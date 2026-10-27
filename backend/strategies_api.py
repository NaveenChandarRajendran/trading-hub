"""
strategies_api.py - the signed-in user's strategies (strategies.py has the rules). Someone else's strategy is 404.

    GET   /api/strategies?archived=false            {"strategies": [...]}, newest activity first
    POST  /api/strategies {name, description?, capital?}      -> {"strategy": {...}}   (kind manual)
    GET   /api/strategies/{id}                       -> {"strategy": {...}}
    PATCH /api/strategies/{id} {name?, description?, notes?}
    PUT   /api/strategies/{id}/capital {capital}     set the open period's capital (flat book)
    POST  /api/strategies/{id}/reset {capital?}      new capital period, history kept (flat book)
    POST  /api/strategies/{id}/archive | /unarchive
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


def register(app, strategies):
    def run(fn, *args, **kw):
        try:
            return {"strategy": public(fn(*args, **kw))}
        except NotFound:
            raise HTTPException(404, "Strategy not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None

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
