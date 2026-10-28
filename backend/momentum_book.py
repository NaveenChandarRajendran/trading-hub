"""
momentum_book.py - runs the "Momentum 20" monthly stock screener (momentum.py, docs/strategies/momentum-20.md) on two
Rs 5 lakh PAPER books, owner approved 28-Oct-2026 ("run both side by side"):
  momSwitch - goes to cash when Nifty 50 is below its 200-day average at a month end
  momAll    - always invested (each stock must still be above its own 200-day average)
PAPER ONLY: no Dhan order endpoint is touched; prices come from Yahoo Finance daily bars.

Schedule (5-minute loop, also on start-up, so missed days catch up from history):
- last trading day of a month, after 15:50: rank the stocks, save the signal, phone the buy / sell list.
- next trading day, from 09:35: fill both books at that day's open (+/- 0.1 % slippage, delivery charges).
- every trading day after 15:50: value the books at the close.
State: data/books/momentum/state.json.
"""
import csv
import io
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import requests

import holidays
import momentum as M
from store import IST

log = logging.getLogger("momentum")
ACCOUNT = "momentum"
BOOKS = {"momSwitch": "Momentum 20 · with Nifty switch", "momAll": "Momentum 20 · no switch"}
NIFTY = "^NSEI"
CHART = "https://{host}/v8/finance/chart/{sym}"
EQUITY_LIST = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
HISTORY_DAYS = 430  # calendar days of bars for a ranking (253+ trading days)
CLOSE_AT = (15, 50)
OPEN_AT = (9, 35)


# ---------- Yahoo Finance ----------
class YahooPrices:
    def __init__(self, get=None, workers=8):
        self.get = get or (lambda url, params: requests.get(url, params=params, headers=UA, timeout=20))
        self.workers = workers

    def bars(self, sym, start):
        """Daily bars from `start` (date) to today: [{"d", "o", "c", "a", "v"}]. [] when Yahoo has none."""
        p1 = int(datetime.combine(start, datetime.min.time(), IST).timestamp())
        params = {"period1": p1, "period2": int(time.time()) + 86400, "interval": "1d",
                  "events": "div,splits", "includeAdjustedClose": "true"}
        last = None
        for attempt in range(3):
            for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
                try:
                    r = self.get(CHART.format(host=host, sym=sym), params)
                    if r.status_code == 404:
                        return []
                    if r.status_code == 200:
                        return parse_chart(r.json())
                    last = f"Yahoo answered {r.status_code}"
                except Exception as e:  # network blips: try the other host, then back off
                    last = type(e).__name__
            time.sleep(1.5 * (attempt + 1))
        raise IOError(f"{sym}: {last}")

    def many(self, syms, start):
        """{sym: bars}; a symbol that keeps failing is left out (logged)."""
        out = {}

        def one(s):
            try:
                return s, self.bars(s, start)
            except IOError as e:
                log.warning("momentum prices: %s", e)
                return s, None
        with ThreadPoolExecutor(self.workers) as ex:
            for s, b in ex.map(one, syms):
                if b:
                    out[s] = b
        return out


def parse_chart(js):
    res = ((js or {}).get("chart") or {}).get("result") or []
    if not res:
        return []
    r = res[0]
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    adj = ((r.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or [None] * len(ts)
    out = {}
    for i, t in enumerate(ts):
        c = (q.get("close") or [None] * len(ts))[i]
        if not c:
            continue
        d = datetime.fromtimestamp(t, IST).date().isoformat()
        o = (q.get("open") or [None] * len(ts))[i]
        out[d] = {"d": d, "o": o or None, "c": c, "a": adj[i] or c, "v": (q.get("volume") or [0] * len(ts))[i] or 0}
    return [out[d] for d in sorted(out)]


def equity_symbols(path, get=None):
    """NSE equity list (SERIES EQ) as Yahoo symbols. Refreshed every 20 days; the saved copy is used when NSE fails."""
    get = get or (lambda url: requests.get(url, headers=UA, timeout=30))
    fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < 20 * 86400
    if not fresh:
        try:
            r = get(EQUITY_LIST)
            if r.status_code == 200 and "SYMBOL" in r.text[:200]:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(r.text)
        except Exception as e:
            log.warning("momentum: NSE equity list download failed (%s), using the saved copy", e)
    if not os.path.exists(path):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nse_equity_list.csv")  # shipped copy
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(io.StringIO(f.read())))
    key = lambda row, k: next((v for kk, v in row.items() if kk and kk.strip().upper() == k), "")  # noqa: E731
    return sorted({key(r, "SYMBOL").strip() + ".NS" for r in rows if key(r, "SERIES").strip() == "EQ" and key(r, "SYMBOL")})


# ---------- the desk ----------
class MomentumDesk:
    def __init__(self, cfg, on_text=lambda text: None, data_dir="data", prices=None, clock=None, start=True,
                 symbols=None):
        self.cfg = cfg
        self.on_text = on_text
        self.dir = os.path.join(data_dir, "books", ACCOUNT)
        self.path = os.path.join(self.dir, "state.json")
        self.prices = prices or YahooPrices()
        self.clock = clock or (lambda: datetime.now(IST))
        self.symbols = symbols or (lambda: equity_symbols(os.path.join(self.dir, "EQUITY_L.csv")))
        self.lock = threading.RLock()
        self.state = self._load()
        self.snap = json.loads(json.dumps(self.state, default=str))
        self.last_error = ""
        self.busy = False
        self._stop = threading.Event()
        if start:
            threading.Thread(target=self._run, name="momentum", daemon=True).start()

    # ---------- persistence ----------
    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = {}
        cap = float(self.cfg.get("capital", 500000))
        st.setdefault("books", {})
        for k in BOOKS:
            st["books"].setdefault(k, {"cash": cap, "capital": cap, "holdings": {}, "trades": [], "values": [],
                                       "applied": None})
        st.setdefault("signals", {})
        st.setdefault("lastDay", None)
        return st

    def _save(self):
        os.makedirs(self.dir, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=1, default=str)
        os.replace(tmp, self.path)
        self.snap = json.loads(json.dumps(self.state, default=str))

    # ---------- loop ----------
    def _run(self):
        while not self._stop.is_set():
            try:
                self.step()
            except Exception as e:
                self.last_error = f"Momentum books: {e}"
                log.exception("momentum step failed")
            self._stop.wait(300)

    def stop(self):
        self._stop.set()

    def step(self, now=None):
        """Process every trading day since the last one done (catch-up safe; each step is idempotent)."""
        if not self.cfg.get("enabled", True):
            return
        now = now or self.clock()
        with self.lock:
            self.busy = True
            try:
                self._step(now)
                self.last_error = ""
            finally:
                self.busy = False

    def _step(self, now):
        st = self.state
        start = date.fromisoformat(self.cfg.get("start", "2026-10-30"))
        if st["lastDay"] is None:
            st["lastDay"] = (start - timedelta(days=1)).isoformat()
        today = now.date()
        after_close = (now.hour, now.minute) >= CLOSE_AT
        after_open = (now.hour, now.minute) >= OPEN_AT
        nifty = self.prices.bars(NIFTY, today - timedelta(days=HISTORY_DAYS + 30))
        if not nifty:
            raise IOError("no Nifty prices from Yahoo")
        nifty = [b for b in nifty if b["d"] <= today.isoformat()]
        cal = [b["d"] for b in nifty]
        todo = [d for d in cal if d > st["lastDay"] and d >= start.isoformat()]
        for d in todo:
            done_day = d < today.isoformat() or after_close
            if d == today.isoformat() and not after_open:
                break
            self._fill(d)
            if not done_day:
                break  # today's open is filled; the close comes after 15:50
            self._value(d)
            if self._month_end(d, cal, today):
                self._signal(d, cal, nifty)
            st["lastDay"] = d
            self._save()
        self._save()

    @staticmethod
    def _month_end(d, cal, today):
        i = cal.index(d)
        if i + 1 < len(cal):
            nxt = date.fromisoformat(cal[i + 1])
        else:
            nxt = holidays.next_trading_day(date.fromisoformat(d))
        return nxt.month != date.fromisoformat(d).month

    # ---------- month-end ranking ----------
    def _signal(self, d, cal, nifty):
        if d in self.state["signals"]:
            return
        dd = date.fromisoformat(d)
        i = cal.index(d)
        window = cal[max(0, i - 299):i + 1]
        bars = self.prices.many(self.symbols(), dd - timedelta(days=HISTORY_DAYS))
        if len(bars) < self.cfg.get("minStocks", 500):
            raise IOError(f"only {len(bars)} stocks downloaded from Yahoo, ranking postponed")
        ranked = M.rank(bars, window)
        closes = [b["c"] for b in nifty[:i + 1]]
        avg = sum(closes[-M.REGIME_DAYS:]) / min(len(closes), M.REGIME_DAYS)
        sig = {"date": d, "regimeOk": M.regime_ok(closes), "nifty": round(closes[-1], 2), "nifty200": round(avg, 2),
               "ranked": [[s, round(v, 4)] for s, v in ranked[:M.KEEP + 20]], "stocks": len(bars)}
        self.state["signals"][d] = sig
        self._save()
        self.on_text(self.signal_text(sig))

    def plan(self, key, sig):
        b = self.state["books"][key]
        tgt = M.target([tuple(x) for x in sig["ranked"]], list(b["holdings"]), key == "momSwitch", sig["regimeOk"])
        return [s for s in b["holdings"] if s not in tgt], [s for s in tgt if s not in b["holdings"]]

    def signal_text(self, sig):
        nm = lambda s: s.replace(".NS", "")  # noqa: E731
        lines = [f"📈 MOMENTUM 20 · month-end check {sig['date']}",
                 f"Nifty {sig['nifty']:,.0f} vs 200-day avg {sig['nifty200']:,.0f}: "
                 + ("ABOVE (switch ON)" if sig["regimeOk"] else "BELOW (switch OFF, cash)")]
        for key, title in BOOKS.items():
            sells, buys = self.plan(key, sig)
            lines.append(f"\n{title}:")
            if not sells and not buys:
                lines.append("No change." if self.state["books"][key]["holdings"] or not sig["regimeOk"] or key == "momAll"
                             else "Stay in cash.")
            if key == "momSwitch" and not sig["regimeOk"]:
                lines.append("Hold cash." if not sells else "Sell everything, hold cash.")
            if sells:
                lines.append("SELL at next open: " + ", ".join(nm(s) for s in sells))
            if buys:
                lines.append("BUY at next open: " + ", ".join(nm(s) for s in buys))
        lines.append("\nPaper only. Equal money in each stock (about 1/20 of the book).")
        return "\n".join(lines)

    # ---------- fills at the next open ----------
    def _fill(self, d):
        sigs = [s for s in sorted(self.state["signals"]) if s < d]
        if not sigs:
            return
        sd = sigs[-1]
        sig = self.state["signals"][sd]
        todo = [k for k, b in self.state["books"].items() if b.get("applied") != sd]
        if not todo:
            return
        need = set()
        for k in todo:
            sells, buys = self.plan(k, sig)
            need |= set(sells) | set(buys)
        bars = self._bars_since(need, d)
        msgs = [self._apply(k, sig, d, bars) for k in todo]
        self._save()
        self.on_text(f"✅ MOMENTUM 20 · filled at the {d} open (paper)\n" + "\n".join(msgs))

    def _bars_since(self, syms, d):
        """Bars from the earliest entry day of these holdings (or d) on: growth is measured on one Yahoo download so
        splits and dividends are already adjusted on both ends."""
        days = [d] + [b["holdings"][s]["day"] for b in self.state["books"].values() for s in syms if s in b["holdings"]]
        start = date.fromisoformat(min(days)) - timedelta(days=7)
        return self.prices.many(sorted(syms), start) if syms else {}

    @staticmethod
    def _bar(bars, s, day):
        return next((x for x in bars.get(s, []) if x["d"] == day), None)

    @staticmethod
    def _adj_open(x):
        return x["o"] * x["a"] / x["c"] if x and x.get("o") and x.get("c") else None

    def _growth(self, bars, s, h, upto, at_open=False):
        """Adjusted price at `upto` (its open, or the last close up to it) / adjusted open of the entry day."""
        base = self._adj_open(self._bar(bars, s, h["day"]))
        if at_open:
            now = self._adj_open(self._bar(bars, s, upto))
        else:
            xs = [x for x in bars.get(s, []) if x["d"] <= upto]
            now = xs[-1]["a"] if xs else None
        if not base or not now:
            return h.get("growth", 1.0)  # no price today (suspended ...): last known
        return now / base

    def _apply(self, key, sig, d, bars):
        b = self.state["books"][key]
        sells, buys = self.plan(key, sig)
        for s in sells:
            h = b["holdings"].pop(s)
            g = self._growth(bars, s, h, d, at_open=True)
            gross = h["spend"] / (1 + M.SLIP) * g * (1 - M.SLIP)
            cost = M.sell_charges(gross)
            b["cash"] += gross - cost
            x = self._bar(bars, s, d)
            b["trades"].append({"day": d, "sym": s, "side": "SELL", "qty": round(h["qty"], 2),
                                "price": round(x["o"] * (1 - M.SLIP), 2) if x and x.get("o") else None,
                                "charges": round(cost, 2), "pnl": round(gross - cost - h["money"], 2),
                                "pnlPct": round((gross - cost) / h["money"] * 100 - 100, 2), "held": h["day"]})
        opens = {s: self._bar(bars, s, d) for s in buys}
        opens = {s: x for s, x in opens.items() if x and x.get("o")}
        if opens:
            worth = b["cash"] + sum(self._worth(h) for h in b["holdings"].values())
            per = min(b["cash"] / len(opens), worth / M.TOP)
            for s, x in opens.items():
                px, qty, cost = M.buy_qty(per, x["o"])
                b["cash"] -= per
                b["holdings"][s] = {"qty": qty, "entry": px, "day": d, "money": per, "spend": per - cost, "growth": 1.0,
                                    "last": x["o"]}
                b["trades"].append({"day": d, "sym": s, "side": "BUY", "qty": round(qty, 2), "price": round(px, 2),
                                    "charges": round(cost, 2), "money": round(per, 2)})
        b["applied"] = sig["date"]
        skipped = len(buys) - len(opens)
        return f"{BOOKS[key]}: sold {len(sells)}, bought {len(opens)}" + (f" ({skipped} had no price, skipped)" if skipped else "")

    @staticmethod
    def _worth(h):
        return h["spend"] / (1 + M.SLIP) * h.get("growth", 1.0)

    # ---------- daily value ----------
    def _value(self, d):
        held = {s for b in self.state["books"].values() for s in b["holdings"]}
        bars = self._bars_since(held, d)
        for b in self.state["books"].values():
            for s, h in b["holdings"].items():
                h["growth"] = self._growth(bars, s, h, d)
                xs = [x for x in bars.get(s, []) if x["d"] <= d]
                if xs:
                    h["last"] = xs[-1]["c"]
            v = b["cash"] + sum(self._worth(h) for h in b["holdings"].values())
            b["values"] = [x for x in b["values"] if x[0] != d] + [[d, round(v, 2)]]

    # ---------- API ----------
    def status(self):
        st = self.snap  # copy taken at each save: a long download never blocks the page
        sigs = sorted(st["signals"])
        last = st["signals"][sigs[-1]] if sigs else None
        out = {"books": [], "lastDay": st["lastDay"], "error": self.last_error, "busy": self.busy,
               "start": self.cfg.get("start", "2026-10-30"), "nextCheck": self.next_check(),
               "signal": None if not last else {**{k: last[k] for k in ("date", "regimeOk", "nifty", "nifty200", "stocks")},
                                                "top": [s.replace(".NS", "") for s, _ in last["ranked"][:M.TOP]]}}
        for k, title in BOOKS.items():
            b = st["books"][k]
            hold = [{"sym": s.replace(".NS", ""), "qty": round(h["qty"], 2), "entry": round(h["entry"], 2), "since": h["day"],
                     "last": round(h.get("last") or h["entry"], 2), "money": round(h["money"], 2),
                     "value": round(self._worth(h), 2), "pnl": round(self._worth(h) - h["money"], 2),
                     "pnlPct": round((self._worth(h) / h["money"] - 1) * 100, 2)} for s, h in b["holdings"].items()]
            value = b["cash"] + sum(self._worth(h) for h in b["holdings"].values())
            out["books"].append({"key": k, "name": title, "capital": b["capital"], "cash": round(b["cash"], 2),
                                 "value": round(value, 2), "pnl": round(value - b["capital"], 2),
                                 "pnlPct": round((value / b["capital"] - 1) * 100, 2),
                                 "holdings": sorted(hold, key=lambda h: -h["pnl"]),
                                 "trades": b["trades"][-60:], "values": b["values"][-400:]})
        return out

    def next_check(self):
        """The coming month-end check day (by the NSE holiday list)."""
        d = self.clock().date()
        while not holidays.is_trading_day(d) or holidays.next_trading_day(d).month == d.month:
            d += timedelta(days=1)
        return d.isoformat()


def register(app, desk):
    """GET /api/momentum/state, POST /api/momentum/run (run the check now, in the background)."""

    @app.get("/api/momentum/state")
    def state():
        return desk.status()

    @app.post("/api/momentum/run")
    def run():
        if not desk.busy:
            threading.Thread(target=desk.step, daemon=True).start()
        return {"ok": True}
