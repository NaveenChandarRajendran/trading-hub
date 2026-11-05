"""
fear.py - the "Fear + Calendar" signals (owner approved 5-Nov-2026) and the Nifty FUTURES paper book that trades them.
PAPER ONLY: nothing here can reach a real order endpoint; fills are simulated at the live futures price.

Signals, all decided at about 15:20 on daily values (India VIX and Nifty at the 15:20 minute):
1. Fear: VIX close > 1.10 x its 10-day average (today included) -> long from that close; out at the first later close
   where Nifty closes above its 5-day average (today included), or after 5 trading days.
   (research/published-rules/b4.py, "run_daily": no new entry on the day a trade ends.)
2. Turn of month: long from the close of the 4th-last trading day of a month to the close of the 3rd trading day of the
   next month.
3. Payday: long from the close of the first trading day dated 11th-12th to the close of the first trading day dated
   16th or later.
The book holds 1 lot of the near-month Nifty future whenever any of the three is on (at most 1 lot). Backtest
(5 years, after charges): Nifty +7.0 L, worst fall from a high -1.3 L, profit in all 6 years.

The Fear signal also pauses SuperTrend Breakout and Ladder entries (owner 5-Nov-2026, research/chop-filter): on a day
when a Fear trade is open from an earlier close, they take no new entries.

State: data/books/futures/state.json (position, closed trades) and data/fear_history.json (daily VIX / Nifty at 15:20).
"""
import json
import logging
import os
import threading
from datetime import date, datetime, timedelta
from statistics import fmean

import holidays as H
from paper_charges import Charges, r2
from sig_indicators import IST

log = logging.getLogger("fear")
DECIDE_AT = (15, 21)      # the 15:20 minute has closed
FEAR_X, FEAR_N, EXIT_N, MAX_HOLD = 1.10, 10, 5, 5
NAME = "Fear + Calendar"
VIX_ID, NIFTY_ID = 21, 13


# ---------------------------------------------------------------- pure signal logic
def fear_held(rows):
    """rows: [{"day", "vix", "nifty"}] oldest first (one per trading day). Returns a list of bools: is a Fear trade
    held after that day's close (same replay as the backtest)."""
    out, pos = [], None
    vix = [r["vix"] for r in rows]
    nif = [r["nifty"] for r in rows]
    for i in range(len(rows)):
        exited = False
        if pos is not None:
            if nif[i] > fmean(nif[max(0, i - EXIT_N + 1):i + 1]) or i - pos >= MAX_HOLD:
                pos, exited = None, True
        if pos is None and not exited and i >= FEAR_N - 1 and vix[i] > FEAR_X * fmean(vix[i - FEAR_N + 1:i + 1]):
            pos = i
        out.append(pos is not None)
    return out


def fear_info(rows, today):
    """For the pages and the SuperTrend pause: {"on": a Fear trade is open from an earlier close (pause today),
    "since": its start day, "days": trading days held, "lastVix", "avgVix"}."""
    past = [r for r in rows if r["day"] < today.isoformat()]
    held = fear_held(past)
    info = {"on": bool(held and held[-1]), "since": None, "days": 0, "history": len(past)}
    if info["on"]:
        k = len(held) - 1
        while k > 0 and held[k - 1]:
            k -= 1
        info["since"], info["days"] = past[k]["day"], len(held) - k
    if past:
        info["lastVix"] = past[-1]["vix"]
        info["avgVix"] = round(fmean([r["vix"] for r in past[-FEAR_N:]]), 2)
    return info


def trading_days(year, month, hol=None):
    hol = H.NSE_HOLIDAYS if hol is None else hol
    d, out = date(year, month, 1), []
    while d.month == month:
        if d.weekday() < 5 and d.isoformat() not in hol:
            out.append(d)
        d += timedelta(days=1)
    return out


def tom_held(d, hol=None):
    """Turn of month: held after the close of the last 4 trading days of a month and the first 2 of the next."""
    days = trading_days(d.year, d.month, hol)
    if d not in days:
        return False
    i = days.index(d)
    return i >= len(days) - 4 or i <= 1


def payday_held(d, hol=None):
    """Payday: held after the close of the first trading day dated 11th-12th up to (not after) the 15th."""
    days = trading_days(d.year, d.month, hol)
    if d not in days or not 11 <= d.day <= 15:
        return False
    return any(x.day in (11, 12) and x <= d for x in days)


def legs_after_close(rows, d, hol=None):
    """Which signals want the position held after day d's close (rows must include d's row for Fear)."""
    upto = [r for r in rows if r["day"] <= d.isoformat()]
    fear = bool(upto and upto[-1]["day"] == d.isoformat() and fear_held(upto)[-1])
    return {"fear": fear, "tom": tom_held(d, hol), "payday": payday_held(d, hol)}


FUT_STT, FUT_TXN, FUT_STAMP = 0.0005, 0.0000173, 0.00002  # sell STT 0.05 % (Budget 2026), NSE 1.73 / lakh, stamp 0.002 % buy


def futures_charges(side, value):
    """Dhan charges for one Nifty futures order (flat Rs 20 brokerage)."""
    brok, txn, sebi = 20.0, r2(value * FUT_TXN), r2(value * 10 / 1e7)
    return Charges(brokerage=brok, stt=r2(value * FUT_STT) if side == "SELL" else 0.0, transaction=txn, sebi=sebi,
                   stamp=r2(value * FUT_STAMP) if side == "BUY" else 0.0, gst=r2((brok + txn + sebi) * 0.18))


# ---------------------------------------------------------------- daily history
class FearHistory:
    """Daily India VIX and Nifty at 15:20, kept in data/fear_history.json. Filled from Dhan's 1-minute history at start
    (missed days too) and by record() each day at 15:21."""

    def __init__(self, data_dir="data", client=None, clock=None):
        self.path = os.path.join(data_dir, "fear_history.json")
        self.client, self.clock = client, clock or (lambda: datetime.now(IST))
        self.lock = threading.RLock()
        try:
            with open(self.path, encoding="utf-8") as f:
                self.rows = {r["day"]: r for r in json.load(f)}
        except (OSError, ValueError, TypeError, KeyError):
            self.rows = {}
        self.error = ""

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.list(), f, indent=0)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning("could not save %s: %s", self.path, e)

    def list(self):
        with self.lock:
            return [self.rows[k] for k in sorted(self.rows)][-80:]

    def record(self, day, vix, nifty, source="live"):
        if not vix or not nifty:
            return
        with self.lock:
            self.rows[day] = {"day": day, "vix": round(float(vix), 2), "nifty": round(float(nifty), 2), "source": source}
            self._save()

    def backfill(self, days=40):
        """Fetch the 15:20 closes of the last `days` calendar days (before today) from Dhan's 1-minute history."""
        if self.client is None:
            return 0
        today = self.clock().date()
        frm = today - timedelta(days=days)
        got = {}
        for name, sid in (("vix", VIX_ID), ("nifty", NIFTY_ID)):
            body = {"securityId": str(sid), "exchangeSegment": "IDX_I", "instrument": "INDEX", "interval": "1", "oi": False,
                    "fromDate": f"{frm} 09:15:00", "toDate": f"{today} 09:15:00"}
            try:
                p = self.client._post("/charts/intraday", body, gap=0.3)
            except Exception as e:
                self.error = f"VIX / Nifty history: {e}"
                log.warning(self.error)
                return 0
            for t, c in zip(p.get("timestamp") or [], p.get("close") or []):
                dt = datetime.fromtimestamp(t, IST)
                if (dt.hour, dt.minute) <= (15, 20):
                    got.setdefault(dt.date().isoformat(), {})[name] = c  # the day's last minute up to 15:20
        n = 0
        with self.lock:
            for d, v in got.items():
                if d < today.isoformat() and v.get("vix") and v.get("nifty") and self.rows.get(d, {}).get("source") != "live":
                    self.rows[d] = {"day": d, "vix": round(v["vix"], 2), "nifty": round(v["nifty"], 2), "source": "dhan"}
                    n += 1
            self._save()
        self.error = ""
        return n

    def info(self):
        return fear_info(self.list(), self.clock().date())


# ---------------------------------------------------------------- the futures paper book
class FuturesBook:
    """Rs 2.5 L PAPER book: 1 lot of the near-month Nifty future while any Fear + Calendar signal is on.
    paper: paper_api.PaperService (instruments.futures, watch, ltp); history: FearHistory; get_vix / get_nifty: live
    values for today's 15:20 row."""

    def __init__(self, cfg, paper, history, get_vix, get_nifty, on_event=lambda trade, event: None, data_dir="data",
                 clock=None, start=True):
        self.cfg = {"enabled": True, "capital": 250000, "lots": 1, **(cfg or {})}
        self.paper, self.history, self.get_vix, self.get_nifty = paper, history, get_vix, get_nifty
        self.on_event = on_event
        self.clock = clock or (lambda: datetime.now(IST))
        self.path = os.path.join(data_dir, "books", "futures", "state.json")
        self.lock = threading.RLock()
        self.state = self._load()
        self.error = ""
        self._stop = threading.Event()
        self._watch()
        if start:
            threading.Thread(target=self._run, name="futures-book", daemon=True).start()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = {}
        st.setdefault("position", None)
        st.setdefault("closed", [])
        st.setdefault("done", "")      # last day decided
        st.setdefault("legs", {})
        st.setdefault("seq", 0)
        st.setdefault("lastPrice", None)
        st.setdefault("backfilled", "")
        return st

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f, indent=1, default=str)
            os.replace(tmp, self.path)
        except OSError as e:
            self.error = f"Could not save the futures book: {e}"

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(5.0):
            try:
                self.step(self.clock())
            except Exception:
                log.exception("futures book step failed")

    # ---------- instruments / prices ----------
    def _futures(self):
        try:
            return self.paper.instruments.futures("NIFTY", self.clock().date().isoformat())
        except Exception:
            return []

    def _watch(self):
        ids = [f["securityId"] for f in self._futures()[:2]]
        pos = self.state["position"]
        if pos:
            ids.append(pos["securityId"])
        try:
            self.paper.watch(sorted(set(ids)), group="futures")
        except Exception:
            log.exception("futures book: watch failed")

    def _price(self, sid):
        try:
            return self.paper.ltp(sid)
        except Exception:
            return None

    # ---------- schedule ----------
    def step(self, now):
        if not self.cfg.get("enabled", True):
            return
        today = now.date()
        with self.lock:
            if self.state["backfilled"] != today.isoformat() and (now.hour, now.minute) >= (9, 0):
                self.state["backfilled"] = today.isoformat()
                self._save()
                threading.Thread(target=self.history.backfill, daemon=True).start()
            pos = self.state["position"]
            if pos:
                p = self._price(pos["securityId"])
                if p:
                    self.state["lastPrice"] = [p, now.isoformat()]
                if H.is_trading_day(today) and (now.hour, now.minute) >= (9, 15) and self.state.get("carried") != today.isoformat() \
                        and pos["entryDay"] < today.isoformat():
                    self.state["carried"] = today.isoformat()  # held overnight: show it on today's page
                    self._save()
                    self._emit(pos, "carry", now)
            if not H.is_trading_day(today) or (now.hour, now.minute) < DECIDE_AT or now.hour >= 16:
                return
            if self.state["done"] == today.isoformat():
                return
            self._decide(now)

    def _decide(self, now):
        today = now.date()
        vix, nifty = self.get_vix(), self.get_nifty()
        if not vix or not nifty:
            if (now.hour, now.minute) >= (15, 28):
                self.state["done"] = today.isoformat()
                self.state["note"] = "No VIX / Nifty price at 15:20: nothing decided today"
                self._save()
            return
        self.history.record(today.isoformat(), vix, nifty)
        legs = legs_after_close(self.history.list(), today)
        want = any(legs.values())
        futs = self._futures()
        near = futs[0] if futs else None
        if near and near["expiry"] == today.isoformat() and len(futs) > 1:
            near = futs[1]  # expiry day: the next month's contract
        pos = self.state["position"]
        notes = []
        if pos and (not want or pos["expiry"] <= today.isoformat()):
            if not self._close(pos, "Signals off" if not want else "Roll to next month", now):
                return
            notes.append("sold")
            pos = None
        if want and not pos:
            if not near:
                self.state["note"] = "No Nifty future in the instrument list"
                return
            if not self._open(near, legs, now):
                return
            notes.append("bought")
        self.state["legs"] = legs
        self.state["done"] = today.isoformat()
        on = [k for k, v in legs.items() if v]
        self.state["note"] = (", ".join(notes) + ": " if notes else "") + (
            "holding for " + " + ".join({"fear": "Fear", "tom": "Month turn", "payday": "Mid-month"}[k] for k in on) if on else "flat")
        self._save()

    def _open(self, fut, legs, now):
        self.paper.watch([fut["securityId"]], group="futures-entry")
        px = self._price(fut["securityId"])
        if not px:
            return False
        qty = int(self.cfg.get("lots", 1)) * fut["lotSize"]
        self.state["seq"] += 1
        ch = futures_charges("BUY", px * qty).total
        self.state["position"] = {"id": f"FUT{now:%Y%m%d}-{self.state['seq']}", "securityId": fut["securityId"],
                                  "name": fut["name"], "expiry": fut["expiry"], "qty": qty, "lotSize": fut["lotSize"],
                                  "entryDay": now.date().isoformat(), "entryTime": now.strftime("%H:%M:%S"),
                                  "entryPrice": round(px, 2), "entryCharges": ch,
                                  "why": [k for k, v in legs.items() if v]}
        self._watch()
        self._save()
        self._emit(self.state["position"], "entry", now)
        return True

    def _close(self, pos, reason, now):
        px = self._price(pos["securityId"])
        if not px:
            return False
        ch = futures_charges("SELL", px * pos["qty"]).total
        gross = r2((px - pos["entryPrice"]) * pos["qty"])
        charges = r2(pos["entryCharges"] + ch)
        done = {**pos, "status": "closed", "exitDay": now.date().isoformat(), "exitTime": now.strftime("%H:%M:%S"),
                "exitPrice": round(px, 2), "exitReason": reason, "grossPnl": gross, "charges": charges,
                "netPnl": r2(gross - charges)}
        self.state["closed"].append(done)
        self.state["position"] = None
        self._watch()
        self._save()
        self._emit(done, f"exit {reason}", now)
        return True

    # ---------- reporting ----------
    def trade(self, p):
        return {"id": p["id"], "account": "futures", "slot": "fearCalendar", "symbol": "NIFTY", "side": "FUT",
                "instrument": {"name": p["name"], "securityId": p["securityId"]}, "qty": p["qty"], "grade": None,
                "entryDay": p["entryDay"], "entryTime": p["entryTime"], "entryPrice": p["entryPrice"], "stop": None,
                "target": None, "exitTime": p.get("exitTime"), "exitPrice": p.get("exitPrice"),
                "exitReason": p.get("exitReason"), "grossPnl": p.get("grossPnl"), "charges": p.get("charges"),
                "netPnl": p.get("netPnl"), "status": p.get("status", "open"), "entryOrderId": f"{p['id']}-B",
                "exitOrderId": f"{p['id']}-S" if p.get("status") == "closed" else None}

    def _emit(self, p, event, now):
        try:
            self.on_event(self.trade(p), event)
        except Exception:
            log.exception("futures book: report %s", event)

    def status(self):
        with self.lock:
            pos = self.state["position"]
            open_ = None
            unreal = 0.0
            if pos:
                ltp = self._price(pos["securityId"])
                at = None
                if ltp is None and self.state.get("lastPrice"):
                    ltp, at = self.state["lastPrice"]
                pnl = r2((ltp - pos["entryPrice"]) * pos["qty"]) if ltp else None
                unreal = pnl or 0.0
                open_ = {**self.trade(pos), "ltp": ltp, "priceAt": at, "pnl": pnl, "why": pos.get("why", [])}
            realized = r2(sum(t["netPnl"] for t in self.state["closed"]))
            today = self.clock().date()
            hist = self.history.list()
            nxt = {"tom": tom_held(today), "payday": payday_held(today)}
            return {"enabled": self.cfg.get("enabled", True), "name": NAME, "capital": self.cfg["capital"],
                    "realized": realized, "unrealized": r2(unreal), "equity": r2(self.cfg["capital"] + realized + unreal),
                    "open": open_, "closed": self.state["closed"][-20:], "legs": self.state.get("legs", {}),
                    "calendarToday": nxt, "fear": fear_info(hist, today), "note": self.state.get("note", ""),
                    "decided": self.state["done"], "error": self.error or self.history.error}


def register(app, book=None, history=None):
    @app.get("/api/futures/state")
    def state():
        if book is not None:
            return book.status()
        return {"enabled": False, "fear": history.info() if history else None}
