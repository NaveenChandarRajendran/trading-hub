"""
orb_service.py - runs the ORB Algo (orb_logic.py, docs/strategies/orb.md) all day on NIFTY. PAPER TRADING ONLY.

Orders go to the paper engine of its own "ORB Algo" account (algo_service.AlgoBroker, the same simulator as the other
algos), never to Dhan: this module imports no Dhan order code (test_orb_service.py checks that). The account's engine
takes orders until, and squares off at, the algo's squareOff (15:25, ADR 0013) instead of the usual 15:15.

Market data: the paper service's Dhan feed (paper.listeners): NIFTY index ticks -> 1-minute candles, each evaluated
once, ~2 s after it closes; the books of 1 ITM / ATM / 2 ITM CE and PE around spot (and every open option) are kept
subscribed so a market order always has a price. At the start of the day, after a restart or a late start, today's
1-minute candles come from Dhan's intraday history (OrbData.intraday) and run through the rules in catch-up mode: the
ORs and setups are right at once, but a signal from a candle that closed while the algo was not running is not traded
("missed"); a stop of an open trade that triggered meanwhile is still executed, at the current price.

Records (Postgres, orb_store.py): every decision (orb_algo_events), the state after every change (orb_algo_state: a
restart resumes the open trades and never evaluates a candle twice), the 15:35 summary per setup. Settings: the
config's DEFAULTS + overrides (th_algo_settings, slug "orb"), each change logged old -> new.
"""
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import Callable

import orb_config as cfg
import orb_logic as L
from algo_logic import round_trip_charges
from algo_service import AlgoBroker
from candles import CandleBuilder, epoch, in_session
from dhan_feed import to_book
from holidays import NSE_HOLIDAYS
from store import IST
from toi_algo_data import option_expiry
from toi_algo_logic import choose_strike, strike_ladder

log = logging.getLogger("orb_algo")

NIFTY_ID = 13
FNO, IDX = "NSE_FNO", "IDX_I"
CLOSE_DELAY = 2  # seconds after a minute ends before its candle is evaluated (late ticks)


@dataclass
class OrbData:
    """What the algo reads besides the feed (main.py wires it to the chain cache and Dhan history)."""
    expiries: Callable[[], list]  # NIFTY option expiries
    chain: Callable[[str], dict]  # expiry -> {"spot", "oc": {strike: {"ce": leg, "pe": leg}}, "lotSize"} (Dhan legs)
    intraday: Callable[[], list]  # NIFTY index 1-minute candles {time, open, high, low, close}, previous session + today
    token_expired: Callable[[], bool]


class OrbAlgoService:
    def __init__(self, store, orb_store, paper, instruments, data: OrbData, clock, mode=cfg.MODE, holidays=NSE_HOLIDAYS):
        self.store, self.orb, self.paper, self.instruments, self.data, self.clock = store, orb_store, paper, instruments, data, clock
        self.mode, self.holidays = mode, holidays
        self.lock = threading.RLock()
        self.broker = (AlgoBroker(store, instruments, clock, holidays, variant="ORB", account_name=cfg.ACCOUNT_NAME,
                                  capital=cfg.CAPITAL, square_off=cfg.hhmm(self.settings()["squareOff"]))
                       if mode == "paper" else None)
        self.state, self.day = None, None
        self.minutes = {}  # epoch start -> today's 1-minute NIFTY candle
        self.candles = CandleBuilder()
        self.spot = self.last_tick = None
        self.expiry = None
        self.watch_ids = {}  # option security id -> (strike, "CE" | "PE") kept subscribed
        self.stale = False
        self._next_heartbeat = None
        self._summary_day = None
        self._stop = threading.Event()
        self._thread = None
        if paper is not None:
            paper.listeners.append(self.on_packet)

    # ------------------------------------------------------------ settings
    def settings(self):
        return cfg.merged(self.orb.settings_store.overrides(cfg.SLUG))

    def set_settings(self, changes, who="", now=None):
        """Saves overrides (validated by the caller, algo_adapters.OrbAdapter); logs each change old -> new."""
        now = now or self.clock()
        with self.lock:
            cur = self.settings()
            bad = [k for k in changes if k not in cfg.DEFAULTS]
            if bad:
                raise ValueError(f"unknown setting(s): {', '.join(bad)}")
            diff = {k: (cur[k], v) for k, v in changes.items() if cur[k] != v}
            if not diff:
                return cur
            saved = {**self.orb.settings_store.overrides(cfg.SLUG), **changes}
            self.orb.settings_store.save(cfg.SLUG, saved, diff, who, now)
            for k, (old, new) in diff.items():
                self._record("settings", f"Setting {k}: {old} -> {new}" + (f" (by {who})" if who else "")
                             + "; open trades keep their stop and lots", now=now, key=k, old=old, new=new)
            if "squareOff" in diff and self.broker:
                self.broker.square_off = cfg.hhmm(changes["squareOff"])
                if self.broker.engine:
                    self.broker.engine.square_off_at = self.broker.square_off
            return self.settings()

    # ------------------------------------------------------------ lifecycle
    def start(self):
        if self.mode == "off":
            log.info("ORB Algo is off (ORB_ALGO_MODE=off)")
            return
        self._thread = threading.Thread(target=self._run, name="orb-algo", daemon=True)
        self._thread.start()

    def stop_thread(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(1.0):
            try:
                self.tick(self.clock())
            except Exception as e:  # never let the loop die
                self._error("timer", e)

    def trading_day(self, now):
        return now.weekday() < 5 and now.date().isoformat() not in self.holidays

    # ------------------------------------------------------------ records
    def _record(self, typ, message, setup="", side=None, now=None, **details):
        now = now or self.clock()
        ev = {"day": now.date().isoformat(), "ts": now, "type": typ, "setup": setup, "side": side, "message": message,
              "details": details}
        try:
            self.orb.add_event(ev)
        except Exception as e:
            log.warning("orb_algo event not stored: %s (%s)", e, message)
        log.info("%s %s %s", typ.upper(), setup, message)

    _err_seen = {}

    def _error(self, where, exc):
        now = self.clock()
        key = (where, str(exc))
        last = self._err_seen.get(key)
        if last is None or (now - last).total_seconds() >= 60:
            self._err_seen[key] = now
            log.exception("orb_algo %s failed", where)
            self._record("error", f"{where}: {exc}", now=now)

    def _save(self, now=None):
        try:
            self.orb.save_state(self.state["day"], self.state, now or self.clock())
        except Exception as e:
            log.warning("orb_algo state not stored: %s", e)

    def _emit(self, outs, now):
        """Events to the log; actions to the paper broker (the answers go back to the rules)."""
        for o in outs:
            if o["type"] == "event":
                self._record(o["kind"], o["message"], setup=o["data"].get("setup", ""), side=o["data"].get("side"), now=now)
            else:
                self._emit(self._act(o, now), now)
        self._save(now)

    # ------------------------------------------------------------ day start, catch-up, restart
    def _ensure_day(self, now):
        day = now.date().isoformat()
        if self.day == day:
            return
        self.day = day
        saved = self.orb.state(day)
        self.state = saved or L.new_state(day)
        self.minutes = {}
        try:
            self.expiry = option_expiry(self.data.expiries(), now.date())
        except Exception as e:
            self._error("expiries", e)
        try:
            for c in self.data.intraday():
                if datetime.fromtimestamp(c["time"], IST).date() == now.date():
                    self.minutes[c["time"]] = dict(c)
        except Exception as e:
            self._error("index history", e)
        if saved:
            self._reconcile(now)
            opens = [st["name"] for st in self.state["setups"].values() if st["open"]]
            self._record("info", f"Restarted: resumed today's state ({self.state['trades']} trades"
                                 + (f", open: {', '.join(opens)}" if opens else "") + ")", now=now)
        before = self.state.get("lastMinute", 0)
        n = self._process(now, live=False)
        if n:
            self._record("info", f"Caught up {n} candle{'s' if n != 1 else ''} from Dhan's history up to "
                                 f"{datetime.fromtimestamp(self.state['lastMinute'] + 60, IST):%H:%M}: ORs and setups "
                                 + ("continued" if before else "built") + "; signals from them are not traded", now=now)
        self._subscribe()
        self._save(now)

    def _reconcile(self, now):
        """After a restart: each open trade as the paper account holds it (a square-off may have sold while down)."""
        if not self.broker:
            return
        for k, st in self.state["setups"].items():
            o = st["open"]
            if not o:
                continue
            o.pop("exiting", None)
            if o.get("pending"):  # the entry's answer never came back: undone
                self._emit(L.on_entry_failed(self.state, k, "the backend stopped while the order was placed"), now)
                continue
            if o.get("securityId") and self.broker.open_qty(o["securityId"]) == 0:
                price = self.broker.last_sell_price(o["securityId"])
                self._emit(self._closed(k, o, price, self.spot, now, "already closed in the paper account (restart)"), now)

    # ------------------------------------------------------------ feed
    def on_packet(self, pkt, now):
        if pkt.get("kind") not in ("full", "ticker", "quote") or self.mode == "off":
            return
        with self.lock:
            try:
                seg, sid, ltp = pkt["segment"], pkt["security_id"], pkt["ltp"]
                if seg == IDX and sid == NIFTY_ID:
                    self.spot, self.last_tick = ltp, now
                    c = self.candles.on_tick(("I", sid), ltp, now)
                    if c:
                        self.minutes[c["time"]] = c
                elif seg == FNO and pkt["kind"] == "full" and self.broker and sid in self.watch_ids:
                    self.broker.on_book(sid, to_book(pkt), now)
            except Exception as e:
                self._error("packet", e)

    def _subscribe(self):
        keys = {(IDX, NIFTY_ID)} | {(FNO, sid) for sid in self.watch_ids}
        if self.paper is not None:
            self.paper.set_feed_keys("orb_algo", keys)

    def _watch_strikes(self):
        """1 ITM / ATM / 2 ITM of both sides around spot, and every open option."""
        if self.spot is None or not self.expiry:
            return
        rows = self.instruments.chain(cfg.SYMBOL, self.expiry)
        by = {(r["strike"], t): (r[t.lower()] or {}).get("securityId") for r in rows for t in ("CE", "PE")}
        ids = {}
        for side in ("CE", "PE"):
            for _lb, k in strike_ladder([r["strike"] for r in rows], self.spot, side):
                if by.get((k, side)):
                    ids[by[(k, side)]] = (k, side)
        for st in self.state["setups"].values():
            if st["open"] and st["open"].get("securityId"):
                ids[st["open"]["securityId"]] = (st["open"]["strike"], st["open"]["side"])
        if ids != self.watch_ids:
            self.watch_ids = ids
            self._subscribe()

    # ------------------------------------------------------------ the timer
    def tick(self, now):
        if self.mode == "off" or not self.trading_day(now):
            return
        with self.lock:
            self._ensure_day(now)
            s = self.settings()
            self._feed_watch(now)
            self._watch_strikes()  # before the candles: an entry needs its option's book subscribed
            self._process(now, live=True)
            if self.broker:
                self.broker.on_time(now)  # the engine's own square-off at squareOff (ADR 0013)
            if now.time() >= cfg.hhmm(s["squareOff"]):
                self._emit(L.square_off(self.state, self.spot, now, s), now)
            self._heartbeat(now)
            if now.time() >= cfg.SUMMARY_AT and self._summary_day != self.day:
                self._summary_day = self.day
                self.write_summary(now)

    def _process(self, now, live):
        """Every closed, not yet evaluated 1-minute candle of today, in order. Returns how many."""
        s = self.settings()
        sq = cfg.hhmm(s["squareOff"])
        n = 0
        for t in sorted(self.minutes):
            start = datetime.fromtimestamp(t, IST)
            if t <= self.state.get("lastMinute", 0) or (start + timedelta(minutes=1)).time() >= sq:
                continue  # the candle closing at squareOff is not evaluated: everything is sold then
            if now < start + timedelta(seconds=60 + CLOSE_DELAY):
                break
            ctx = {"live": live, "stale": self.stale, "capital": cfg.CAPITAL,
                   "dayPnl": self.broker.day_pnl() if self.broker else 0.0}
            self._emit(L.on_minute(self.state, self.minutes[t], s, ctx), now)
            n += 1
        return n

    def _feed_watch(self, now):
        stale = (in_session(now) and now.time() >= dtime(9, 16)
                 and (self.last_tick is None or (now - self.last_tick).total_seconds() > cfg.STALE_NO_ENTRY_SEC))
        if stale != self.stale:
            self.stale = stale
            self._record("feed", f"Live feed stale: no NIFTY tick for over {cfg.STALE_NO_ENTRY_SEC} s, no new entries"
                         if stale else "Live feed back", now=now)

    def _heartbeat(self, now):
        if not in_session(now):
            return
        if self._next_heartbeat is None or now >= self._next_heartbeat:
            self._next_heartbeat = now + timedelta(minutes=cfg.HEARTBEAT_MIN)
            states = ", ".join(f"{st['name']} {st['status']}" for st in self.state["setups"].values())
            self._record("heartbeat", f"Heartbeat: NIFTY {L.fmt(self.spot)}, {self.state['trades']} trades; {states}"
                                      + (", feed stale" if self.stale else ""), now=now)

    # ------------------------------------------------------------ actions -> paper orders
    def _why_not(self, oc, side):
        """Liquidity of a strike from the chain (the shared liquidity rule): '' when it can trade."""
        def why(k):
            leg = (oc.get(float(k)) or {}).get(side.lower()) or {}
            if not float(leg.get("oi") or 0) > 0 and not float(leg.get("volume") or 0) > 0:
                return "untraded"
            if not float(leg.get("volume") or 0) > 0:
                return "no trades today"
            if not (float(leg.get("top_bid_price") or 0) > 0 and float(leg.get("top_ask_price") or 0) > 0):
                return "no bid / ask"
            return ""
        return why

    def _security(self, strike, side):
        for r in self.instruments.chain(cfg.SYMBOL, self.expiry):
            if r["strike"] == float(strike):
                return (r[side.lower()] or {}).get("securityId")
        return None

    def _lot(self, sid):
        return (self.instruments.get(sid) or {}).get("lotSize") or 65

    def _act(self, a, now):
        k = a["setup"]
        name = self.state["setups"][k]["name"]
        if a["do"] == "enter":
            if not self.expiry:
                return L.on_entry_failed(self.state, k, "no option expiry")
            try:
                ch = self.data.chain(self.expiry)
            except Exception as e:
                return L.on_entry_failed(self.state, k, f"option chain unavailable ({e})")
            label, strike, note = choose_strike(list(ch["oc"]), a["spot"], a["side"], self._why_not(ch["oc"], a["side"]),
                                                tuple(self.settings()["strikeFallback"]))
            if strike is None:
                return L.on_entry_failed(self.state, k, note)
            sid = self._security(strike, a["side"])
            if sid is None:
                return L.on_entry_failed(self.state, k, f"{L.fmt(strike)} {a['side']} not in Dhan's instrument list")
            self.watch_ids[sid] = (strike, a["side"])
            self._subscribe()
            if self.mode != "paper":
                leg = (ch["oc"].get(float(strike)) or {}).get(a["side"].lower()) or {}
                return L.on_filled(self.state, k, strike, sid, float(leg.get("last_price") or 0), (note + "; " if note else "") + "signals only")
            order = self.broker.buy(sid, a["lots"], now, f"ORB {name}")
            if order["status"] != "FILLED":
                return L.on_entry_failed(self.state, k, f"paper order {order['status']}: {order.get('reason') or ''}")
            return L.on_filled(self.state, k, strike, sid, order["avg_price"], note)
        o = self.state["setups"][k]["open"]
        if not o:
            return []
        sid = o.get("securityId")
        if self.mode != "paper" or not sid:
            price = self.broker.ltp(sid) if self.broker and sid else None
        elif self.broker.open_qty(sid) < o["lots"] * self._lot(sid):  # the engine's square-off already sold it
            price = self.broker.last_sell_price(sid)
        else:
            try:
                price = self.broker.sell(sid, o["lots"], now, f"ORB {name} exit")
            except Exception as e:
                return L.on_exit_failed(self.state, k, str(e))
            if price is None:
                return L.on_exit_failed(self.state, k, "no buyers in the book")
        return self._closed(k, o, price, a.get("spot"), now, a["reason"])

    def _closed(self, k, o, price, spot, now, reason):
        qty = o["lots"] * self._lot(o.get("securityId"))
        pnl = round((price - o["entryPrice"]) * qty, 2) if price is not None and o.get("entryPrice") is not None else None
        charges = round_trip_charges(o["entryPrice"], price, qty) if pnl is not None else None
        return L.on_exited(self.state, k, spot, price, pnl, charges, now, reason)

    # ------------------------------------------------------------ kill switch, summary, status
    def stop(self, exit_all=False, who=""):
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            self.state["halted"] = True
            self._record("info", ("Kill switch: stop + exit all" if exit_all else "Kill switch: no new entries")
                         + (f" (by {who})" if who else ""), now=now)
            if exit_all:
                outs = []
                for k, st in self.state["setups"].items():
                    o = st["open"]
                    if o and not o.get("exiting") and not o.get("pending"):
                        o["exiting"] = True
                        outs.append(L.action("exit", setup=k, reason="kill switch: stop + exit all", spot=self.spot))
                self._emit(outs, now)
            self._save(now)

    def resume(self, who=""):
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            self.state["halted"] = False
            self._record("info", "Kill switch off: new entries allowed" + (f" (by {who})" if who else ""), now=now)
            self._save(now)

    def write_summary(self, now=None):
        """One row per setup: trades, wins / losses (net of charges), spot points, P&L."""
        now = now or self.clock()
        rows = []
        for k in cfg.SETUPS:
            ts = [t for t in self.state.get("closed", []) if t["setup"] == k]
            net = [(t.get("pnl") or 0) - (t.get("charges") or 0) for t in ts]
            gross, charges = round(sum(t.get("pnl") or 0 for t in ts), 2), round(sum(t.get("charges") or 0 for t in ts), 2)
            rows.append({"day": self.day, "setup": k, "trades": len(ts), "wins": sum(1 for x in net if x > 0),
                         "losses": sum(1 for x in net if x < 0), "points": round(sum(t.get("points") or 0 for t in ts), 2),
                         "gross_pnl": gross, "charges": charges, "net_pnl": round(gross - charges, 2), "updated_at": now})
        self.orb.save_summary(rows)
        self._record("info", "Daily summary: " + "; ".join(
            f"{cfg.SETUPS[r['setup']][0]} {r['trades']} trade{'s' if r['trades'] != 1 else ''} {r['points']:+.2f} pts "
            f"net {L.fmt(r['net_pnl'])}" for r in rows), now=now)
        return rows

    def open_view(self):
        """Open trades with the live option price and P&L."""
        out = []
        for st in (self.state or {}).get("setups", {}).values():
            o = st["open"]
            if not o:
                continue
            ltp = self.broker.ltp(o["securityId"]) if self.broker and o.get("securityId") else None
            qty = o["lots"] * self._lot(o.get("securityId"))
            pnl = round((ltp - o["entryPrice"]) * qty, 2) if ltp is not None and o.get("entryPrice") is not None else None
            pts = L.points(o, self.spot)
            out.append({**o, "ltp": ltp, "pnl": pnl, "pointsNow": pts})
        return out

    def status(self):
        now = self.clock()
        with self.lock:
            st = self.state or {}
            return {"mode": self.mode, "asOf": now.isoformat(), "marketOpen": in_session(now) and self.trading_day(now),
                    "stale": self.stale, "halted": st.get("halted", False), "tokenExpired": bool(self.data.token_expired()),
                    "spot": self.spot, "expiry": self.expiry, "state": st, "open": self.open_view(),
                    "funds": self.broker.funds() if self.broker and self.broker.engine else None, "settings": self.settings()}
