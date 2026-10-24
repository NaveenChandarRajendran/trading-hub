"""
algo_reports.py - daily summaries, date-range reports and the day view of the OI breakout algo, from Postgres
(algo_state, algo_events, algo_levels, algo_candles, algo_daily_summary). Every date is the IST trading date.

Daily summary per index and variant (live + shadows):
  signals   breakouts armed + range touches (entered or skipped)
  entries   entries taken (live: paper orders; shadows: would-be)
  wins / losses  closed trades with P&L (live) or points (shadows) above / below zero
  points    index points captured: CE exit - entry spot, PE entry - exit spot
  gross_pnl / charges / net_pnl   live variant only (from the paper fills); NULL for shadows
"""
from datetime import date, timedelta

import algo_config as cfg


def trade_points(t):
    """Index points of one closed trade (entry spot = live spot at entry when known, else the candle close)."""
    entry = t.get("entrySpotLive") or t.get("entrySpot")
    exit_ = t.get("exitSpot")
    if entry is None or exit_ is None:
        return 0.0
    return round((exit_ - entry) * (1 if t.get("side") == "CE" else -1), 2) + 0.0


def is_signal(e):
    kind = e.get("kind") or (e.get("details") or {}).get("kind")
    if kind == "armed":
        return True
    return e["type"] in ("skip", "entry") and ((e.get("setup") or "").startswith("Range")
                                               or e["message"].startswith("Range"))


def day_summaries(store, day):
    """algo_daily_summary rows for one day, computed from that day's states and decision log."""
    states = store.algo_states(day)
    events = store.algo_events(day)
    rows = []
    for (index, variant), st in sorted(states.items()):
        live = bool(st.get("live", True))  # 23-Oct (before shadows) had only the live variant
        evs = [e for e in events if e["index"] == index and e["variant"] == variant]
        closed = st.get("closed", [])
        pts = [trade_points(t) for t in closed]
        score = [t.get("pnl") if live and t.get("pnl") is not None else p for t, p in zip(closed, pts)]
        gross = round(sum(t["pnl"] for t in closed if t.get("pnl") is not None), 2) if live else None
        charges = round(sum(t.get("charges") or 0 for t in closed), 2) if live else None
        rows.append({"trade_date": day, "index": index, "variant": variant, "is_live": live,
                     "signals": sum(1 for e in evs if is_signal(e)),
                     "entries": sum(1 for e in evs if e["type"] == "entry"),
                     "wins": sum(1 for s in score if s > 0), "losses": sum(1 for s in score if s < 0),
                     "points": round(sum(pts), 2) + 0.0, "gross_pnl": gross, "charges": charges,
                     "net_pnl": round(gross - charges, 2) if live else None})
    return rows


def write_day_summaries(store, day):
    rows = day_summaries(store, day)
    if rows:
        store.algo_save_summaries(rows)
    return rows


def recompute(store, from_day, to_day):
    """Rewrites algo_daily_summary for every day with algo data in the range. Returns {day: rows written}."""
    return {d: len(write_day_summaries(store, d)) for d in store.algo_days(from_day, to_day)}


def range_report(store, from_day, to_day, index=None, variant=None):
    """Reports view: day-wise rows, tiles and the variant comparison for an IST date range."""
    variant = (variant or cfg.RULE_VARIANT).upper()
    rows = store.algo_summaries(from_day, to_day, index=index)
    days = {}
    for r in rows:
        if r["variant"] != variant:
            continue
        d = days.setdefault(r["trade_date"], {"trade_date": r["trade_date"], "variant": variant, "is_live": False,
                                              "signals": 0, "entries": 0, "wins": 0, "losses": 0, "points": 0.0,
                                              "gross_pnl": None, "charges": None, "net_pnl": None})
        d["is_live"] = d["is_live"] or r["is_live"]
        for k in ("signals", "entries", "wins", "losses"):
            d[k] += r[k]
        d["points"] = round(d["points"] + r["points"], 2)
        for k in ("gross_pnl", "charges", "net_pnl"):
            if r[k] is not None:
                d[k] = round((d[k] or 0) + r[k], 2)
    trades = []
    for day, ix, var, st in store.algo_states_between(from_day, to_day):
        if var == variant and (not index or ix == index):
            trades += [{**t, "index": ix, "trade_date": day, "points": trade_points(t)} for t in st.get("closed", [])]
    live = any(d["is_live"] for d in days.values())
    value = [t.get("pnl") if live and t.get("pnl") is not None else t["points"] for t in trades]
    wins, losses = [v for v in value if v > 0], [v for v in value if v < 0]
    by_day = sorted(days.values(), key=lambda d: d["trade_date"])
    day_value = [(d["trade_date"], d["net_pnl"] if live and d["net_pnl"] is not None else d["points"]) for d in by_day]
    tiles = {
        "unit": "rupees" if live else "points",
        "netPnl": round(sum(d["net_pnl"] or 0 for d in by_day), 2) if live else None,
        "points": round(sum(d["points"] for d in by_day), 2),
        "trades": len(trades), "wins": len(wins), "losses": len(losses),
        "winRate": round(100 * len(wins) / (len(wins) + len(losses)), 1) if wins or losses else None,
        "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
        "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
        "bestDay": max(day_value, key=lambda x: x[1]) if day_value else None,
        "worstDay": min(day_value, key=lambda x: x[1]) if day_value else None,
    }
    comparison = {}
    for r in rows:
        c = comparison.setdefault(r["variant"], {"variant": r["variant"], "isLive": False, "signals": 0, "entries": 0,
                                                 "wins": 0, "losses": 0, "points": 0.0, "netPnl": None})
        c["isLive"] = c["isLive"] or r["is_live"]
        for k in ("signals", "entries", "wins", "losses"):
            c[k] += r[k]
        c["points"] = round(c["points"] + r["points"], 2)
        if r["net_pnl"] is not None:
            c["netPnl"] = round((c["netPnl"] or 0) + r["net_pnl"], 2)
    return {"from": from_day, "to": to_day, "index": index or "", "variant": variant, "days": by_day,
            "trades": sorted(trades, key=lambda t: (t["trade_date"], t.get("entryAt") or "")), "tiles": tiles,
            "comparison": [comparison[v] for v in sorted(comparison)]}


def day_view(store, day, variant=None):
    """One day: locked levels, trades per variant, decision log (newest first), candles with filter values, summary."""
    states = store.algo_states(day)
    trades = [{**t, "index": ix, "variant": var, "live": bool(st.get("live", True)), "points": trade_points(t)}
              for (ix, var), st in sorted(states.items()) for t in st.get("closed", [])]
    trades.sort(key=lambda t: t.get("entryAt") or "")
    events = [e for e in store.algo_events(day, variant=variant) if e["type"] != "candle"]
    return {"date": day, "variant": variant or "", "levels": store.algo_levels(day), "trades": trades,
            "events": list(reversed(events)), "candles": store.algo_candles(day),
            "summary": store.algo_summaries(day, day)}


def preset_range(name, today):
    """'week' | 'month' | 'lastMonth' -> (from, to) IST dates (Monday-based week)."""
    if name == "week":
        start = today - timedelta(days=today.weekday())
        return start.isoformat(), today.isoformat()
    if name == "month":
        return today.replace(day=1).isoformat(), today.isoformat()
    if name == "lastMonth":
        end = today.replace(day=1) - timedelta(days=1)
        return end.replace(day=1).isoformat(), end.isoformat()
    raise ValueError(f"unknown preset {name!r}")


def parse_day(s):
    return date.fromisoformat(s)
