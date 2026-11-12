"""
algos_api.py - one API shape for every algo (the Algos hub, frontend src/algos). PAPER TRADING ONLY. Each algo is
wrapped in an adapter that reads its own records and calls its own service; no algo's trading logic changes here.
Only the owner of an algo's strategy (naveen) gets its routes; anyone else gets 404 (and an empty list).

    GET  /api/algos                                every algo the user owns: the card summary (status, P&L, open, last event)
    GET  /api/algos/{slug}/status                  the same summary for one algo (the page header)
    GET  /api/algos/{slug}/events?date=&type=&variant=&scope=&page=&size=
                                                   decision log of a day, newest first, filtered and paged
    GET  /api/algos/{slug}/trades?date=            closed trades of a day (+ the open one today)
    GET  /api/algos/{slug}/reports?from=&to=       day rows, tiles, holidays (the P&L calendar)
    GET  /api/algos/{slug}/settings                fields (value, default, kind, group, label), editable, change history
    PUT  /api/algos/{slug}/settings {changes}      validated, logged old -> new (time, user); new decisions only
    GET  /api/algos/{slug}/rules                   docs/strategies/<doc>.md (rendered by the page, raw HTML escaped there)
    GET  /api/algos/{slug}/overview                the algo's own Overview panel data (adapters that have one)
    POST /api/algos/{slug}/stop | stop-exit-all | resume
"""
import os
import re
from datetime import date as Date, timedelta

from fastapi import Body, HTTPException, Request

from holidays import NSE_HOLIDAYS

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs", "strategies")
PAGE_SIZE = 50


def parse_day(value, default):
    value = (value or "").strip()
    m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", value)
    if m:
        value = f"{m[3]}-{m[2]}-{m[1]}"
    if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise HTTPException(400, "dates look like 2026-11-12")
    return value or default


def tiles(days, pnls):
    """Report tiles from day rows ({net, trades, wins, losses}) and closed-trade P&Ls (win rate and averages); without
    trade P&Ls the counts come from the day rows."""
    wins, losses = [p for p in pnls if p > 0], [p for p in pnls if p < 0]
    n_win = len(wins) if pnls else sum(d.get("wins") or 0 for d in days)
    n_loss = len(losses) if pnls else sum(d.get("losses") or 0 for d in days)
    best = max(days, key=lambda d: d["net"], default=None)
    worst = min(days, key=lambda d: d["net"], default=None)
    return {"net": round(sum(d["net"] for d in days), 2), "charges": round(sum(d.get("charges", 0) for d in days), 2),
            "days": len(days), "trades": len(pnls) or sum(d.get("trades", 0) for d in days), "wins": n_win,
            "losses": n_loss, "winRate": round(n_win / (n_win + n_loss) * 100, 1) if n_win + n_loss else None,
            "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
            "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
            "bestDay": best and {"date": best["date"], "net": best["net"]},
            "worstDay": worst and {"date": worst["date"], "net": worst["net"]}}


def register(app, adapters):
    """adapters: {slug: adapter} (algo_adapters.py)."""
    def get(request, slug):
        a = adapters.get(slug)
        if a is None or a.owner_id() != request.state.user.id:
            raise HTTPException(404, "Not found")
        return a

    @app.get("/api/algos")
    def list_algos(request: Request):
        out = []
        for slug, a in adapters.items():
            if a.owner_id() == request.state.user.id:
                try:
                    out.append({"slug": slug, **a.summary()})
                except Exception as e:  # one algo failing never hides the others
                    out.append({"slug": slug, "state": "error", "stateText": f"Status unavailable: {e}"})
        return {"rows": out}

    @app.get("/api/algos/{slug}/status")
    def status(slug: str, request: Request):
        return {"slug": slug, **get(request, slug).summary()}

    @app.get("/api/algos/{slug}/events")
    def events(slug: str, request: Request, date: str = "", type: str = "", variant: str = "", scope: str = "",
               page: int = 1, size: int = PAGE_SIZE):
        a = get(request, slug)
        day = parse_day(date, a.today())
        rows = a.events(day)  # newest first, each {id, ts, type, side, scope, variant, setup, message}
        types = sorted({r["type"] for r in rows})
        variants = sorted({r["variant"] for r in rows if r.get("variant")})
        scopes = sorted({r["scope"] for r in rows if r.get("scope")})
        if type:
            want = set(type.split(","))
            rows = [r for r in rows if r["type"] in want]
        if variant:  # rows for every variant (scope ALL: kill switch, settings) stay
            rows = [r for r in rows if r.get("variant") in (variant, "")]
        if scope:
            rows = [r for r in rows if r.get("scope") in (scope, "ALL")]
        size = max(1, min(int(size), 500))
        page = max(1, int(page))
        return {"date": day, "total": len(rows), "page": page, "size": size, "types": types, "variants": variants,
                "scopes": scopes, "liveVariant": getattr(a, "live_variant", ""), "rows": rows[(page - 1) * size: page * size]}

    @app.get("/api/algos/{slug}/trades")
    def trades(slug: str, request: Request, date: str = ""):
        a = get(request, slug)
        day = parse_day(date, a.today())
        return {"date": day, "rows": a.trades(day)}

    @app.get("/api/algos/{slug}/reports")
    def reports(slug: str, request: Request):
        a = get(request, slug)
        q = request.query_params
        to_day = parse_day(q.get("to"), a.today())
        from_day = parse_day(q.get("from"), (Date.fromisoformat(to_day) - timedelta(days=30)).isoformat())
        if from_day > to_day:
            raise HTTPException(400, "from must not be after to")
        days, pnls = a.reports(from_day, to_day)
        out = {"from": from_day, "to": to_day, "days": days, "tiles": tiles(days, pnls),
               "holidays": sorted(d for d in NSE_HOLIDAYS if from_day <= d <= to_day)}
        if hasattr(a, "breakdown"):  # P&L per setup (ORB): [{key, name, trades, wins, losses, points, net}]
            out["breakdown"] = a.breakdown(from_day, to_day)
        return out

    @app.get("/api/algos/{slug}/overview")
    def overview(slug: str, request: Request):
        a = get(request, slug)
        if not hasattr(a, "overview"):
            raise HTTPException(404, "This algo's Overview uses its own route")
        return a.overview()

    @app.get("/api/algos/{slug}/settings")
    def settings(slug: str, request: Request):
        return get(request, slug).settings_view()

    @app.put("/api/algos/{slug}/settings")
    def save_settings(slug: str, request: Request, changes: dict = Body(...)):
        a = get(request, slug)
        try:
            a.save_settings(changes, request.state.user.username)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return a.settings_view()

    @app.get("/api/algos/{slug}/rules")
    def rules(slug: str, request: Request):
        a = get(request, slug)
        path = os.path.join(DOCS, f"{a.rules_doc}.md")
        try:
            with open(path, encoding="utf-8") as f:
                return {"doc": f"docs/strategies/{a.rules_doc}.md", "markdown": f.read()}
        except OSError:
            raise HTTPException(404, f"docs/strategies/{a.rules_doc}.md not found") from None

    for action in ("stop", "stop-exit-all", "resume"):
        def handler(slug: str, request: Request, _action=action):
            a = get(request, slug)
            {"stop": lambda: a.stop(False, request.state.user.username),
             "stop-exit-all": lambda: a.stop(True, request.state.user.username),
             "resume": lambda: a.resume(request.state.user.username)}[_action]()
            return {"slug": slug, **a.summary()}
        app.post(f"/api/algos/{{slug}}/{action}")(handler)
