"""
toi_algo_api.py - routes for the Trending OI Algo (toi_algo_service.py). PAPER TRADING ONLY. Only the owner of its
strategy ("Trending OI Algo", naveen) gets them; anyone else gets 404. Dates are IST trading dates (2026-11-12).

    GET  /api/toi-algo/status                  mode, health, direction, no-trade reason, indicators, levels, open trade
                                               (live P&L, next partial, adds used), today's trades, funds
    GET  /api/toi-algo/events?date=            that day's decision log, newest first
    GET  /api/toi-algo/day?date=               a day's trades, evaluated candles (indicator values) and log
    GET  /api/toi-algo/reports?from=&to=       day-wise rows (toi_algo_daily_summary) and tiles (win rate, average win / loss)
    GET  /api/toi-algo/settings                current settings and the config's defaults
    PUT  /api/toi-algo/settings {changes}      saved and logged old -> new; open trades keep their stop and lots
    POST /api/toi-algo/stop | stop-exit-all | resume     kill switch
"""
import re
from datetime import date as Date, timedelta

from fastapi import Body, HTTPException, Request

import toi_algo_logic as L
import trending_oi_algo_config as cfg


def parse_date(value, default=""):
    value = (value or "").strip()
    m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", value)
    if m:
        value = f"{m[3]}-{m[2]}-{m[1]}"
    if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise HTTPException(400, "dates look like 2026-11-12")
    return value or default


def check_settings(changes):
    """Each value must look like its default (number, HH:MM time, list of strike labels)."""
    out = {}
    for k, v in changes.items():
        if k not in cfg.DEFAULTS:
            raise HTTPException(400, f"unknown setting {k}")
        d = cfg.DEFAULTS[k]
        if isinstance(d, list):
            if not isinstance(v, list) or not set(v) <= {"ATM", "2ITM"}:
                raise HTTPException(400, f"{k}: a list of ATM / 2ITM")
        elif isinstance(d, str):
            if not isinstance(v, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
                raise HTTPException(400, f"{k}: a time like 09:45")
        else:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
                raise HTTPException(400, f"{k}: a number 0 or more")
            if isinstance(d, int) and not isinstance(d, bool):
                if v != int(v):
                    raise HTTPException(400, f"{k}: a whole number")
                v = int(v)
        out[k] = v
    return out


def open_view(svc, st):
    """The open trade for the page: live option price and P&L, the next partial exit or stop step, adds used."""
    o = st.get("open")
    if not o:
        return None
    s = svc.settings()
    lot = (svc.instruments.get(o["securityId"]) or {}).get("lotSize") or 65 if o.get("securityId") else 65
    ltp = svc.broker.ltp(o["securityId"]) if svc.broker and o.get("securityId") else None
    live = round(o.get("booked", 0.0) + (ltp - o["avg"]) * o["lots"] * lot, 2) if ltp is not None and o.get("avg") is not None else None
    targets = o.get("targets") or []
    if o.get("partials", 0) < len(targets):
        nxt = f"{targets[o['partials']][0]} {L.fmt(targets[o['partials']][1])}"
    elif not targets and not o.get("breakeven"):
        nxt = f"no level: breakeven at {s['breakevenAtR']:g}R ({L.fmt(o['entrySpot'] + (1 if o['side'] == 'CE' else -1) * s['breakevenAtR'] * o['risk'])})"
    else:
        nxt = "trailing Supertrend"
    return {**{k: o.get(k) for k in ("side", "strike", "lots", "avg", "entryAt", "entrySpot", "stop", "risk", "partials",
                                     "breakeven", "trailing", "adds", "booked")},
            "ltp": ltp, "pnl": live, "next": nxt, "lotSize": lot,
            "caps": {"avg": s["avgMaxLots"], "pyr": s["pyrMaxLots"], "max": s["maxLots"]}}


def register(app, svc):
    def owner(request):
        acc = svc.broker.account if svc.broker else svc.store.active_account(cfg.ACCOUNT_NAME)
        sid = acc.get("strategy_id") if acc else None
        st = svc.store.strategy(sid) if sid else None
        if not st or st["user_id"] != request.state.user.id:
            raise HTTPException(404, "Not found")

    def status_body():
        st = svc.status()
        state = st.pop("state") or {}
        day = state.get("day") or svc.clock().date().isoformat()
        candles = svc.toi.candles(day)
        last = candles[-1] if candles else None
        s = st["settings"]
        return {"meta": {**{k: st[k] for k in ("mode", "asOf", "marketOpen", "stale", "halted", "tokenExpired", "expiry",
                                               "futureLtp")},
                         "future": (st.get("future") or {}).get("expiry"), "spot": st["spot"], "funds": st["funds"],
                         "entryWindow": f"{s['entryFrom']}-{s['entryTo']}", "squareOff": s["squareOff"], "capital": cfg.CAPITAL},
                "direction": state.get("direction"), "noTrade": state.get("noTrade"),
                "indicators": last and {"time": last["start"], "close": last["close"], "supertrend": last["supertrend"],
                                        "stUp": last["st_up"], "vwap": last["vwap"], "vwapFuture": last["vwap_future"],
                                        "basis": last["basis"], "rsi": last["rsi"]},
                "levels": state.get("levels"), "levelsAt": state.get("levelsAt"),
                "open": open_view(svc, state), "trades": state.get("closed", []), "tradesToday": state.get("trades", 0),
                "stopped": state.get("stopped", [])}

    @app.get("/api/toi-algo/status")
    def status(request: Request):
        owner(request)
        return status_body()

    @app.get("/api/toi-algo/events")
    def events(request: Request, date: str = ""):
        owner(request)
        day = parse_date(date, svc.clock().date().isoformat())
        return {"date": day, "rows": list(reversed(svc.toi.events(day)))}

    @app.get("/api/toi-algo/day")
    def day_view(request: Request, date: str = ""):
        owner(request)
        day = parse_date(date, svc.clock().date().isoformat())
        st = svc.toi.state(day) or {}
        return {"date": day, "trades": st.get("closed", []), "open": st.get("open"), "levels": st.get("levels"),
                "candles": svc.toi.candles(day), "rows": list(reversed(svc.toi.events(day)))}

    @app.get("/api/toi-algo/reports")
    def reports(request: Request):
        owner(request)
        today = svc.clock().date()
        q = request.query_params
        to_day = parse_date(q.get("to"), today.isoformat())
        from_day = parse_date(q.get("from"), (Date.fromisoformat(to_day) - timedelta(days=30)).isoformat())
        if from_day > to_day:
            raise HTTPException(400, "from must not be after to")
        rows = svc.toi.summaries(from_day, to_day)
        pnls = [t["pnl"] for st in svc.toi.states_between(from_day, to_day).values() for t in st.get("closed", [])
                if t.get("pnl") is not None]
        wins, losses = [p for p in pnls if p > 0], [p for p in pnls if p < 0]
        tiles = {"days": len(rows), "trades": sum(r["trades"] for r in rows), "net": round(sum(r["net_pnl"] for r in rows), 2),
                 "charges": round(sum(r["charges"] for r in rows), 2), "wins": len(wins), "losses": len(losses),
                 "winRate": round(len(wins) / len(pnls) * 100, 1) if pnls else None,
                 "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
                 "avgLoss": round(sum(losses) / len(losses), 2) if losses else None}
        return {"from": from_day, "to": to_day, "rows": rows, "tiles": tiles}

    @app.get("/api/toi-algo/settings")
    def get_settings(request: Request):
        owner(request)
        return {"settings": svc.settings(), "defaults": cfg.DEFAULTS}

    @app.put("/api/toi-algo/settings")
    def put_settings(request: Request, changes: dict = Body(...)):
        owner(request)
        try:
            merged = svc.set_settings(check_settings(changes), who=request.state.user.username)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return {"settings": merged, "defaults": cfg.DEFAULTS}

    @app.post("/api/toi-algo/stop")
    def stop(request: Request):
        owner(request)
        svc.stop(who=request.state.user.username)
        return status_body()

    @app.post("/api/toi-algo/stop-exit-all")
    def stop_exit_all(request: Request):
        owner(request)
        svc.stop(exit_all=True, who=request.state.user.username)
        return status_body()

    @app.post("/api/toi-algo/resume")
    def resume(request: Request):
        owner(request)
        svc.resume(who=request.state.user.username)
        return status_body()
