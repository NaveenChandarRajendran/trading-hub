"""
scalper_reports.py - Power Scalper reports from the Scalper paper account's fills (pt_trades). Pure: no I/O.

A trade = one round trip of one instrument: from flat, the buys and sells until the position is flat again.
  pnl = sell value - buy value; charges = every fill's charges in it; net = pnl - charges; a win has net > 0.
Day P&L is the same as the Paper Trading P&L calendar: realized (pt_positions) - charges of the day's fills.
"""

def round_trips(fills):
    """Fills of one day (any order) -> (closed round trips, still-open ones), each with entry / exit, qty, averages,
    pnl, charges and net. Quantities in units."""
    open_, closed = {}, []
    for t in sorted(fills, key=lambda t: (t["time"], t["id"])):
        sid = t["security_id"]
        rt = open_.get(sid)
        if rt is None:
            rt = open_[sid] = {"securityId": sid, "name": t.get("name") or str(sid), "entryAt": t["time"], "exitAt": None,
                               "qty": 0, "buyQty": 0, "buyValue": 0.0, "sellQty": 0, "sellValue": 0.0, "charges": 0.0,
                               "fills": 0}
        q = t["qty"]
        if t["side"] == "BUY":
            rt["buyQty"] += q
            rt["buyValue"] += t["value"]
            rt["qty"] += q
        else:
            rt["sellQty"] += q
            rt["sellValue"] += t["value"]
            rt["qty"] -= q
        rt["charges"] += t["charges"]["total"]
        rt["fills"] += 1
        if rt["qty"] <= 0 and rt["sellQty"]:
            rt["exitAt"] = t["time"]
            closed.append(_finish(open_.pop(sid)))
    return closed, [_finish(rt) for rt in open_.values()]


def _finish(rt):
    pnl = rt["sellValue"] - rt["buyValue"] if rt["exitAt"] else None
    return {"securityId": rt["securityId"], "name": rt["name"], "entryAt": rt["entryAt"], "exitAt": rt["exitAt"],
            "qty": rt["buyQty"], "avgBuy": round(rt["buyValue"] / rt["buyQty"], 2) if rt["buyQty"] else None,
            "avgSell": round(rt["sellValue"] / rt["sellQty"], 2) if rt["sellQty"] else None,
            "pnl": round(pnl, 2) if pnl is not None else None, "charges": round(rt["charges"], 2),
            "net": round(pnl - rt["charges"], 2) if pnl is not None else None, "fills": rt["fills"]}


def day_rows(day_summary, trips_by_day):
    """store.day_summary rows ({date, realized, charges, trades=fills}) + closed round trips per date -> the day-wise
    table: date, realized, charges, net, fills, trades (round trips), wins, losses."""
    out = []
    for r in day_summary:
        trips = trips_by_day.get(r["date"], [])
        out.append({"date": r["date"], "realized": r["realized"], "charges": r["charges"],
                    "net": round(r["realized"] - r["charges"], 2), "fills": r["trades"], "trades": len(trips),
                    "wins": sum(t["net"] > 0 for t in trips), "losses": sum(t["net"] <= 0 for t in trips)})
    return out


def tiles(days, trips):
    """Report tiles: net P&L, trades, win rate %, average win / loss per trade, best / worst day."""
    wins = [t["net"] for t in trips if t["net"] > 0]
    losses = [t["net"] for t in trips if t["net"] <= 0]
    best = max(days, key=lambda d: d["net"], default=None)
    worst = min(days, key=lambda d: d["net"], default=None)
    return {"net": round(sum(d["net"] for d in days), 2), "charges": round(sum(d["charges"] for d in days), 2),
            "trades": len(trips), "wins": len(wins), "losses": len(losses),
            "winRate": round(100 * len(wins) / len(trips), 1) if trips else None,
            "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
            "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
            "bestDay": {"date": best["date"], "net": best["net"]} if best else None,
            "worstDay": {"date": worst["date"], "net": worst["net"]} if worst else None,
            "days": len(days)}


def summary_row(account_id, day, day_row, trips):
    """The scalper_daily_summary row of one day (written at 15:35 IST)."""
    nets = [t["net"] for t in trips]
    return {"account_id": account_id, "trade_date": day, "trades": len(trips), "wins": sum(n > 0 for n in nets),
            "losses": sum(n <= 0 for n in nets), "fills": day_row["fills"] if day_row else 0,
            "realized": day_row["realized"] if day_row else 0.0, "charges": day_row["charges"] if day_row else 0.0,
            "net": day_row["net"] if day_row else 0.0, "best_trade": max(nets, default=None),
            "worst_trade": min(nets, default=None)}
