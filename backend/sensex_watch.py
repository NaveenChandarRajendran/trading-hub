"""
sensex_watch.py - Sensex expiry straddles, WATCH ONLY (owner 3-Nov-2026: "add as watch-only, no rupees counted").
Nothing is bought or sold, not even on paper: on each SENSEX expiry day the app notes the same four short ATM straddles
as the Nifty selling book (09:20 stop +50 % with the other leg's stop moved to cost after a stop, 09:40 +80 %,
11:26 +80 %, 12:24 +70 %, everything out at 15:14) from Dhan's Sensex option chain, checked about once a minute, and
records what each would have made. Backtest May 2023-Oct 2026: +2.04 L, but -39 k in 2026 (research/sensex-straddle/).
Like the Nifty straddles, the day is skipped when India VIX's first value is below 12.

State: data/books/sensex_watch/state.json; closed days also go to <logDir>/sensex_watch.csv for the Excel Shadow Log.
"""
import csv
import json
import logging
import os
import threading
from datetime import datetime

import holidays as H
from paper_charges import order_charges, r2
from sig_indicators import IST

log = logging.getLogger("sensex_watch")
SENSEX_ID, STEP, LOT = 51, 100, 20
ENTRIES = (("09:20", 50, True), ("09:40", 80, False), ("11:26", 80, False), ("12:24", 70, False))
TIME_EXIT = "15:14"
CHECK_SECONDS = 60
FIELDS = ["date", "entry", "strike", "side", "entry_price", "stop", "exit_time", "exit_price", "exit_reason", "net_pnl"]


def _hm(s):
    h, m = s.split(":")
    return int(h), int(m)


class SensexWatch:
    def __init__(self, client, cfg=None, vix=None, data_dir="data", log_dir=None, clock=None, start=True):
        self.client, self.vix = client, vix
        self.cfg = {"enabled": True, "minVixOpen": 12, "lot": LOT, **(cfg or {})}
        self.clock = clock or (lambda: datetime.now(IST))
        self.path = os.path.join(data_dir, "books", "sensex_watch", "state.json")
        self.log_dir = log_dir
        self.lock = threading.RLock()
        self.error = ""
        self._last_check = 0.0
        try:
            with open(self.path, encoding="utf-8") as f:
                self.state = json.load(f)
        except (OSError, ValueError):
            self.state = {}
        self.state.setdefault("day", None)
        self.state.setdefault("legs", [])
        self.state.setdefault("history", [])  # [{"date", "net"}]
        self._stop = threading.Event()
        if start:
            threading.Thread(target=self._run, name="sensex-watch", daemon=True).start()

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f, indent=1)
            os.replace(tmp, self.path)
        except OSError as e:
            self.error = f"Could not save: {e}"

    def _run(self):
        while not self._stop.wait(5.0):
            try:
                self.step(self.clock())
            except Exception as e:
                self.error = str(e)
                log.exception("sensex watch step failed")

    def stop(self):
        self._stop.set()

    # ---------- Dhan ----------
    def _expiries(self):
        p = self.client._post("/optionchain/expirylist", {"UnderlyingScrip": SENSEX_ID, "UnderlyingSeg": "IDX_I"})
        data = p.get("data", p) if isinstance(p, dict) else p
        return sorted(str(x) for x in data or [])

    def _chain(self, expiry):
        from dhan_client import parse_chain
        return parse_chain(self.client._post("/optionchain", {"UnderlyingScrip": SENSEX_ID, "UnderlyingSeg": "IDX_I",
                                                             "Expiry": expiry}))

    @staticmethod
    def _price(chain, strike, side):
        leg = (chain["oc"].get(float(strike)) or {}).get(side.lower()) or {}
        p = leg.get("last_price")
        return float(p) if p else None

    # ---------- schedule ----------
    def step(self, now):
        if not self.cfg.get("enabled", True) or not H.is_trading_day(now.date()):
            return
        day = now.date().isoformat()
        with self.lock:
            if self.state["day"] != day:
                if not (9, 15) <= (now.hour, now.minute) < (15, 30):
                    return
                self.state.update(day=day, legs=[], done=[], note="", expiry=None, vixOpen=None)
                try:
                    exps = self._expiries()
                except Exception as e:
                    self.state["day"] = None
                    self.error = f"Sensex expiries: {e}"
                    return
                self.state["expiry"] = exps[0] if exps and exps[0] == day else None
                self.state["note"] = "" if self.state["expiry"] else "Not a Sensex expiry day"
                self._save()
            if not self.state.get("expiry") or not (9, 15) <= (now.hour, now.minute) < (15, 30):
                return
            if self.state.get("vixOpen") is None and self.vix is not None:
                try:
                    v = self.vix()
                except Exception:
                    v = None
                if v:
                    self.state["vixOpen"] = round(float(v), 2)
            low = self.cfg.get("minVixOpen") or 0
            if low and self.state.get("vixOpen") is not None and self.state["vixOpen"] < low and not self.state["legs"]:
                self.state["note"] = f"Skipped: India VIX opened at {self.state['vixOpen']:.2f}, below {low:g}"
                return
            due = [e for e in ENTRIES if e[0] not in self.state["done"] and (now.hour, now.minute) >= _hm(e[0])]
            open_legs = [lg for lg in self.state["legs"] if lg["status"] == "open"]
            check = open_legs and (now.timestamp() - self._last_check >= CHECK_SECONDS or (now.hour, now.minute) >= _hm(TIME_EXIT))
            if not due and not check:
                return
            try:
                chain = self._chain(self.state["expiry"])
            except Exception as e:
                self.error = f"Sensex chain: {e}"
                return
            self.error = ""
            self._last_check = now.timestamp()
            for at, stop_pct, trail in due:
                self.state["done"].append(at)
                if (now.hour, now.minute) >= _hm(TIME_EXIT):
                    continue
                k = round(chain["spot"] / STEP) * STEP
                for side in ("CE", "PE"):
                    p = self._price(chain, k, side)
                    if p:
                        self.state["legs"].append({"entry": at, "strike": k, "side": side, "entryPrice": p,
                                                   "stop": round(p * (1 + stop_pct / 100), 2), "trail": trail,
                                                   "status": "open", "ltp": p, "entryTime": now.strftime("%H:%M")})
            self._check(chain, now)
            self._save()

    def _check(self, chain, now):
        out = (now.hour, now.minute) >= _hm(TIME_EXIT)
        for lg in [x for x in self.state["legs"] if x["status"] == "open"]:
            p = self._price(chain, lg["strike"], lg["side"])
            if p:
                lg["ltp"] = p
            if out:
                self._close(lg, lg["ltp"], "Time exit 15:14", now)
            elif p and p >= lg["stop"]:
                self._close(lg, p, "Stop", now)
                if lg["trail"]:
                    for o in self.state["legs"]:
                        if o["status"] == "open" and o["entry"] == lg["entry"]:
                            o["stop"] = min(o["stop"], o["entryPrice"])
        if out:
            net = r2(sum(x["netPnl"] for x in self.state["legs"] if x["status"] == "closed"))
            day = self.state["day"]
            self.state["history"] = [h for h in self.state["history"] if h["date"] != day] + [{"date": day, "net": net}]

    def _close(self, lg, price, reason, now):
        q = self.cfg["lot"]
        ch = order_charges("SELL", lg["entryPrice"] * q).total + order_charges("BUY", price * q).total
        lg.update(status="closed", exitPrice=price, exitTime=now.strftime("%H:%M"), exitReason=reason,
                  netPnl=r2((lg["entryPrice"] - price) * q - ch))
        if self.log_dir:
            try:
                path = os.path.join(self.log_dir, "sensex_watch.csv")
                os.makedirs(self.log_dir, exist_ok=True)
                new = not os.path.exists(path)
                with open(path, "a", newline="", encoding="utf-8") as f:
                    w = csv.DictWriter(f, fieldnames=FIELDS)
                    if new:
                        w.writeheader()
                    w.writerow({"date": self.state["day"], "entry": lg["entry"], "strike": lg["strike"], "side": lg["side"],
                                "entry_price": lg["entryPrice"], "stop": lg["stop"], "exit_time": lg["exitTime"],
                                "exit_price": price, "exit_reason": reason, "net_pnl": lg["netPnl"]})
            except OSError as e:
                log.warning("sensex watch csv: %s", e)

    def status(self):
        with self.lock:
            q = self.cfg["lot"]
            legs = self.state["legs"]
            today = r2(sum(x["netPnl"] if x["status"] == "closed" else (x["entryPrice"] - x["ltp"]) * q for x in legs))
            return {"enabled": self.cfg.get("enabled", True), "watchOnly": True, "day": self.state["day"],
                    "expiry": self.state.get("expiry"), "note": self.state.get("note", ""), "legs": legs,
                    "today": today if legs else None, "total": r2(sum(h["net"] for h in self.state["history"])),
                    "history": self.state["history"][-30:], "error": self.error}


def register(app, watch):
    @app.get("/api/sensex-watch/state")
    def state():
        return watch.status()
