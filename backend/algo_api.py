"""
algo_api.py - routes for the OI breakout algo (algo_service.py, algo_reports.py). PAPER TRADING ONLY.
Everything is read from Postgres; dates are IST trading dates (2026-10-23 or 23-10-2026).

    GET  /api/algo/status                       mode, live variant + shadows, funds, per index: state, levels, trades
    GET  /api/algo/events?date=&variant=        that day's decision log (newest first) and closed trades
    GET  /api/algo/day?date=&variant=           day view: locked levels, trades (all variants), log, candles + filters
    GET  /api/algo/reports?from=&to=&preset=&index=&variant=
                                                day-wise rows (algo_daily_summary), tiles, variant comparison;
                                                preset: week | month | lastMonth (instead of from / to)
    POST /api/algo/summary?from=&to=            recompute algo_daily_summary for a range (default: today)
    POST /api/algo/stop                         kill switch: no new entries (open positions keep their exits)
    POST /api/algo/stop-exit-all                kill switch + exit every open algo position at market
    POST /api/algo/resume                       allow new entries again
Only the owner of the algo's strategy ("OI Breakout Algo", Naveen) gets these routes; anyone else gets 404.
"""
import re

from fastapi import Depends, HTTPException, Query, Request

import algo_config as cfg
from algo_reports import day_view, preset_range, range_report, recompute


def parse_date(value, name="date"):
    """'2026-10-23' or '23-10-2026' -> '2026-10-23' ('' stays ''). 400 otherwise."""
    value = (value or "").strip()
    m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", value)
    if m:
        value = f"{m[3]}-{m[2]}-{m[1]}"
    if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise HTTPException(400, f"{name} must look like 2026-10-23 or 23-10-2026")
    return value


def parse_variant(value):
    value = (value or "").strip().upper()
    if value and value not in cfg.VARIANTS:
        raise HTTPException(400, f"variant must be one of {', '.join(cfg.VARIANTS)}")
    return value or None


def parse_index(value):
    value = (value or "").strip().upper()
    if value and value not in cfg.SYMBOLS:
        raise HTTPException(400, f"index must be one of {', '.join(cfg.SYMBOLS)}")
    return value or None


def register(app, algo):
    def owner_only(request: Request):
        if algo.owner_id() != request.state.user.id:
            raise HTTPException(404, "Not found.")
    owner = [Depends(owner_only)]

    def db(fn, *a, **k):
        try:
            return fn(*a, **k)
        except HTTPException:
            raise
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:  # database unreachable
            raise HTTPException(503, f"Database unavailable: {e}")

    @app.get("/api/algo/status", dependencies=owner)
    def status():
        return algo.status()

    @app.get("/api/algo/events", dependencies=owner)
    def events(date: str = "", variant: str = ""):
        return db(algo.day_log, parse_date(date) or None, parse_variant(variant))

    @app.get("/api/algo/day", dependencies=owner)
    def day(date: str = "", variant: str = ""):
        d = parse_date(date) or algo.clock().date().isoformat()
        return db(day_view, algo.store, d, parse_variant(variant))

    @app.get("/api/algo/reports", dependencies=owner)
    def reports(from_day: str = Query("", alias="from"), to: str = "", preset: str = "", index: str = "",
                variant: str = ""):
        today = algo.clock().date()
        if preset:
            start, end = db(preset_range, preset, today)
        else:
            start, end = parse_date(from_day, "from"), parse_date(to, "to")
            end = end or today.isoformat()
            start = start or end
        if start > end:
            raise HTTPException(400, "from must not be after to")
        return db(range_report, algo.store, start, end, parse_index(index), parse_variant(variant) or algo.variant)

    @app.post("/api/algo/summary", dependencies=owner)
    def summary(from_day: str = Query("", alias="from"), to: str = ""):
        today = algo.clock().date().isoformat()
        start = parse_date(from_day, "from") or today
        end = parse_date(to, "to") or start
        return {"from": start, "to": end, "days": db(recompute, algo.store, start, end)}

    @app.post("/api/algo/stop", dependencies=owner)
    def stop():
        algo.stop(exit_all=False)
        return algo.status()

    @app.post("/api/algo/stop-exit-all", dependencies=owner)
    def stop_exit_all():
        algo.stop(exit_all=True)
        return algo.status()

    @app.post("/api/algo/resume", dependencies=owner)
    def resume():
        algo.resume()
        return algo.status()
