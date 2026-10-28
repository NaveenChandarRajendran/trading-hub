"""
sell_desk.py - the app's Rs 3 lakh "Selling" paper book (owner approved 28-Oct-2026): runs the three option SELLING
rules of sell_rules.py (docs/strategies/option-selling.md). PAPER ONLY: nothing here can reach a real order endpoint.

Why its own book: the paper engine (paper_engine.py) is long-only and intraday (a SELL may only close a buy; 15:15
square-off), while these rules sell first and the 2-month strangle stays open for weeks. So the desk keeps its own short
legs, fills them on the same live Dhan order book as the other accounts (a sell walks the bids, a buy-back walks the
asks) and charges the same Dhan charges (paper_charges.order_charges). Each leg is reported to the journal and the phone
like the other rule trades (on_event(trade, "entry" | "exit <reason>")), flagged "short": True.

State: data/books/selling/state.json (open legs, today's done flags, the running strangle cycle, closed legs).
Feeds: PaperService.tick_listeners (every Full packet) and its watch(..., group="selling") subscriptions; spot and
60-minute candles from dashboard_api.CandleService. A 1-second timer thread runs the schedule.
"""
import json
import logging
import os
import threading
from datetime import datetime

from paper_charges import order_charges, r2
from paper_engine import walk_depth
import sell_rules as R

log = logging.getLogger("sell_desk")
ACCOUNT = "selling"
RETRY_MIN = 10  # an entry that can't fill (no price yet) keeps trying this many minutes, then the day is skipped


class SellDesk:
    def __init__(self, cfg, paper, candles, on_event=lambda trade, event: None, data_dir="data", clock=None, start=True):
        self.cfg = R.config(cfg)
        self.paper, self.candles, self.on_event = paper, candles, on_event
        self.clock = clock or paper.clock
        self.path = os.path.join(data_dir, "books", ACCOUNT, "state.json")
        self.lock = threading.RLock()
        self.books = {}  # security id -> paper_engine.Book (latest depth)
        self.state = self._load()
        self.last_error = ""
        self._stop = threading.Event()
        self._thread = None
        self._watch()
        if start:
            self.start()

    # ---------- persistence ----------
    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = {}
        st.setdefault("legs", {})       # id -> leg (open and closed; closed ones kept for the history)
        st.setdefault("day", None)
        st.setdefault("done", {})       # rule -> True once today's entry was taken or skipped
        st.setdefault("tries", {})      # rule -> first try time today (ISO)
        st.setdefault("notes", {})      # rule -> what happened today, in words
        st.setdefault("cycle", None)    # running strangle: {"id", "expiry", "booked"}
        st.setdefault("seq", 0)
        return st

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f, indent=1, default=str)
            os.replace(tmp, self.path)
            self.last_error = ""
        except OSError as e:
            self.last_error = f"Could not save the Selling book: {e}"
            log.warning(self.last_error)

    # ---------- lifecycle ----------
    def start(self):
        self._thread = threading.Thread(target=self._run, name="sell-desk", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(1.0):
            try:
                self.step(self.clock())
            except Exception:
                log.exception("selling desk step failed")

    # ---------- market data ----------
    def open_legs(self, rule=None):
        return [lg for lg in self.state["legs"].values() if lg["status"] == "open" and (rule is None or lg["rule"] == rule)]

    def _watch(self):
        ids = [lg["securityId"] for lg in self.open_legs()] + list(self.state.get("pendingWatch", []))
        try:
            self.paper.watch(ids, group="selling")
        except Exception:
            log.exception("selling desk: watch failed")

    def on_tick(self, security_id, book, now):
        """Every Full packet (PaperService.tick_listeners): keep the book, run stops and pending buy-backs."""
        with self.lock:
            self.books[security_id] = book
            for lg in self.open_legs():
                if lg["securityId"] != security_id:
                    continue
                if lg.get("closing"):
                    self._try_close(lg, now)
                elif lg.get("stop") and book.ltp >= lg["stop"] and self._in_session(now):
                    self._close(lg, "Stop", now)

    def ltp(self, security_id):
        b = self.books.get(security_id)
        return b.ltp if b else None

    def spot(self):
        """Latest NIFTY 1-minute close from the candle cache (at most 20 s old)."""
        _f, _s, one_min, _fut, _ve, _le = self.candles.get(R.SYMBOL, max_age=20)
        return one_min[-1]["close"] if one_min else None

    # ---------- schedule ----------
    def _trading_day(self, now):
        return now.weekday() < 5 and now.date().isoformat() not in self.paper.holidays

    @staticmethod
    def _in_session(now):
        return (9, 15) <= (now.hour, now.minute) < (15, 15)

    def _at(self, now, key):
        return (now.hour, now.minute) >= R.hm(key)

    def step(self, now):
        if not self.cfg.get("enabled", True) or not self._trading_day(now):
            return
        with self.lock:
            self._roll_day(now)
            if not self._in_session(now):
                return
            c = self.cfg
            if self._at(now, c["timeExit"]):
                self._time_exit(now)
                return
            for rule, key, fn in ((R.STRADDLE, "entry", self._straddle), (R.STRANGLE, "entry", self._strangle_entry),
                                  (R.CALM, "entry", self._calm)):
                if c[rule].get("enabled", True) and not self.state["done"].get(rule) and self._at(now, c[rule][key]):
                    self._attempt(rule, fn, now)
            if self.state.get("rollPending"):
                self._roll_pending(now)
            if c[R.STRANGLE].get("enabled", True) and not self.state["done"].get("strangleCheck") \
                    and self._at(now, c[R.STRANGLE]["check"]):
                self.state["done"]["strangleCheck"] = True
                self._strangle_check(now)
                self._save()

    def _roll_day(self, now):
        day = now.date().isoformat()
        if self.state["day"] == day:
            return
        self.state.update(day=day, done={}, tries={}, notes={})
        for lg in self.open_legs():  # positional legs show on each day's Today page as open
            self._emit(lg, "carry", now)
        self._save()

    def _attempt(self, rule, fn, now):
        """Runs an entry; 'retry' keeps it for the next second (no price yet), up to RETRY_MIN minutes."""
        first = self.state["tries"].setdefault(rule, now.isoformat())
        try:
            res = fn(now)
        except Exception as e:
            log.exception("selling %s", rule)
            res = f"retry: {e}"
        if isinstance(res, str) and res.startswith("retry"):
            if (now - datetime.fromisoformat(first)).total_seconds() >= RETRY_MIN * 60:
                self.state["done"][rule] = True
                self.state["notes"][rule] = f"Skipped today: {res[7:] or 'no live price'}"
                self._save()
            return
        self.state["done"][rule] = True
        self.state["notes"][rule] = res
        self._save()

    # ---------- the three rules ----------
    def _chain_leg(self, expiry, strike, opt):
        for row in self.paper.instrument_chain(R.SYMBOL, expiry):
            if row["strike"] == strike:
                return row.get(opt.lower())
        return None

    def _ready(self, insts):
        """Watch the instruments; True once each has a live book."""
        want = {i["securityId"] for i in insts}
        if not want <= set(self.books):
            self.state["pendingWatch"] = sorted(want)
            self._watch()
            return False
        return True

    def _straddle(self, now):
        exps = self.paper.option_expiries(R.SYMBOL)
        if not R.is_expiry_day(exps, now.date()):
            return "Not a NIFTY expiry day: no trade"
        spot = self.spot()
        if not spot:
            return "retry: no NIFTY price"
        k = R.atm_strike(spot)
        ce, pe = self._chain_leg(exps[0], k, "CE"), self._chain_leg(exps[0], k, "PE")
        if not ce or not pe:
            return f"Skipped: no {k} options for {exps[0]}"
        if not self._ready([ce, pe]):
            return "retry: waiting for prices"
        pct = self.cfg[R.STRADDLE]["stopPct"]
        legs = [self._sell(R.STRADDLE, inst, now, stop_pct=pct) for inst in (ce, pe)]
        if not all(legs):
            return "retry: no buyers in the depth"
        return f"Sold {k} CE @ {legs[0]['entryPrice']:.2f} + {k} PE @ {legs[1]['entryPrice']:.2f} (spot {spot:,.2f})"

    def _calm(self, now):
        c = self.cfg[R.CALM]
        _sessions, one_min, _fut, _err = self.candles.get_with_futures(R.SYMBOL, max_age=20, n=5)
        cut = now.replace(hour=R.hm(c["entry"])[0], minute=R.hm(c["entry"])[1], second=0, microsecond=0).timestamp()
        mins = [m for m in one_min if m["time"] < cut]
        if not mins or datetime.fromtimestamp(mins[-1]["time"], now.tzinfo).date() != now.date():
            return "retry: no NIFTY candles today yet"
        width = R.bb_width(R.hourly_closes(mins), c["bars"])
        if width is None:
            return "retry: not enough 60-minute candles"
        if not R.calm_check(width, c["maxWidth"]):
            return f"Not calm: band width {width:.2f} % > {c['maxWidth']} %: no trade"
        spot = mins[-1]["close"]
        exps = self.paper.option_expiries(R.SYMBOL)
        k = R.atm_strike(spot)
        ce = self._chain_leg(exps[0], k, "CE") if exps else None
        if not ce:
            return f"Skipped: no {k} CE"
        if not self._ready([ce]):
            return "retry: waiting for prices"
        leg = self._sell(R.CALM, ce, now, stop_pct=c["stopPct"])
        if not leg:
            return "retry: no buyers in the depth"
        return f"Calm (band width {width:.2f} %): sold {k} CE @ {leg['entryPrice']:.2f}"

    def _strangle_entry(self, now):
        c = self.cfg[R.STRANGLE]
        if self.open_legs(R.STRANGLE):
            cyc = self.state["cycle"] or {}
            return f"Holding the {cyc.get('expiry', '')} strangle"
        exp = R.strangle_expiry(self.paper.option_expiries(R.SYMBOL), now.date(), c["days"], c["minDays"], c["maxDays"])
        if not exp:
            return f"Skipped: no NIFTY expiry {c['minDays']}-{c['maxDays']} days away"
        spot = self.spot()
        if not spot:
            return "retry: no NIFTY price"
        kc, kp = R.strangle_strikes(spot, c["awayPct"])
        ce, pe = self._chain_leg(exp, kc, "CE"), self._chain_leg(exp, kp, "PE")
        if not ce or not pe:
            return f"Skipped: no {kc} CE / {kp} PE for {exp}"
        if not self._ready([ce, pe]):
            return "retry: waiting for prices"
        self.state["seq"] += 1
        self.state["cycle"] = {"id": f"STG{now:%Y%m%d}-{self.state['seq']}", "expiry": exp, "booked": 0.0,
                               "start": now.date().isoformat()}
        legs = [self._sell(R.STRANGLE, inst, now) for inst in (ce, pe)]
        if not all(legs):
            for lg in legs:
                if lg:
                    self._close(lg, "Entry incomplete", now)
            self.state["cycle"] = None
            return "retry: no buyers in the depth"
        return f"Sold {exp} {kc} CE @ {legs[0]['entryPrice']:.2f} + {kp} PE @ {legs[1]['entryPrice']:.2f} (spot {spot:,.2f})"

    def _strangle_check(self, now):
        """15:05: roll legs that kept 70 % of their premium; buy everything back at a Rs 60k loss."""
        c, cyc = self.cfg[R.STRANGLE], self.state["cycle"]
        legs = self.open_legs(R.STRANGLE)
        if not legs or not cyc:
            return
        notes = []
        spot = self.spot()
        for lg in legs:
            ltp = self.ltp(lg["securityId"])
            if spot and R.roll_due(lg["entryPrice"], ltp, c["rollAtPct"]):
                self._close(lg, "Roll", now)
                kc, kp = R.strangle_strikes(spot, c["awayPct"])
                k = kc if lg["side"] == "CE" else kp
                inst = self._chain_leg(cyc["expiry"], k, lg["side"])
                if inst and self._ready([inst]):
                    new = self._sell(R.STRANGLE, inst, now)
                    notes.append(f"rolled {lg['side']} to {k}" + ("" if new else " (sell failed)"))
                else:
                    self.state["rollPending"] = {"side": lg["side"], "strike": k, "at": now.isoformat()}
                    notes.append(f"rolled {lg['side']}: new {k} leg waits for a price")
        loss = self.cycle_pnl()
        if loss is not None and loss <= -c["maxLoss"]:
            for lg in self.open_legs(R.STRANGLE):
                self._close(lg, f"Max loss Rs {c['maxLoss']:,}", now)
            notes.append(f"stopped at {loss:,.0f}")
        if notes:
            self.state["notes"][R.STRANGLE] = "15:05 check: " + "; ".join(notes)

    def _roll_pending(self, now):
        """A rolled leg whose new strike had no price yet: sell it once it has one (the same day only)."""
        p, cyc = self.state["rollPending"], self.state["cycle"]
        if not cyc or p["at"][:10] != now.date().isoformat():
            self.state.pop("rollPending", None)
            return
        inst = self._chain_leg(cyc["expiry"], p["strike"], p["side"])
        if inst and self._ready([inst]) and self._sell(R.STRANGLE, inst, now):
            self.state.pop("rollPending", None)
            self._save()

    def cycle_pnl(self):
        """The running strangle's total: booked (after charges) + open legs at LTP less their sell charges."""
        cyc = self.state["cycle"]
        if not cyc:
            return None
        total = cyc["booked"]
        for lg in self.open_legs(R.STRANGLE):
            ltp = self.ltp(lg["securityId"])
            if ltp is None:
                return None
            total += (lg["entryPrice"] - ltp) * lg["qty"] - lg["entryCharges"]
        return r2(total)

    def _time_exit(self, now):
        today = now.date().isoformat()
        for lg in self.open_legs():
            if lg.get("closing"):
                continue
            if lg["rule"] in (R.STRADDLE, R.CALM) or lg["expiry"] <= today:
                self._close(lg, "Time exit 15:14" if lg["rule"] != R.STRANGLE else "Expiry day 15:14", now)

    # ---------- fills ----------
    def _sell(self, rule, inst, now, stop_pct=None):
        """Sell 1 lot (cfg lots) at market on the bids. Returns the leg, or None if no buyers."""
        book = self.books.get(inst["securityId"])
        qty = self.cfg.get("lots", 1) * inst["lotSize"]
        w = walk_depth(book.bids, qty) if book else None
        if w is None:
            return None
        avg, value, capped = w
        ch = order_charges("SELL", value).total
        self.state["seq"] += 1
        lid = f"SL{now:%Y%m%d}-{self.state['seq']:04d}"
        lg = {"id": lid, "rule": rule, "symbol": R.SYMBOL, "side": inst["optionType"], "securityId": inst["securityId"],
              "name": inst["name"], "strike": inst["strike"], "expiry": inst["expiry"], "lotSize": inst["lotSize"],
              "qty": qty, "entryDay": now.date().isoformat(), "entryTime": now.strftime("%H:%M:%S"),
              "entryPrice": round(avg, 2), "entryCharges": ch, "slippageCapped": capped,
              "stop": R.leg_stop(avg, stop_pct) if stop_pct else None, "status": "open"}
        if rule == R.STRANGLE and self.state["cycle"]:
            lg["cycle"] = self.state["cycle"]["id"]
        self.state["legs"][lid] = lg
        self.state.pop("pendingWatch", None)
        self._watch()
        self._save()
        self._emit(lg, "entry", now)
        return lg

    def _close(self, lg, reason, now):
        lg["closing"] = reason
        self._try_close(lg, now)

    def _try_close(self, lg, now):
        book = self.books.get(lg["securityId"])
        w = walk_depth(book.asks, lg["qty"]) if book else None
        if w is None:  # no sellers this second: buy back on the next tick with asks
            return
        avg, value, _capped = w
        reason = lg.pop("closing")
        ch = order_charges("BUY", value).total
        gross = r2((lg["entryPrice"] - avg) * lg["qty"])
        charges = r2(lg["entryCharges"] + ch)
        lg.update(status="closed", exitDay=now.date().isoformat(), exitTime=now.strftime("%H:%M:%S"), exitPrice=round(avg, 2),
                  exitReason=reason, grossPnl=gross, charges=charges, netPnl=r2(gross - charges))
        if lg["rule"] == R.STRANGLE and self.state["cycle"] and lg.get("cycle") == self.state["cycle"]["id"]:
            self.state["cycle"]["booked"] = r2(self.state["cycle"]["booked"] + lg["netPnl"])
            if not self.open_legs(R.STRANGLE) and reason != "Roll":
                self.state["cycle"] = None
        if lg["rule"] == R.STRADDLE and reason == "Stop" and self.cfg[R.STRADDLE].get("trailToCost", True):
            for other in self.open_legs(R.STRADDLE):  # the other leg's stop moves to its own sell price
                other["stop"] = min(other["stop"] or other["entryPrice"], other["entryPrice"])
        self._watch()
        self._save()
        self._emit(lg, f"exit {reason}", now)

    # ---------- reporting ----------
    def trade(self, lg):
        """The leg as a journal / phone trade (same keys as autopaper trades), short: True."""
        return {"id": lg["id"], "account": ACCOUNT, "slot": lg["rule"], "symbol": lg["symbol"], "side": lg["side"],
                "short": True, "instrument": {"name": lg["name"], "securityId": lg["securityId"]}, "qty": lg["qty"],
                "grade": None, "entryDay": lg["entryDay"], "entryTime": lg["entryTime"], "entryPrice": lg["entryPrice"],
                "stop": lg.get("stop"), "target": None, "exitTime": lg.get("exitTime"), "exitPrice": lg.get("exitPrice"),
                "exitReason": lg.get("exitReason"), "grossPnl": lg.get("grossPnl"), "charges": lg.get("charges"),
                "netPnl": lg.get("netPnl"), "status": lg["status"], "entryOrderId": f"{lg['id']}-S",
                "exitOrderId": f"{lg['id']}-B" if lg["status"] == "closed" else None}

    def _emit(self, lg, event, now):
        try:
            self.on_event(self.trade(lg), event)
        except Exception:
            log.exception("selling desk: report %s %s", lg["id"], event)

    def status(self):
        with self.lock:
            legs = sorted(self.state["legs"].values(), key=lambda x: (x["entryDay"], x["entryTime"]))
            open_ = []
            unreal = 0.0
            for lg in legs:
                if lg["status"] != "open":
                    continue
                ltp = self.ltp(lg["securityId"])
                pnl = r2((lg["entryPrice"] - ltp) * lg["qty"]) if ltp is not None else None
                unreal += pnl or 0
                open_.append({**self.trade(lg), "ltp": ltp, "pnl": pnl, "expiry": lg["expiry"], "rule": R.NAMES[lg["rule"]]})
            closed = [lg for lg in legs if lg["status"] == "closed"]
            realized = r2(sum(lg["netPnl"] for lg in closed))
            today = self.state["day"]
            return {"enabled": self.cfg.get("enabled", True), "capital": self.cfg["capital"], "realized": realized,
                    "unrealized": r2(unreal), "equity": r2(self.cfg["capital"] + realized + unreal), "open": open_,
                    "closedToday": [self.trade(lg) for lg in closed if lg.get("exitDay") == today],
                    "notes": {R.NAMES[k]: v for k, v in self.state["notes"].items() if k in R.NAMES},
                    "cycle": {**self.state["cycle"], "pnl": self.cycle_pnl()} if self.state["cycle"] else None,
                    "error": self.last_error}

    def exit_leg(self, leg_id):
        with self.lock:
            lg = self.state["legs"].get(leg_id)
            if not lg or lg["status"] != "open":
                raise LookupError(f"No open selling leg {leg_id}")
            self._close(lg, "Exit by you", self.clock())
            return self.trade(lg)


def register(app, desk):
    from fastapi import HTTPException

    @app.get("/api/selling/state")
    def state():
        return desk.status()

    @app.post("/api/selling/exit/{leg_id}")
    def exit_one(leg_id: str):
        try:
            return desk.exit_leg(leg_id)
        except LookupError as e:
            raise HTTPException(404, str(e))

