"""
toi_algo_service.py - runs the Trending OI Algo (toi_algo_logic.py) all day on NIFTY. PAPER TRADING ONLY.

Orders go to the paper engine of its own "Trending OI Algo" account (algo_service.AlgoBroker, the same simulator as
the OI breakout algo and the Paper Trading page), never to Dhan: this module imports no Dhan order code
(test_toi_algo_service.py checks that).

Market data: the paper service's single Dhan feed (paper.listeners): NIFTY index ticks -> 1-minute candles -> closed
5-minute candles; the VWAP future's Full packets -> its price and per-minute volume; the candidate options' books
(1 ITM / ATM / 2 ITM for CE and PE around spot, kept subscribed so a market order always has a book). At the start of
the day (or after a restart / a late start) the index and future 1-minute candles come from Dhan's intraday history,
so Supertrend, RSI and VWAP are right at once; candles that closed before the algo was running are not traded
(catch-up). Trending OI rows, the option chain (liquidity, delta) and the 09:30 levels come from the backend's own
caches (ToiData, wired in main.py).

Records (Postgres, toi_algo_store.py): every decision (toi_algo_events), the state after every change
(toi_algo_state: a restart resumes the open trade, its adds and the day's counts, never entering a candle twice),
each evaluated candle with its indicator values (toi_algo_candles), the 15:35 daily summary. Settings: the config's
DEFAULTS + the page's overrides (toi_algo_settings); each change is logged with old -> new.
"""
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import Callable

import toi_algo_logic as L
import trending_oi_algo_config as cfg
from algo_filters import rsi as rsi_series
from algo_service import AlgoBroker
from candles import CandleBuilder, VolumeBuilder, aggregate, bucket_start, epoch, in_session
from dhan_feed import to_book
from holidays import NSE_HOLIDAYS
from indicators import session_vwap, supertrend, vwap_index
from sr_levels import rank_levels, side_oi
from store import IST
from toi_algo_data import option_expiry, today_only, vwap_future

log = logging.getLogger("toi_algo")

NIFTY_ID = 13
FNO, IDX = "NSE_FNO", "IDX_I"
SOURCE_SETUP = "Trending OI"
SUMMARY_AT = dtime(15, 35)
HEARTBEAT_MIN = 15


@dataclass
class ToiData:
    """What the algo reads besides the feed (main.py wires it to the tracker, chain cache and Dhan history)."""
    expiries: Callable[[], list]  # NIFTY option expiries, nearest first
    chain: Callable[[str], dict]  # expiry -> {"spot", "oc": {strike: {"ce": leg, "pe": leg}}, "lotSize"} (Dhan legs)
    trending_rows: Callable[[], list]  # today's 5-minute NIFTY Trending OI rows, newest first (as /api/trending-oi)
    intraday: Callable[[], list]  # NIFTY index 1-minute candles, previous session + today
    future_intraday: Callable[[int], list]  # a future's 1-minute candles with volume, previous session + today
    futures: Callable[[], list]  # index futures (instruments.parse_index_futures rows)
    levels: Callable[[str], dict | None]  # the OI breakout algo's NIFTY levels locked that day, if any
    token_expired: Callable[[], bool]


class ToiAlgoService:
    def __init__(self, store, toi_store, paper, instruments, data: ToiData, clock, mode=cfg.MODE, holidays=NSE_HOLIDAYS):
        self.store, self.toi, self.paper, self.instruments, self.data, self.clock = store, toi_store, paper, instruments, data, clock
        self.mode, self.holidays = mode, holidays
        self.lock = threading.RLock()
        self.broker = (AlgoBroker(store, instruments, clock, holidays, variant="TOI", account_name=cfg.ACCOUNT_NAME,
                                  capital=cfg.CAPITAL) if mode == "paper" else None)
        self.state, self.day = None, None
        self.minutes, self.fut_minutes = {}, {}  # epoch -> 1-minute candle (index; future with volume)
        self.candles, self.volumes = CandleBuilder(), VolumeBuilder()
        self.spot = self.fut_ltp = self.last_tick = None
        self.fut = None  # the VWAP future {"securityId", "expiry", ...}
        self.expiry = None  # today's option expiry
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
        return cfg.merged(self.toi.settings())

    def set_settings(self, changes, who="", now=None):
        """Saves overrides; logs every changed key old -> new with the time. Returns the merged settings."""
        now = now or self.clock()
        with self.lock:
            cur = self.settings()
            bad = [k for k in changes if k not in cfg.DEFAULTS]
            if bad:
                raise ValueError(f"unknown setting(s): {', '.join(bad)}")
            diff = {k: (cur[k], v) for k, v in changes.items() if cur[k] != v}
            if not diff:
                return cur
            saved = {**self.toi.settings(), **changes}
            self.toi.save_settings(saved, now)
            for k, (old, new) in diff.items():
                self._record("settings", f"Setting {k}: {old} -> {new}" + (f" (by {who})" if who else "")
                             + "; open trades keep their stop and lots", now=now, key=k, old=old, new=new)
            return self.settings()

    # ------------------------------------------------------------ lifecycle
    def start(self):
        if self.mode == "off":
            log.info("Trending OI Algo is off (TOI_ALGO_MODE=off)")
            return
        self._thread = threading.Thread(target=self._run, name="toi-algo", daemon=True)
        self._thread.start()

    def stop_thread(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(1.0):
            try:
                self.tick(self.clock())
            except Exception as e:  # never let the loop die; logged once a minute at most
                self._error("timer", e)

    def trading_day(self, now):
        return now.weekday() < 5 and now.date().isoformat() not in self.holidays

    # ------------------------------------------------------------ records
    def _record(self, typ, message, side=None, now=None, **details):
        now = now or self.clock()
        ev = {"day": now.date().isoformat(), "ts": now, "type": typ, "side": side, "message": message, "details": details}
        try:
            self.toi.add_event(ev)
        except Exception as e:
            log.warning("toi_algo event not stored: %s (%s)", e, message)
        log.info("%s %s %s", typ.upper(), side or "", message)

    _err_seen = {}

    def _error(self, where, exc):
        now = self.clock()
        key = (where, str(exc))
        last = self._err_seen.get(key)
        if last is None or (now - last).total_seconds() >= 60:
            self._err_seen[key] = now
            log.exception("toi_algo %s failed", where)
            self._record("error", f"{where}: {exc}", now=now)

    def _save(self, now=None):
        try:
            self.toi.save_state(self.state["day"], self.state, now or self.clock())
        except Exception as e:
            log.warning("toi_algo state not stored: %s", e)

    def _emit(self, outs, now, c=None):
        """Events to the log; actions to the paper broker (results go back to the rules)."""
        for o in outs:
            if o["type"] == "event":
                self._record(o["kind"], o["message"], side=o["data"].get("side"), now=now)
            else:
                self._emit(self._act(o, now, c), now)
        self._save(now)

    # ------------------------------------------------------------ day start, warm-up, catch-up, restart
    def _ensure_day(self, now):
        day = now.date().isoformat()
        if self.day == day:
            return
        self.day = day
        saved = self.toi.state(day)
        self.state = saved or L.new_state(day)
        self.minutes, self.fut_minutes = {}, {}
        try:
            self.expiry = option_expiry(self.data.expiries(), now.date())
        except Exception as e:
            self._error("expiries", e)
        try:
            self.fut = vwap_future(self.data.futures(), now.date())
        except Exception as e:
            self._error("futures", e)
        self._warm(now)
        last = self._last_closed_end(now)
        if saved:
            self._reconcile(now)
            self._record("info", f"Restarted: resumed today's state ({self.state['trades']} trades"
                                 + (f", open {self.state['open']['side']} {self.state['open']['lots']} lots" if self.state["open"] else "")
                                 + ")", now=now)
        if last and self.state.get("lastCandle", 0) < epoch(last):
            if self.state.get("lastCandle"):
                self._record("info", f"Caught up: candles up to {last:%H:%M} closed while the algo was down; "
                                     "indicators include them, they are not traded", now=now)
            else:
                self._record("info", f"Started at {now:%H:%M}: indicators from Dhan's history; candles up to "
                                     f"{last:%H:%M} are not traded", now=now)
            self.state["lastCandle"] = epoch(last)
        self._subscribe()
        self._save(now)

    def _warm(self, now):
        try:
            for c in self.data.intraday():
                self.minutes[c["time"]] = dict(c)
        except Exception as e:
            self._error("index history", e)
        if self.fut:
            try:
                for c in self.data.future_intraday(self.fut["securityId"]):
                    self.fut_minutes[c["time"]] = dict(c)
            except Exception as e:
                self._error("future history", e)

    def _reconcile(self, now):
        """After a restart: the open trade as the paper account holds it (a fill may have landed while it was down)."""
        o = self.state.get("open")
        if not o or not self.broker or not o.get("securityId"):
            return
        lot = (self.instruments.get(o["securityId"]) or {}).get("lotSize") or 65
        held = self.broker.open_qty(o["securityId"]) // lot
        for k in ("adding", "partialPending", "exiting"):
            o.pop(k, None)
        if held == 0:
            self._record("info", f"Restart: the {o['side']} position is already closed in the paper account", now=now)
            self.state["closed"].append({**o, "exitAt": now.strftime("%H:%M"), "pnl": None})
            self.state["open"] = None
        elif held != o["lots"]:
            self._record("info", f"Restart: {o['lots']} lots in the state, {held} in the paper account: using {held}", now=now)
            o["lots"] = held

    @staticmethod
    def _last_closed_end(now):
        """End of the newest closed 5-minute candle (= start of the one forming); None before 09:20."""
        t = now.astimezone(IST)
        if t.time() < dtime(9, 20):
            return None
        if t.time() >= dtime(15, 30):
            return t.replace(hour=15, minute=30, second=0, microsecond=0)
        return bucket_start(t, 5)

    # ------------------------------------------------------------ feed
    def on_packet(self, pkt, now):
        if pkt.get("kind") not in ("full", "ticker", "quote") or self.mode == "off":
            return
        with self.lock:
            try:
                self._on_packet(pkt, now)
            except Exception as e:
                self._error("packet", e)

    def _on_packet(self, pkt, now):
        seg, sid, ltp = pkt["segment"], pkt["security_id"], pkt["ltp"]
        if seg == IDX and sid == NIFTY_ID:
            self.spot, self.last_tick = ltp, now
            c = self.candles.on_tick(("I", sid), ltp, now)
            if c:
                self.minutes[c["time"]] = c
            if self.state and self.state.get("open"):
                o = self.state["open"]
                opt = self.broker.ltp(o["securityId"]) if self.broker and o.get("securityId") else None
                self._emit(L.on_tick(self.state, ltp, now, self.settings(), opt), now)
        elif seg == FNO and self.fut and sid == self.fut["securityId"]:
            self.fut_ltp = ltp
            c = self.candles.on_tick(("F", sid), ltp, now)
            v = self.volumes.on_volume(("F", sid), pkt.get("volume"), now) if pkt["kind"] == "full" else None
            if c:
                row = self.fut_minutes.setdefault(c["time"], {})
                row.update(c)
                if v:
                    row["volume"] = v["volume"]
        elif seg == FNO and pkt["kind"] == "full" and self.broker and sid in self.watch_ids:
            self.broker.on_book(sid, to_book(pkt), now)

    def _subscribe(self):
        """The index, the VWAP future and the candidate options (and the open one)."""
        keys = {(IDX, NIFTY_ID)}
        if self.fut:
            keys.add((FNO, self.fut["securityId"]))
        keys |= {(FNO, sid) for sid in self.watch_ids}
        if self.paper is not None:
            self.paper.set_feed_keys("toi_algo", keys)

    def _watch_strikes(self):
        """Keep 1 ITM / ATM / 2 ITM of both sides around spot (and the open option) subscribed."""
        if self.spot is None or not self.expiry:
            return
        rows = self.instruments.chain(cfg.SYMBOL, self.expiry)
        strikes = [r["strike"] for r in rows]
        by = {(r["strike"], t): (r[t.lower()] or {}).get("securityId") for r in rows for t in ("CE", "PE")}
        ids = {}
        for side in ("CE", "PE"):
            for _lb, k in L.strike_ladder(strikes, self.spot, side):
                if by.get((k, side)):
                    ids[by[(k, side)]] = (k, side)
        o = self.state.get("open") if self.state else None
        if o and o.get("securityId"):
            ids[o["securityId"]] = (o["strike"], o["side"])
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
            if self.broker:
                self.broker.on_time(now)
            self._watch_strikes()
            self._feed_watch(now)
            if self.state.get("levels") is None and now.time() >= cfg.LEVELS_AT:
                self._lock_levels(now)
            end = self._last_closed_end(now)
            if end and epoch(end) > self.state.get("lastCandle", 0) and now - end >= timedelta(seconds=10):
                self.state["lastCandle"] = epoch(end)
                self._close_candle(end, now, s)
            if self.state.get("open") and self.spot is not None and now.time() >= cfg.hhmm(s["squareOff"]):
                o = self.state["open"]
                opt = self.broker.ltp(o["securityId"]) if self.broker and o.get("securityId") else None
                self._emit(L.on_tick(self.state, self.spot, now, s, opt), now)
            self._heartbeat(now)
            if now.time() >= SUMMARY_AT and self._summary_day != self.day:
                self._summary_day = self.day
                self.write_summary(now)

    def _feed_watch(self, now):
        stale = (in_session(now) and now.time() >= dtime(9, 16)
                 and (self.last_tick is None or (now - self.last_tick).total_seconds() > cfg.STALE_NO_ENTRY_SEC))
        if stale != self.stale:
            self.stale = stale
            self._record("feed", "Live feed stale: no index tick for over "
                                 f"{cfg.STALE_NO_ENTRY_SEC} s, no new entries" if stale else "Live feed back", now=now)

    def _heartbeat(self, now):
        if not in_session(now):
            return
        if self._next_heartbeat is None or now >= self._next_heartbeat:
            self._next_heartbeat = now + timedelta(minutes=HEARTBEAT_MIN)
            o = self.state.get("open")
            self._record("heartbeat", f"Heartbeat: NIFTY {L.fmt(self.spot)}, future {L.fmt(self.fut_ltp)}, "
                                      f"{self.state['trades']} trades" + (f", open {o['side']} {o['lots']} lots" if o else "")
                                      + (", feed stale" if self.stale else ""), now=now)

    def _lock_levels(self, now):
        lv = None
        try:
            lv = self.data.levels(self.day)
        except Exception:
            lv = None
        if not lv and self.expiry:
            try:
                ch = self.data.chain(self.expiry)
                lv = {}
                for side in ("R", "S"):
                    for i, (k, _oi) in enumerate(rank_levels(side_oi(ch["oc"], side), ch["spot"], side, cfg.LEVEL_RANGE), 1):
                        lv[f"{side}{i}"] = k
            except Exception as e:
                self._error("levels", e)
                return
        if lv:
            self.state["levels"], self.state["levelsAt"] = lv, now.strftime("%H:%M")
            self._record("levels", "Levels locked: " + " ".join(f"{k} {L.fmt(lv[k])}" for k in sorted(lv) if lv.get(k)), now=now)
            self._save(now)

    # ------------------------------------------------------------ a closed 5-minute candle
    def indicators(self, end):
        """Index 5-minute candles up to `end` and the values at the last one: Supertrend, RSI, VWAP (index terms)."""
        mins = [self.minutes[t] for t in sorted(self.minutes) if t < epoch(end)]
        five = aggregate(mins, 5)
        if not five:
            return None
        s = self.settings()
        st = supertrend(five, s["supertrendPeriod"], s["supertrendMult"])[-1]
        r = rsi_series([c["close"] for c in five], s["rsiPeriod"])[-1]
        fmins = [self.fut_minutes[t] for t in sorted(self.fut_minutes) if t < epoch(end) and "close" in self.fut_minutes[t]]
        today = today_only(fmins, end.date())
        vf = session_vwap(today)[-1] if today else None
        fut_close = today[-1]["close"] if today else None
        basis = round(fut_close - five[-1]["close"], 2) if fut_close is not None else None
        return {"five": five, "candle": five[-1], "st": st, "rsi": r, "vwapFuture": vf, "basis": basis,
                "vwap": vwap_index(vf, fut_close, five[-1]["close"])}

    def _close_candle(self, end, now, s):
        ind = self.indicators(end)
        if ind is None:
            return
        today = today_only(ind["five"], end.date())
        rows = []
        try:
            rows = list(reversed(self.data.trending_rows() or []))
        except Exception as e:
            self._error("Trending OI", e)
        o = self.state.get("open")
        opt_ltp = delta = lot = None
        if o and o.get("securityId"):
            opt_ltp = self.broker.ltp(o["securityId"]) if self.broker else None
            delta, lot = self._delta_lot(o["strike"], o["side"])
        c = {"now": end, "candle": ind["candle"], "spot": ind["candle"]["close"], "st": ind["st"], "vwap": ind["vwap"],
             "rsi": ind["rsi"], "rows": rows, "dayLow": min(x["low"] for x in today) if today else None,
             "dayHigh": max(x["high"] for x in today) if today else None, "dayPnl": self.broker.day_pnl() if self.broker else 0.0,
             "capital": cfg.CAPITAL, "stale": self.stale, "halted": self.state.get("halted", False),
             "optionLtp": opt_ltp, "delta": delta, "lotSize": lot}
        self._emit(L.on_candle(self.state, c, s), now, c)
        last_row = rows[-1] if rows else {}
        try:
            self.toi.save_candle({"day": self.day, "start": ind["candle"]["time"], **{k: ind["candle"][k] for k in ("open", "high", "low", "close")},
                                  "supertrend": ind["st"]["value"] if ind["st"] else None, "st_up": ind["st"]["up"] if ind["st"] else None,
                                  "vwap": ind["vwap"], "vwap_future": ind["vwapFuture"], "basis": ind["basis"], "rsi": ind["rsi"],
                                  "toi_strength": last_row.get("strengthPct"), "toi_sentiment": last_row.get("sentiment"),
                                  "no_trade": self.state.get("noTrade")})
        except Exception as e:
            self._error("candle store", e)

    def _delta_lot(self, strike, side):
        try:
            ch = self.data.chain(self.expiry)
            leg = (ch["oc"].get(float(strike)) or {}).get(side.lower()) or {}
            d = (leg.get("greeks") or {}).get("delta")
            return (abs(float(d)) if d else None), ch.get("lotSize")
        except Exception:
            return None, None

    # ------------------------------------------------------------ actions -> paper orders
    def _why_not(self, oc, side, market_open):
        """Liquidity of a strike from the chain (the shared liquidity rule): '' when it can trade."""
        def why(k):
            leg = (oc.get(float(k)) or {}).get(side.lower()) or {}
            if not float(leg.get("oi") or 0) > 0 and not float(leg.get("volume") or 0) > 0:
                return "untraded"
            if not float(leg.get("volume") or 0) > 0:
                return "no trades today"
            if not float(leg.get("oi") or 0) > 0:
                return "no open interest"
            if market_open and not (float(leg.get("top_bid_price") or 0) > 0 and float(leg.get("top_ask_price") or 0) > 0):
                return "no bid / ask"
            return ""
        return why

    def _security(self, strike, side):
        for r in self.instruments.chain(cfg.SYMBOL, self.expiry):
            if r["strike"] == float(strike):
                return (r[side.lower()] or {}).get("securityId")
        return None

    def _act(self, a, now, c):
        s = self.settings()
        do = a["do"]
        if do == "enter":
            try:
                ch = self.data.chain(self.expiry)
            except Exception as e:
                return L.on_entry_failed(self.state, f"option chain unavailable ({e})")
            label, strike, note = L.choose_strike(list(ch["oc"]), a["spot"], a["side"], self._why_not(ch["oc"], a["side"], True),
                                                  tuple(s["strikeFallback"]))
            if strike is None:
                return L.on_entry_failed(self.state, note)
            sid = self._security(strike, a["side"])
            if sid is None:
                return L.on_entry_failed(self.state, f"{L.fmt(strike)} {a['side']} not in Dhan's instrument list")
            self.watch_ids[sid] = (strike, a["side"])
            self._subscribe()
            if self.mode != "paper":
                leg = (ch["oc"].get(float(strike)) or {}).get(a["side"].lower()) or {}
                return L.on_filled(self.state, strike, sid, float(leg.get("last_price") or 0), (note + "; " if note else "") + "signals only")
            order = self.broker.buy(sid, a["lots"], now, f"{SOURCE_SETUP} entry {a['side']}")
            if order["status"] != "FILLED":
                return L.on_entry_failed(self.state, f"paper order {order['status']}: {order.get('reason') or ''}")
            return L.on_filled(self.state, strike, sid, order["avg_price"], note)
        o = self.state.get("open")
        if o is None:
            return []
        sid, lot = o.get("securityId"), (self.instruments.get(o.get("securityId")) or {}).get("lotSize") or 65
        if do == "add":
            if self.mode != "paper":
                return L.on_add_filled(self.state, a["lots"], (c or {}).get("optionLtp") or o["avg"])
            order = self.broker.buy(sid, a["lots"], now, f"{SOURCE_SETUP} add ({a['kind']})")
            if order["status"] != "FILLED":
                return L.on_add_failed(self.state, f"paper order {order['status']}: {order.get('reason') or ''}")
            return L.on_add_filled(self.state, a["lots"], order["avg_price"])
        if do == "partial":
            price = (self.broker.sell(sid, a["lots"], now, f"{SOURCE_SETUP} partial {a['level']}") if self.mode == "paper"
                     else (self.broker.ltp(sid) if self.broker else o["avg"]))
            if price is None:
                return L.on_partial_failed(self.state, "no buyers in the book")
            return L.on_partial_filled(self.state, a["lots"], price, round((price - o["avg"]) * a["lots"] * lot, 2))
        if do == "exit":
            price = self.broker.exit(sid, now, f"{SOURCE_SETUP} {a['reason']}") if self.mode == "paper" else o.get("avg")
            if price is None:
                o.pop("exiting", None)  # no fill (no bid): tried again on the next tick
                self._record("error", f"Exit ({a['reason']}) not filled: no buyers in the book; retrying", side=o["side"], now=now)
                return []
            pnl = round(o.get("booked", 0.0) + (price - o["avg"]) * o["lots"] * lot, 2)
            return L.on_exited(self.state, a.get("spot"), pnl, now)
        return []

    # ------------------------------------------------------------ kill switch, summary, status
    def stop(self, exit_all=False, who=""):
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            self.state["halted"] = True
            self._record("info", ("Kill switch: stop + exit all" if exit_all else "Kill switch: no new entries or adds")
                         + (f" (by {who})" if who else ""), now=now)
            o = self.state.get("open")
            if exit_all and o and not o.get("exiting"):
                o["exiting"] = True
                self._emit([L.event("exit", f"Kill switch: exit all {o['lots']} lots", side=o["side"]),
                            L.action("exit", side=o["side"], lots=o["lots"], reason="kill switch", spot=self.spot)], now)
            self._save(now)

    def resume(self, who=""):
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            self.state["halted"] = False
            self._record("info", "Kill switch off: new entries allowed" + (f" (by {who})" if who else ""), now=now)
            self._save(now)

    def write_summary(self, now=None):
        now = now or self.clock()
        closed = self.state.get("closed", [])
        f = self.broker.engine.funds() if self.broker and self.broker.engine else {"realized": 0.0, "charges": 0.0}
        wins = sum(1 for t in closed if (t.get("pnl") or 0) > 0)
        row = {"day": self.day, "trades": self.state.get("trades", 0), "wins": wins,
               "losses": sum(1 for t in closed if (t.get("pnl") or 0) < 0),
               "adds": sum(sum((t.get("adds") or {}).values()) for t in closed), "partials": sum(t.get("partials", 0) for t in closed),
               "gross_pnl": round(f["realized"], 2), "charges": round(f["charges"], 2),
               "net_pnl": round(f["realized"] - f["charges"], 2), "updated_at": now}
        self.toi.save_summary(row)
        self._record("info", f"Daily summary: {row['trades']} trades, {wins} won, net {L.fmt(row['net_pnl'])}", now=now)
        return row

    def status(self):
        now = self.clock()
        with self.lock:
            st = self.state or {}
            funds = self.broker.funds() if self.broker and self.broker.engine else None
            return {"mode": self.mode, "asOf": now.isoformat(), "marketOpen": in_session(now) and self.trading_day(now),
                    "stale": self.stale, "halted": st.get("halted", False), "tokenExpired": bool(self.data.token_expired()),
                    "spot": self.spot, "future": self.fut, "futureLtp": self.fut_ltp, "expiry": self.expiry,
                    "state": st, "funds": funds, "settings": self.settings()}
