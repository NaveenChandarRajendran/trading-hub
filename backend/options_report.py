"""
options_report.py - how an options strategy did, trade by trade and month by month (Strategy Builder → Portfolios).
Pure: the caller passes the stored fills (op_fills, every capital period of the strategy), the open legs with their
unbooked P&L and the capital.

- A trade = every leg of one index and one expiry (the weekly condor of 3 Nov is one trade), whatever baskets opened,
  adjusted or closed it.
- Trade P&L: booked = what its fills realized (close / settle) − all its charges; unbooked = its open legs at the live
  price; net = booked + unbooked. Credit = premium of its opening fills (sells +, buys −).
- Status: open (a leg still open), settled (closed by the expiry settlement), else closed (exited before expiry).
- A trade counts in the month of its expiry. Wins / losses / win % / best / worst use finished trades only; an open
  trade adds its net to the month (so the months add up to the total) and shows in `open`.
- Return % = net ÷ the strategy's capital × 100.
"""
from paper_charges import r2


def _pct(x, capital):
    return round(x / capital * 100, 2) if capital else 0.0


def trades(fills, open_legs=()):
    """fills: op_fills dicts. open_legs: [{security_id, symbol, expiry, unrealized}]. Newest expiry first."""
    out = {}
    for f in sorted(fills, key=lambda d: (d["time"], d["id"])):
        t = out.setdefault((f["symbol"], f["expiry"]), {
            "symbol": f["symbol"], "expiry": f["expiry"], "entered": f["time"], "closedAt": None, "legs": set(),
            "credit": 0.0, "realized": 0.0, "charges": 0.0, "unbooked": 0.0, "settled": False, "openLegs": 0, "fills": []})
        t["legs"].add(int(f["security_id"]))
        if f.get("kind") == "open":
            t["credit"] += f["value"] if f["side"] == "SELL" else -f["value"]
        else:
            t["closedAt"] = f["time"]
            t["settled"] = t["settled"] or f.get("kind") == "settle"
        t["realized"] += float(f.get("realized", 0.0))
        t["charges"] += float(f["charges"]["total"])
        t["fills"].append({"time": f["time"], "side": f["side"], "strike": f["strike"], "optionType": f["optionType"],
                           "qty": int(f["qty"]), "price": f["price"], "kind": f.get("kind", "open"),
                           "realized": float(f.get("realized", 0.0)), "charges": float(f["charges"]["total"])})
    for p in open_legs:
        t = out.get((p["symbol"], p["expiry"]))
        if t is not None:
            t["unbooked"] += float(p.get("unrealized") or 0.0)
            t["openLegs"] += 1
    rows = []
    for t in out.values():
        booked = r2(t["realized"] - t["charges"])
        status = "open" if t["openLegs"] else ("settled" if t["settled"] else "closed")
        rows.append({"symbol": t["symbol"], "expiry": t["expiry"], "entered": t["entered"],
                     "closedAt": None if status == "open" else t["closedAt"], "legs": len(t["legs"]),
                     "openLegs": t["openLegs"], "credit": r2(t["credit"]), "charges": r2(t["charges"]),
                     "booked": booked, "unbooked": r2(t["unbooked"]), "net": r2(booked + t["unbooked"]), "status": status,
                     "fills": t["fills"]})
    return sorted(rows, key=lambda r: (r["expiry"], r["symbol"]), reverse=True)


def months(rows, capital):
    """Trade rows (trades()) grouped by the month of their expiry, newest first."""
    by = {}
    for r in rows:
        by.setdefault(r["expiry"][:7], []).append(r)
    out = []
    for month, rs in by.items():
        done = [r for r in rs if r["status"] != "open"]
        net = r2(sum(r["net"] for r in rs))
        wins = sum(1 for r in done if r["net"] > 0)
        out.append({"month": month, "trades": len(done), "open": len(rs) - len(done), "wins": wins,
                    "losses": len(done) - wins, "winPct": round(wins / len(done) * 100, 1) if done else None,
                    "net": net, "returnPct": _pct(net, capital), "charges": r2(sum(r["charges"] for r in rs)),
                    "best": max((r["net"] for r in done), default=None), "worst": min((r["net"] for r in done), default=None)})
    return sorted(out, key=lambda m: m["month"], reverse=True)


def summary(rows, capital):
    done = [r for r in rows if r["status"] != "open"]
    booked = r2(sum(r["booked"] for r in rows))
    unbooked = r2(sum(r["unbooked"] for r in rows))
    wins = sum(1 for r in done if r["net"] > 0)
    return {"capital": r2(capital), "booked": booked, "unbooked": unbooked, "total": r2(booked + unbooked),
            "charges": r2(sum(r["charges"] for r in rows)), "returnPct": _pct(booked + unbooked, capital),
            "trades": len(done), "open": len(rows) - len(done), "wins": wins,
            "winPct": round(wins / len(done) * 100, 1) if done else None}


def report(fills, open_legs, capital):
    rows = trades(fills, open_legs)
    return {"summary": summary(rows, capital), "months": months(rows, capital), "trades": rows}
