"""
growth_plans_api.py - Growth Plans of the signed-in user (growth_plans.py has the rules). Others' plans / strategies: 404.

    GET   /api/plans?archived=false                 {"plans": [{..., "appliedTo": [{id, name}]}]}
    POST  /api/plans {name, yearlyPct, method, initialCapital, startMonth, years?}     -> {"plan"}
    GET   /api/plans/{id}                           -> {"plan", "appliedTo"}
    PATCH /api/plans/{id} {name?, years?}           ("+5 years" = years + 5, at most 20)
    POST  /api/plans/{id}/archive                   (ends its active links; history kept)
    POST  /api/strategies/{id}/plan {planId, initialCapital?}  apply (ends the active one; default capital = strategy's)
    DELETE /api/strategies/{id}/plan                remove the active plan (kept in history)
    GET   /api/strategies/{id}/plan                 tracker inputs: plan, mapping, history, days [{date, net}],
                                                    flows [{date, amount, kind}], unrealized, today
"""
from fastapi import HTTPException, Request
from pydantic import BaseModel

from growth_plans import public_mapping, public_plan
from strategies import NotFound, Refused


class PlanBody(BaseModel):
    name: str
    yearlyPct: float
    method: str = "compounded"
    initialCapital: float
    startMonth: str
    years: int = 5


class PlanEdit(BaseModel):
    name: str | None = None
    years: int | None = None


class ApplyBody(BaseModel):
    planId: int
    initialCapital: float | None = None


def register(app, plans, live=None):
    def run(fn, *a, **k):
        try:
            return fn(*a, **k)
        except NotFound:
            raise HTTPException(404, "Not found.") from None
        except Refused as e:
            raise HTTPException(e.status, e.message) from None

    def with_links(user, p):
        return {**public_plan(p), "appliedTo": run(plans.applied_to, user, p["id"])}

    @app.get("/api/plans")
    def list_plans(request: Request, archived: bool = False):
        user = request.state.user
        return {"plans": [with_links(user, p) for p in plans.list(user, archived)]}

    @app.post("/api/plans")
    def create(body: PlanBody, request: Request):
        p = run(plans.create, request.state.user, body.name, body.yearlyPct, body.method, body.initialCapital,
                body.startMonth, body.years)
        return {"plan": with_links(request.state.user, p)}

    @app.get("/api/plans/{pid}")
    def get(pid: str, request: Request):
        return {"plan": with_links(request.state.user, run(plans.get, request.state.user, pid))}

    @app.patch("/api/plans/{pid}")
    def edit(pid: str, body: PlanEdit, request: Request):
        return {"plan": with_links(request.state.user, run(plans.edit, request.state.user, pid, body.name, body.years))}

    @app.post("/api/plans/{pid}/archive")
    def archive(pid: str, request: Request):
        return {"plan": public_plan(run(plans.archive, request.state.user, pid))}

    @app.post("/api/strategies/{sid}/plan")
    def apply(sid: str, body: ApplyBody, request: Request):
        return {"mapping": public_mapping(run(plans.apply, request.state.user, sid, body.planId, body.initialCapital))}

    @app.delete("/api/strategies/{sid}/plan")
    def remove(sid: str, request: Request):
        run(plans.remove, request.state.user, sid)
        return {"ok": True}

    @app.get("/api/strategies/{sid}/plan")
    def tracker(sid: str, request: Request):
        return run(plans.tracker, request.state.user, sid, live)
