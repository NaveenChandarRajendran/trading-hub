"""
journal.py - the app's own record of every paper order and trade, kept for every day (owner, 25-Oct-2026): like a
broker's order book and trade book with history, for all strategies in one place. MegaBull's own screens keep only
today's orders, so the app records each order it sends there itself. PAPER ONLY: this module only records.

What is recorded
  Auto strategies (4 Pillar Rules, SuperTrend Rules on MegaBull; Dharani Rules, Trend Rules on the app's accounts):
  the auto trader (autopaper.AutoTrader) reports each step through on_order(trade, event): "entry" (BUY filled),
  "stop placed" (SELL stop open), "exit <reason>" (stop filled, or stop cancelled + SELL at market). Each step becomes
  an order row; the trade itself is kept with its latest state.
  Manual trades (the owner's own buy / sell on the Option Chain page) are already stored per day by the paper engine;
  the API reads them from there (orders as they are, trades paired buy -> sell per option).
  Excel history (1 Oct to 23 Oct 2026): data/journal/imported.json, made once from the owner's tracker tabs; one trade
  per row with its buy and sell shown as two orders (source "excel").

Files: data/journal/day_<YYYY-MM-DD>.json = {"orders": [...], "trades": {id: trade}} (rewritten whole, atomically).
"""
import json
import logging
import os
import threading
from datetime import date as Date
from datetime import timedelta

log = logging.getLogger("journal")

STRATEGY = {"fourPillar": "4 Pillar Rules", "superTrend": "SuperTrend Rules", "dharaniV2": "Dharani Rules",
            "tradingHub": "Trend Rules"}
ACCOUNT = {"megabull": "MegaBull", "tradingHub": "App · Trend", "dharani": "App · Dharani", "manual": "App · Manual"}
STRATEGIES = ["4 Pillar Rules", "SuperTrend Rules", "Dharani Rules", "Trend Rules", "Manual"]


def strategy_of(trade):
    slot = trade.get("slot") or trade.get("account")
    if slot in STRATEGY:
        return STRATEGY[slot]
    setup = (trade.get("setup") or "").lower()  # trades saved before the 25-Oct split (slot "megabull")
    return "4 Pillar Rules" if "pillar" in setup else "SuperTrend Rules" if slot == "megabull" else "Manual"


def trade_row(t, day):
    inst = t.get("instrument") or {}
    return {
        "id": t["id"], "day": day, "source": "auto", "strategy": strategy_of(t), "account": ACCOUNT.get(t["account"], t["account"]),
        "symbol": t["symbol"], "side": t["side"], "instrument": inst.get("name"), "qty": t["qty"], "grade": t.get("grade"),
        "entryTime": t.get("entryTime"), "entryPrice": t.get("entryPrice"), "stop": t.get("stop"), "target": t.get("target"),
        "exitTime": t.get("exitTime"), "exitPrice": t.get("exitPrice"), "exitReason": t.get("exitReason"),
        "exitNote": t.get("exitNote"), "grossPnl": t.get("grossPnl"), "charges": t.get("charges"), "netPnl": t.get("netPnl"),
        "status": t["status"],
    }


class Journal:
    def __init__(self, data_dir="data", clock=None):
        self.dir = os.path.join(data_dir, "journal")
        self.clock = clock
        self.lock = threading.RLock()

    # ---------- files ----------
    def _path(self, day):
        return os.path.join(self.dir, f"day_{day}.json")

    def _read(self, day):
        try:
            with open(self._path(day), encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            d = {}
        d.setdefault("orders", [])
        d.setdefault("trades", {})
        return d

    def _write(self, day, d):
        os.makedirs(self.dir, exist_ok=True)
        tmp = self._path(day) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1, default=str)
        os.replace(tmp, self._path(day))

    def imported(self):
        try:
            with open(os.path.join(self.dir, "imported.json"), encoding="utf-8") as f:
                rows = json.load(f)
            return rows if isinstance(rows, list) else []
        except (OSError, ValueError):
            return []

    # ---------- recording (called by the auto trader) ----------
    def record(self, trade, event, now):
        """One auto-trader step. Never raises: the journal must not stop trading."""
        if trade.get("account") == "manual":  # manual / bracket trades: the paper engine has these orders already
            return
        try:
            with self.lock:
                self._record(trade, event, now)
        except Exception:
            log.exception("journal: could not record %s %s", trade.get("id"), event)

    def _record(self, t, event, now):
        day = now.date().isoformat()
        d = self._read(day)
        row = trade_row(t, day)
        d["trades"][t["id"]] = row
        base = {"tradeId": t["id"], "strategy": row["strategy"], "account": row["account"], "symbol": t["symbol"],
                "instrument": row["instrument"], "qty": t["qty"]}
        orders = d["orders"]

        def find(oid):
            return next((o for o in orders if oid and o["orderId"] == oid), None)
        if event == "entry":
            orders.append({**base, "time": t.get("entryTime") or now.strftime("%H:%M:%S"), "orderId": t.get("entryOrderId"),
                           "side": "BUY", "type": "MARKET", "price": t.get("entryPrice"), "trigger": None,
                           "status": "FILLED", "note": "Entry"})
        elif event == "stop placed" and t.get("stopOrderId") and not find(t["stopOrderId"]):
            orders.append({**base, "time": now.strftime("%H:%M:%S"), "orderId": t["stopOrderId"], "side": "SELL",
                           "type": "SL-M", "price": None, "trigger": t.get("stop"), "status": "OPEN", "note": "Stop loss"})
        elif event.startswith("exit"):
            reason = t.get("exitReason") or event[5:]
            stop = find(t.get("stopOrderId"))
            exit_time = t.get("exitTime") or now.strftime("%H:%M:%S")
            if reason == "Stop" and stop:
                stop.update(status="FILLED", price=t.get("exitPrice"), filledAt=exit_time)
            else:
                if stop and stop["status"] == "OPEN":
                    stop.update(status="CANCELLED", cancelledAt=exit_time)
                if t.get("exitOrderId") and not find(t["exitOrderId"]):
                    orders.append({**base, "time": exit_time, "orderId": t["exitOrderId"], "side": "SELL", "type": "MARKET",
                                   "price": t.get("exitPrice"), "trigger": None, "status": "FILLED",
                                   "note": f"Exit · {reason}" + (f" ({t['exitNote']})" if t.get("exitNote") else "")})
        self._write(day, d)

    # ---------- reading ----------
    def days(self):
        out = set()
        if os.path.isdir(self.dir):
            for f in os.listdir(self.dir):
                if f.startswith("day_") and f.endswith(".json"):
                    out.add(f[4:14])
        out.update(t["day"] for t in self.imported())
        return out

    def orders(self, day):
        rows = list(self._read(day)["orders"])
        for t in self.imported():
            if t["day"] == day:
                rows += excel_orders(t)
        return sorted(rows, key=lambda o: (o.get("time") or "", o.get("side") != "BUY"))

    def trades(self, from_day, to_day):
        out = [t for t in self.imported() if from_day <= t["day"] <= to_day]
        d = Date.fromisoformat(from_day)
        end = Date.fromisoformat(to_day)
        have = self.days()
        while d <= end:
            if d.isoformat() in have:
                out += list(self._read(d.isoformat())["trades"].values())
            d += timedelta(days=1)
        return out


def excel_orders(t):
    base = {"tradeId": t["id"], "strategy": t["strategy"], "account": t["account"], "symbol": t["symbol"],
            "instrument": t["instrument"], "qty": t["qty"], "trigger": None, "source": "excel"}
    out = [{**base, "time": t.get("entryTime"), "orderId": f"{t['id']}-B", "side": "BUY", "type": "MARKET",
            "price": t.get("entryPrice"), "status": "FILLED", "note": "Entry (from Excel)"}]
    if t.get("exitPrice") is not None:
        out.append({**base, "time": t.get("exitTime"), "orderId": f"{t['id']}-S", "side": "SELL", "type": "MARKET",
                    "price": t["exitPrice"], "status": "FILLED", "note": f"Exit · {t.get('exitReason') or '—'} (from Excel)"})
    return out


def manual_round_trips(fills, day):
    """The paper engine's fills of one day -> buy-then-sell round trips per option (long only, as the owner trades).
    A position still open at the end shows as an open trade."""
    out, book = [], {}
    for f in sorted(fills, key=lambda x: x.get("time") or x.get("filled_at") or ""):
        sid = f["security_id"]
        b = book.setdefault(sid, {"qty": 0, "buyQty": 0, "buyVal": 0.0, "sellQty": 0, "sellVal": 0.0, "charges": 0.0,
                                  "first": None, "last": None, "name": f.get("name"), "symbol": f.get("symbol"),
                                  "opt": f.get("optionType")})
        t = f.get("time") or f.get("filled_at") or ""
        t = t[11:19] if len(t) > 8 else t
        b["first"] = b["first"] or t
        b["charges"] += ((f.get("charges") or {}).get("total") or 0)
        if f["side"] == "BUY":
            b["qty"] += f["qty"]
            b["buyQty"] += f["qty"]
            b["buyVal"] += f["qty"] * f["price"]
        else:
            b["qty"] -= f["qty"]
            b["sellQty"] += f["qty"]
            b["sellVal"] += f["qty"] * f["price"]
        b["last"] = t
        if b["qty"] == 0 and b["buyQty"]:
            out.append(_trip(sid, b, day, len(out)))
            book[sid] = {**book[sid], "buyQty": 0, "buyVal": 0.0, "sellQty": 0, "sellVal": 0.0, "charges": 0.0, "first": None}
    for sid, b in book.items():
        if b["qty"] > 0 and b["buyQty"]:
            out.append(_trip(sid, b, day, len(out), open_=True))
    return out


def _trip(sid, b, day, n, open_=False):
    entry = b["buyVal"] / b["buyQty"]
    exit_ = b["sellVal"] / b["sellQty"] if b["sellQty"] else None
    gross = None if open_ else round(b["sellVal"] - b["buyVal"], 2)
    name = b["name"] or str(sid)
    return {"id": f"manual-{day}-{sid}-{n}", "day": day, "source": "manual", "strategy": "Manual", "account": "App · Manual",
            "symbol": b.get("symbol") or ("BANKNIFTY" if name.upper().startswith("BANKNIFTY") else "NIFTY"),
            "side": b.get("opt") or ("PE" if name.upper().rstrip().endswith("PE") else "CE"), "instrument": name, "qty": b["buyQty"],
            "grade": None, "entryTime": b["first"], "entryPrice": round(entry, 2), "stop": None, "target": None,
            "exitTime": None if open_ else b["last"], "exitPrice": None if exit_ is None else round(exit_, 2),
            "exitReason": None if open_ else "Manual", "exitNote": None, "grossPnl": gross,
            "charges": round(b["charges"], 2), "netPnl": None if gross is None else round(gross - b["charges"], 2),
            "status": "open" if open_ else "closed"}


def register(app, journal, paper=None):
    """GET /api/journal/days, /api/journal/orders?date=, /api/journal/trades?from=&to= (all strategies + manual)."""
    from fastapi import HTTPException, Query

    def day_ok(v, name):
        try:
            return Date.fromisoformat(v).isoformat()
        except (TypeError, ValueError):
            raise HTTPException(400, f"{name} must be YYYY-MM-DD")

    def manual_orders(day):
        if paper is None:
            return []
        try:
            rows = paper.orders(day)
        except Exception:
            return []
        out = []
        for o in rows:
            t = o.get("created_at") or ""
            out.append({"tradeId": None, "strategy": "Manual", "account": "App · Manual",
                        "symbol": o.get("symbol") or ("BANKNIFTY" if (o.get("name") or "").upper().startswith("BANKNIFTY") else "NIFTY"),
                        "instrument": o.get("name"), "qty": o.get("qty"), "time": t[11:19] if len(t) > 8 else t,
                        "orderId": o.get("id"), "side": o.get("side"), "type": o.get("order_type") or o.get("type"),
                        "price": o.get("avg_price") or o.get("price"), "trigger": o.get("trigger_price"),
                        "status": o.get("status"), "note": o.get("reason") or ""})
        return out

    def manual_trades(from_day, to_day):
        if paper is None:
            return []
        out = []
        try:
            days = [r["day"] for r in paper.pnl(from_day, to_day)]
        except Exception:
            days = []
        today = paper.clock().date().isoformat()
        if from_day <= today <= to_day and today not in days:
            days.append(today)
        for day in sorted(set(days)):
            try:
                out += manual_round_trips(paper.trades(day), day)
            except Exception:
                log.exception("journal: manual trades %s", day)
        return out

    @app.get("/api/journal/days")
    def days():
        have = set(journal.days())
        if paper is not None:
            try:
                have.update(r["day"] for r in paper.pnl("2026-01-01", paper.clock().date().isoformat()))
            except Exception:
                pass
        return {"days": sorted(have, reverse=True), "strategies": STRATEGIES}

    @app.get("/api/journal/orders")
    def orders(date: str = ""):
        day = day_ok(date, "date")
        rows = journal.orders(day) + manual_orders(day)
        return {"day": day, "rows": sorted(rows, key=lambda o: o.get("time") or "")}

    @app.get("/api/journal/trades")
    def trades(from_day: str = Query("", alias="from"), to: str = ""):
        to_day = day_ok(to, "to")
        start = day_ok(from_day, "from")
        if start > to_day:
            raise HTTPException(400, "from must not be after to")
        rows = journal.trades(start, to_day) + manual_trades(start, to_day)
        return {"from": start, "to": to_day, "rows": sorted(rows, key=lambda t: (t["day"], t.get("entryTime") or ""))}
