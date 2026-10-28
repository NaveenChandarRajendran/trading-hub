"""
growth_plans.py - Growth Plans (a yearly target turned into monthly capital targets) and their link to strategies
(docs/features/growth-plan.md). The projection and tracker maths live in the page (frontend
src/apps/growth-plan/logic, tested there); this module keeps plans, the plan <-> strategy link and the tracker's
inputs: daily net P&L, capital changes (cash flows) and today's unrealized P&L.

Rules
- Plans are private: someone else's plan (or strategy) is "not found" (404), like one that doesn't exist.
- One active plan per strategy: applying a plan ends the active one, which stays in the history.
- Default initial capital of an applied plan = the strategy's capital; the page warns when they differ.
- Archiving a plan ends its active links (history kept). Deleting removes the plan and all its links (active and
  history) for good.
- Editing a plan changes the targets of every strategy it is applied to (their trackers follow it). Each strategy keeps
  its own tracking start capital (set when the plan was applied).
"""
import re

from strategies import NotFound, Refused

METHODS = ("compounded", "simple")
NAME_MAX = 60
PCT_MIN, PCT_MAX = 0.1, 500.0
CAP_MIN, CAP_MAX = 10_000, 10_00_00_000
YEARS_MAX = 20


def public_plan(p):
    return {"id": p["id"], "name": p["name"], "yearlyPct": p["yearly_pct"], "method": p["method"],
            "initialCapital": p["initial_capital"], "startMonth": p["start_month"], "years": p["years"],
            "createdAt": p["created_at"], "archivedAt": p["archived_at"]}


def public_mapping(m):
    return {"id": m["id"], "strategyId": m["strategy_id"], "planId": m["plan_id"], "initialCapital": m["initial_capital"],
            "appliedAt": m["applied_at"], "endedAt": m["ended_at"]}


class Plans:
    def __init__(self, store, strategies, clock):
        self.store, self.strategies, self.clock = store, strategies, clock

    # ------------------------------------------------------------------ plans
    def list(self, user, archived=False):
        return [p for p in self.store.plans(user.id) if bool(p["archived_at"]) == archived]

    def get(self, user, pid):
        p = self.store.plan(int(pid)) if str(pid).isdigit() else None
        if not p or p["user_id"] != user.id:
            raise NotFound(pid)
        return p

    def create(self, user, name, yearly_pct, method, initial_capital, start_month, years=5):
        return self.store.add_plan(user.id, self._name(name), self._pct(yearly_pct), self._method(method),
                                   self._capital(initial_capital), self._month(start_month), self._years(years),
                                   self.clock())

    def edit(self, user, pid, name=None, years=None, yearly_pct=None, method=None, initial_capital=None, start_month=None):
        p = self.get(user, pid)
        if p["archived_at"]:
            raise Refused("Archived plans are read-only.")
        fields = {}
        if name is not None:
            fields["name"] = self._name(name)
        if years is not None:
            fields["years"] = self._years(years)
        if yearly_pct is not None:
            fields["yearly_pct"] = self._pct(yearly_pct)
        if method is not None:
            fields["method"] = self._method(method)
        if initial_capital is not None:
            fields["initial_capital"] = self._capital(initial_capital)
        if start_month is not None:
            fields["start_month"] = self._month(start_month)
        return self.store.update_plan(p["id"], **fields) if fields else p

    def delete(self, user, pid):
        p = self.get(user, pid)
        self.store.delete_plan(p["id"])

    def archive(self, user, pid):
        p = self.get(user, pid)
        now = self.clock()
        self.store.end_plans(now, plan_id=p["id"])
        return self.store.update_plan(p["id"], archived_at=now)

    def applied_to(self, user, pid):
        """Strategies the plan is active on now: [{id, name}]."""
        return self.links(user, pid)[0]

    def links(self, user, pid):
        """([{id, name}] using it now, [{id, name}] used it before but not now)."""
        p = self.get(user, pid)
        active, before = {}, {}
        for m in self.store.plan_mappings(plan_id=p["id"]):
            st = self.store.strategy(m["strategy_id"])
            (before if m["ended_at"] else active)[st["id"]] = {"id": st["id"], "name": st["name"]}
        return list(active.values()), [v for k, v in before.items() if k not in active]

    # ------------------------------------------------------------------ plan <-> strategy
    def apply(self, user, sid, pid, initial_capital=None):
        st = self.strategies.get(user, sid)
        if st["archived_at"]:
            raise Refused("Archived strategies are read-only. Unarchive it first.")
        p = self.get(user, pid)
        if p["archived_at"]:
            raise Refused("This plan is archived.")
        cap = self._capital(st["capital"] if initial_capital is None else initial_capital)
        return self.store.apply_plan(st["id"], p["id"], cap, self.clock())

    def remove(self, user, sid):
        st = self.strategies.get(user, sid)
        self.store.end_plans(self.clock(), strategy_id=st["id"])

    def tracker(self, user, sid, live=None):
        """Everything the Plan tab / strip needs for one strategy."""
        st = self.strategies.get(user, sid)
        maps = self.store.plan_mappings(strategy_id=st["id"])
        active = next((m for m in maps if not m["ended_at"]), None)
        plans = {}
        for m in maps:
            plans.setdefault(m["plan_id"], self.store.plan(m["plan_id"]))
        days = {}
        for acc in (a["id"] for a in self.store.accounts() if a.get("strategy_id") == st["id"]):
            for d in self.store.day_summary(acc, "1900-01-01", "9999-12-31"):
                days[d["date"]] = round(days.get(d["date"], 0.0) + d["realized"] - d["charges"], 2)
        flows = [{"date": e["at"][:10], "amount": e["amount"], "kind": e["kind"]}
                 for e in self.store.capital_events(st["id"]) if e["kind"] != "start"]
        unrealized = 0.0
        if live and not st["archived_at"]:
            unrealized = round(live(st)[0], 2)
        return {
            "strategy": {"id": st["id"], "name": st["name"], "capital": st["capital"], "kind": st["kind"]},
            "plan": public_plan(plans[active["plan_id"]]) if active else None,
            "mapping": public_mapping(active) if active else None,
            "history": [{**public_mapping(m), "planName": plans[m["plan_id"]]["name"]} for m in maps if m["ended_at"]],
            "days": [{"date": d, "net": n} for d, n in sorted(days.items())],
            "flows": flows,
            "unrealized": unrealized,
            "today": self.clock().date().isoformat(),
        }

    # ------------------------------------------------------------------ checks
    @staticmethod
    def _name(name):
        name = " ".join(str(name or "").split())
        if not name or len(name) > NAME_MAX:
            raise Refused(f"Give the plan a name (at most {NAME_MAX} characters).", 400)
        return name

    @staticmethod
    def _num(v, what):
        try:
            return float(v)
        except (TypeError, ValueError):
            raise Refused(f"{what} must be a number.", 400) from None

    def _pct(self, v):
        v = self._num(v, "Yearly target")
        if not PCT_MIN <= v <= PCT_MAX:
            raise Refused(f"Yearly target must be between {PCT_MIN}% and {PCT_MAX:g}%.", 400)
        return v

    def _capital(self, v):
        v = self._num(v, "Capital")
        if not CAP_MIN <= v <= CAP_MAX:
            raise Refused(f"Capital must be between ₹{CAP_MIN:,} and ₹{CAP_MAX:,}.", 400)
        return v

    @staticmethod
    def _method(v):
        if v not in METHODS:
            raise Refused("Method must be compounded or simple.", 400)
        return v

    @staticmethod
    def _month(v):
        if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", str(v or "")):
            raise Refused("Start month must look like 2026-11.", 400)
        return v

    @staticmethod
    def _years(v):
        try:
            v = int(v)
        except (TypeError, ValueError):
            raise Refused("Years must be a whole number.", 400) from None
        if not 1 <= v <= YEARS_MAX:
            raise Refused(f"Years must be between 1 and {YEARS_MAX}.", 400)
        return v
