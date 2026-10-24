"""
algo_service.py - runs the OI breakout algo (algo_logic.py) all day for NIFTY and BANKNIFTY. PAPER TRADING ONLY.

Orders go to a PaperEngine of its own "Algo" paper account (paper_engine.py, the same simulator as the Paper Trading
page), never to Dhan: this module imports no Dhan order code (test_algo_service.py checks that).
Market data: the paper service's single Dhan feed (index ticks -> 1-minute candles; option order books), plus the
Dhan intraday candles at start (RSI warm-up, minutes missed before a restart). Filters read the tracker's Trending OI
rows, the shared option-chain cache and the stock quotes the Dashboard uses (AlgoData, built in main.py).

Every decision goes to the decision log: store (algo_events) + logs/algo-YYYY-MM-DD.log. The per-index state
(locked levels, setups, open trade, trade count, closed trades) is saved after every change, so a restart resumes it
and never enters the same signal twice.
"""
import json
import logging
import os
import threading
import time as _time
import traceback
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable

import algo_config as cfg
from algo_filters import components_verdict, oi_change_verdict, rsi
from algo_logic import fmt, hm, lock_levels, new_state, on_candle, on_tick
from candles import aggregate, bucket_start, epoch, in_session
from dhan_client import SCRIP as INDEX_IDS
from dhan_feed import to_book
from holidays import NSE_HOLIDAYS
from paper_engine import BUY, FILLED, MARKET, OrderError, PaperEngine
from sr_levels import rank_levels, side_oi
from store import IST

log = logging.getLogger("algo")
IDX, FNO = "IDX_I", "NSE_FNO"


@dataclass
class AlgoData:
    """Market data the algo reads (main.py wires it to the tracker, chain cache and quote / history caches)."""
    expiries: Callable[[str], list]  # Dhan expiries for the levels / filters, nearest first
    chain: Callable[[str, str], dict]  # -> {"spot", "oc", "lotSize"} (shared option-chain cache)
    trending: Callable[[str, str], dict | None]  # -> newest 5-minute Trending OI row, or None
    components: Callable[[str], dict]  # -> {"constituents", "quotes": {sym: ltp}, "history": {sym: daily candles}}
    intraday: Callable[[str], list]  # -> 1-minute index candles, previous session + today (Dhan intraday)
    token_expired: Callable[[], bool]


class AlgoBroker:
    """The Algo account's paper engine for the day. Every order is stored with source="algo" and its setup."""

    def __init__(self, store, instruments, clock, holidays=NSE_HOLIDAYS):
        self.store, self.instruments, self.clock, self.holidays = store, instruments, clock, holidays
        self.account = store.active_account(cfg.ACCOUNT_NAME) or store.create_account(cfg.CAPITAL, clock(),
                                                                                       name=cfg.ACCOUNT_NAME)
        self.engine, self.day, self.tags, self._unsaved = None, None, {}, []
        self.ensure_day(clock())

    def ensure_day(self, now):
        if self.day == now.date():
            return
        acc, day = self.account["id"], now.date().isoformat()
        opening = self.account["capital"] + self.store.net_before(acc, day)
        engine = PaperEngine(max(opening, 0.01), holidays=self.holidays, day=now.date())
        orders = self.store.orders(acc, day)
        engine.restore(orders, self.store.trades(acc, day))
        self.tags = {o["id"]: o.get("setup", "") for o in orders}
        self.engine, self.day = engine, now.date()

    def _save(self, events, setup=None):
        day = self.day.isoformat()
        for ev in events:
            data = dict(ev.data)
            if ev.kind == "order":
                if setup is not None and data["id"] not in self.tags:
                    self.tags[data["id"]] = setup
                data.update(source="algo", setup=self.tags.get(data["id"], ""))
            self._unsaved.append((ev.kind, day, data))
        save = {"order": self.store.save_order, "trade": self.store.save_trade, "position": self.store.save_position}
        while self._unsaved:
            kind, d, data = self._unsaved[0]
            try:
                save[kind](self.account["id"], d, data)
            except Exception as e:  # kept and retried with the next write
                log.warning("algo store write failed: %s", e)
                return
            self._unsaved.pop(0)

    def on_book(self, security_id, book, now):
        self.ensure_day(now)
        self._save(self.engine.on_tick(security_id, book, now))

    def ltp(self, security_id):
        return self.engine._ltp(security_id)

    def buy(self, security_id, lots, now, setup):
        inst = self.instruments.get(security_id)
        order, events = self.engine.place_order(security_id, BUY, lots, inst["lotSize"], MARKET, now)
        self._save(events, setup)
        return order.to_dict()

    def exit(self, security_id, now, setup):
        """Market sell of the whole open quantity. Returns the fill price."""
        events = self.engine.exit_position(security_id, now)
        self._save(events, setup)
        fills = [e.data for e in events if e.kind == "trade"]
        return fills[-1]["price"] if fills else None

    def last_sell_price(self, security_id):
        sells = [t for t in self.engine.trades if t.security_id == security_id and t.side != BUY]
        return sells[-1].price if sells else None

    def open_qty(self, security_id):
        p = self.engine.positions.get(security_id)
        return p.open_qty if p else 0

    def on_time(self, now):
        self.ensure_day(now)
        self._save(self.engine.on_time(now), "Square-off 15:15")

    def day_pnl(self):
        f = self.engine.funds()
        return round(f["realized"] - f["charges"] + self.engine.unrealized(), 2)

    def funds(self):
        f = self.engine.funds()
        f["unrealized"] = self.engine.unrealized()
        f["dayPnl"] = self.day_pnl()
        return f


class AlgoService:
    def __init__(self, store, paper, instruments, data: AlgoData, clock, mode=cfg.MODE, log_dir=cfg.LOG_DIR,
                 holidays=NSE_HOLIDAYS):
        self.store, self.paper, self.instruments, self.data, self.clock = store, paper, instruments, data, clock
        self.mode, self.log_dir, self.holidays = mode, log_dir, holidays
        self.lock = threading.RLock()
        self.broker = AlgoBroker(store, instruments, clock, holidays) if mode != "off" else None
        self.day = None
        self._started_at = None  # first timer tick inside today's session (watchdog reference before any tick)
        self.states = {}  # symbol -> algo_logic state (+ "lastCandle", "closed")
        self.minutes = {s: {} for s in cfg.SYMBOLS}  # symbol -> {minute start epoch: 1-minute candle}
        self.spot = {s: None for s in cfg.SYMBOLS}
        self.last_tick = {s: None for s in cfg.SYMBOLS}
        self.options = {}  # security id -> {"symbol", "strike", "type", "expiry", "name"} kept subscribed
        self.notes = {}  # (symbol, note) -> last value logged, so a condition is logged once when it changes
        self._file_day, self._file = None, None
        self._stop = threading.Event()
        self._thread = None
        self.watch = {}  # symbol -> {"since", "attempt", "next"} while its ticks are stale
        self.last_error = None  # (at, message) of the newest exception, shown on the page for 10 minutes
        self._errors_seen = {}  # (where, message) -> last time logged, so a repeating error is logged once a minute
        self._next_heartbeat = None
        self._last_feed_action = None  # one resubscribe / reconnect per 30 s, whichever index asks
        if paper is not None:
            paper.listeners.append(self.on_packet)
            feed = getattr(paper, "feed", None)
            if feed is not None:
                feed.on_event = self._feed_event

    # ------------------------------------------------------------ lifecycle
    def start(self):
        if self.mode == "off":
            log.info("algo is off (ALGO_MODE=off)")
            return
        self._thread = threading.Thread(target=self._run, name="algo", daemon=True)
        self._thread.start()

    def stop_thread(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(1.0):
            try:
                self.tick(self.clock())
            except Exception as e:  # never stops the loop
                self._error("timer", e)

    def trading_day(self, now):
        return now.weekday() < 5 and now.date().isoformat() not in self.holidays

    # ------------------------------------------------------------ decision log
    def _log_file(self, now):
        day = now.date().isoformat()
        if self._file_day != day:
            os.makedirs(self.log_dir, exist_ok=True)
            self._file_day, self._file = day, os.path.join(self.log_dir, f"algo-{day}.log")
        return self._file

    def record(self, symbol, kind, message, setup="", data=None, now=None, tb=None):
        now = now or self.clock()
        st = self.states.get(symbol) or {}
        data = {**(data or {}), "spot": self.spot.get(symbol), "levels": st.get("levels"), "mode": self.mode}
        ev = {"at": now.isoformat(timespec="seconds"), "symbol": symbol, "setup": setup, "kind": kind,
              "message": message, "data": data}
        line = f"{now:%H:%M:%S} {symbol:<9} {kind.upper():<7} {('[' + setup + '] ') if setup else ''}{message}"
        try:
            with open(self._log_file(now), "a", encoding="utf-8") as f:
                f.write(line + " | " + json.dumps(data, default=str) + "\n")
                if tb:  # the full traceback under the line, indented
                    f.write("".join("    " + x + "\n" for x in tb.rstrip().splitlines()))
        except Exception as e:
            log.warning("algo log file: %s", e)
        try:
            self.store.algo_add_event(now.date().isoformat(), ev)
        except Exception as e:
            log.warning("algo event not stored: %s", e)
        log.info(line)
        return ev

    def _error(self, where, exc, symbol="*"):
        """Logs an exception with its traceback (decision log + file) and keeps going. The same error repeating
        is logged once a minute; the page shows the newest one for 10 minutes."""
        now = self.clock()
        msg = f"{where}: {exc.__class__.__name__}: {exc}"
        self.last_error = (now, msg)
        key = (where, str(exc))
        last = self._errors_seen.get(key)
        if last and (now - last).total_seconds() < 60:
            return
        self._errors_seen[key] = now
        log.error("algo %s", msg, exc_info=exc)
        try:
            self.record(symbol, "error", msg, data={"where": where},
                        tb="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)), now=now)
        except Exception:
            log.exception("algo error could not be recorded")

    def _feed_event(self, level, message):
        """Disconnects, stale feed and reconnect attempts from dhan_feed.py, into the decision log."""
        try:
            self.record("*", "feed", message)
        except Exception:
            log.exception("feed event not recorded")

    def _note(self, symbol, key, value, kind="info", now=None):
        """Logs a condition once each time it changes (stale data, token, day loss...)."""
        if self.notes.get((symbol, key)) == value:
            return
        self.notes[(symbol, key)] = value
        if value:
            self.record(symbol, kind, value, now=now)

    def _save_state(self, symbol):
        try:
            self.store.algo_save_state(self.day.isoformat(), symbol, self.states[symbol])
        except Exception as e:
            log.warning("algo state not saved: %s", e)

    # ------------------------------------------------------------ day / restore
    def _ensure_day(self, now):
        if self.day == now.date():
            return
        self.day = now.date()
        saved = {}
        try:
            saved = self.store.algo_states(self.day.isoformat())
        except Exception as e:
            log.warning("algo state not loaded: %s", e)
        self.states = {}
        for sym in cfg.SYMBOLS:
            st = saved.get(sym) or new_state(sym, self.day.isoformat())
            st.setdefault("lastCandle", None)
            st.setdefault("closed", [])
            self.states[sym] = st
        self.minutes = {s: {} for s in cfg.SYMBOLS}
        self.notes = {}
        if saved:
            self.record("*", "info", f"Restarted: resumed today's state ({', '.join(f'{s} {st['trades']} trades' for s, st in self.states.items())})", now=now)
            self._reconcile(now)
        else:
            self.record("*", "info", f"Algo started for {self.day} in {self.mode.upper()} mode, rule variant "
                                     f"{cfg.RULE_VARIANT}", now=now)
        self._warm(now)

    def _reconcile(self, now):
        """After a restart: an open trade the account no longer holds (or never got) is closed in the state."""
        if self.mode != "paper":
            return
        for sym, st in self.states.items():
            o = st["open"]
            if not o:
                continue
            o.pop("exiting", None)
            sid = o.get("securityId")
            if not sid or self.broker.open_qty(sid) <= 0:
                self.record(sym, "error", "Open trade from before the restart has no position in the Algo account; "
                                          "closed in the log, nothing re-entered", setup=o["setup"], now=now)
                st["open"] = None
                self._save_state(sym)

    def _warm(self, now):
        """1-minute candles from Dhan intraday: RSI history and any minutes missed before a restart."""
        for sym in cfg.SYMBOLS:
            try:
                for c in self.data.intraday(sym):
                    self.minutes[sym].setdefault(c["time"], {k: c[k] for k in ("time", "open", "high", "low", "close")})
            except Exception as e:
                self._note(sym, "warm", f"Intraday candles unavailable (RSI may be short): {e}", kind="error", now=now)
            try:
                self.data.components(sym)  # starts loading the stocks' previous closes, so the verdict is ready by 09:35
            except Exception as e:
                self._note(sym, "warmc", f"Index components unavailable for now: {e}", kind="error", now=now)

    # ------------------------------------------------------------ market data
    def on_packet(self, pkt, now):
        try:
            self._on_packet(pkt, now)
        except Exception as e:  # never breaks the feed
            self._error("tick handler", e)

    def _on_packet(self, pkt, now):
        if self.mode == "off" or pkt.get("kind") not in ("full", "ticker", "quote"):
            return
        seg, sid, ltp = pkt.get("segment"), pkt.get("security_id"), pkt.get("ltp")
        with self.lock:
            if seg == IDX:
                sym = next((s for s, i in INDEX_IDS.items() if i == sid and s in cfg.SYMBOLS), None)
                if sym and ltp and in_session(now):
                    self._minute(sym, ltp, now)
                    self.spot[sym], self.last_tick[sym] = ltp, now
                    self._ticks(sym, now)
            elif seg == FNO and pkt["kind"] == "full" and self.broker is not None:
                self.broker.on_book(sid, to_book(pkt), now)
                for sym, st in self.states.items():
                    if st["open"] and st["open"].get("securityId") == sid:
                        self._ticks(sym, now)

    def _minute(self, sym, ltp, now):
        t = epoch(bucket_start(now, 1))
        c = self.minutes[sym].get(t)
        if c is None:
            self.minutes[sym][t] = {"time": t, "open": ltp, "high": ltp, "low": ltp, "close": ltp}
        else:
            c["high"], c["low"], c["close"] = max(c["high"], ltp), min(c["low"], ltp), ltp

    def option_ltp(self, sym):
        o = self.states.get(sym, {}).get("open")
        if not o or not o.get("securityId") or self.broker is None:
            return None
        return self.broker.ltp(o["securityId"])

    def _ticks(self, sym, now):
        st = self.states.get(sym)
        if not st or not st["open"]:
            return
        o = st["open"]
        if o.get("staleExit") and not o.get("exiting"):
            o["exiting"] = True
            self._exit(sym, "Data was stale for more than 5 minutes with the position open: exit when data returned", now)
            return
        act = on_tick(st, self.spot[sym], self.option_ltp(sym))
        if act:
            self._exit(sym, act["reason"], now)

    # ------------------------------------------------------------ timer
    def tick(self, now):
        """Once a second. Network calls (levels, filters) run outside the lock: the feed thread needs it for
        every tick, so it must never wait on Dhan. Each index is guarded separately."""
        if self.mode == "off" or not self.trading_day(now):
            return
        with self.lock:
            self._ensure_day(now)
            if self.broker:
                self.broker.ensure_day(now)
            try:
                self._subscriptions()
            except Exception as e:
                self._error("subscriptions", e)
            self._heartbeat(now)
        work = []
        for sym in cfg.SYMBOLS:
            try:
                with self.lock:
                    self._watch(sym, now)
                    need = self._index_tick(sym, now)
                if need == "levels":
                    self._lock_levels(sym, now)
                elif need:
                    work.append((sym, need))
            except Exception as e:
                self._error(f"{sym} timer", e, sym)
        for sym, end in work:
            try:
                with self.lock:
                    r = self.rsi_now(sym, end)
                f = self.filters(sym, end, now, r)
                with self.lock:
                    self._close_candle(sym, end, now, f)
            except Exception as e:
                self._error(f"{sym} candle evaluation", e, sym)
        if self.broker and now.time() >= cfg.SQUARE_OFF:
            with self.lock:
                self.broker.on_time(now)

    def in_session(self, now):
        return self.trading_day(now) and cfg.SESSION_FROM <= now.time() < cfg.SESSION_TO

    def _watch(self, sym, now):
        """Watchdog per index: no tick for 2 minutes in the session -> "Feed stale" in the log, then resubscribe /
        reconnect with backoff (every attempt logged); "Feed back" when ticks return."""
        w = self.watch.get(sym)
        last = self.last_tick[sym]
        if not self.in_session(now):
            return
        start = datetime.combine(now.date(), cfg.SESSION_FROM, tzinfo=now.tzinfo)
        ref = last if last and last >= start else max(start, self._started_at or start)
        age = (now - ref).total_seconds()
        if age <= cfg.STALE_NO_ENTRY_SEC:
            if w:
                gap = int((now - w["since"]).total_seconds())
                self.record(sym, "feed", f"Feed back: {sym} ticks resumed after {gap // 60} min {gap % 60} s "
                                         f"(no ticks {w['since']:%H:%M:%S}-{now:%H:%M:%S})", now=now)
                self.watch.pop(sym, None)
            return
        feed = getattr(self.paper, "feed", None)
        fs = getattr(feed, "status", {}) or {}
        if not w:
            w = self.watch[sym] = {"since": ref, "attempt": 0, "next": now}
            pkt_age = _time.time() - fs["lastPacketAt"] if fs.get("lastPacketAt") else None
            self.record(sym, "stale", f"Feed stale: no {sym} tick for {age:.0f} s (last tick "
                                      f"{f'{last:%H:%M:%S}, spot {fmt(self.spot[sym])}' if last else 'none today'}); "
                                      f"feed {'connected' if fs.get('connected') else 'NOT connected'}, any packet "
                                      f"{'never' if pkt_age is None else f'{pkt_age:.0f} s ago'}", now=now)
        if feed is None or now < w["next"]:
            return
        w["attempt"] += 1
        n = w["attempt"]
        delay = cfg.STALE_RETRY_SEC[min(n - 1, len(cfg.STALE_RETRY_SEC) - 1)]
        w["next"] = now + timedelta(seconds=delay)
        if self._last_feed_action and (now - self._last_feed_action).total_seconds() < 30:
            self.record(sym, "feed", f"Reconnect attempt {n} for {sym}: feed already reset at "
                                     f"{self._last_feed_action:%H:%M:%S}; next try in {delay} s if still stale", now=now)
            return
        self._last_feed_action = now
        if n % 2 and fs.get("connected") and hasattr(feed, "resubscribe"):
            feed.resubscribe()
            action = "resubscribed every instrument"
        elif hasattr(feed, "reconnect"):
            feed.reconnect(f"no {sym} tick for {age:.0f} s")
            action = "reconnecting the feed"
        else:
            action = "no reconnect available"
        self.record(sym, "feed", f"Reconnect attempt {n} for {sym}: {action}; next try in {delay} s if still stale",
                    now=now)

    def _heartbeat(self, now):
        """Every 15 minutes in the session: last tick time and spot per index, feed state."""
        if not self.in_session(now):
            return
        if self._started_at is None:
            self._started_at = now
        if self._next_heartbeat and now < self._next_heartbeat:
            return
        step = cfg.HEARTBEAT_MIN * 60
        open_ = datetime.combine(now.date(), cfg.SESSION_FROM, tzinfo=now.tzinfo)
        self._next_heartbeat = open_ + timedelta(seconds=((now - open_).total_seconds() // step + 1) * step)
        fs = getattr(getattr(self.paper, "feed", None), "status", {}) or {}
        parts = [f"{s} last tick {self.last_tick[s]:%H:%M:%S} spot {fmt(self.spot[s])}" if self.last_tick[s]
                 else f"{s} no tick yet" for s in cfg.SYMBOLS]
        feed = (f"feed {'connected' if fs.get('connected') else 'NOT connected'}, {fs.get('reconnects', 0)} reconnects"
                if fs else "feed status unknown")
        self.record("*", "heartbeat", f"Heartbeat: {' · '.join(parts)} · {feed}", now=now)

    def health(self, now):
        """What the page's status dot shows: ok / stale / error with the reason."""
        if self.mode == "off":
            return {"state": "off", "reason": "ALGO_MODE=off"}
        if self.data.token_expired():
            return {"state": "error", "reason": "Dhan token expired: no new entries. Send a new one with POST /api/token"}
        if self.last_error and (now - self.last_error[0]).total_seconds() < 600:
            return {"state": "error", "reason": f"{self.last_error[1]} (at {self.last_error[0]:%H:%M:%S})"}
        if self.in_session(now):
            fs = getattr(getattr(self.paper, "feed", None), "status", {}) or {}
            if fs and not fs.get("connected"):
                return {"state": "error", "reason": f"Feed disconnected: {fs.get('lastError') or 'reconnecting'}"}
            stale = [f"no {s} tick since {w['since']:%H:%M:%S}" for s, w in self.watch.items()]
            if stale:
                return {"state": "stale", "reason": "Feed stale: " + "; ".join(stale)}
        return {"state": "ok", "reason": ""}

    def _subscriptions(self):
        if self.paper is None:
            return
        keys = {(IDX, INDEX_IDS[s]) for s in cfg.SYMBOLS}
        for sym in cfg.SYMBOLS:
            for sid in self._atm_options(sym):
                keys.add((FNO, sid))
            o = self.states[sym]["open"]
            if o and o.get("securityId"):
                keys.add((FNO, o["securityId"]))
        self.paper.set_feed_keys("algo", keys)

    def trade_expiry(self, sym, today):
        """Nearest expiry; the next one on expiry day."""
        exps = [e for e in self.instruments.expiries(sym, today.isoformat()) if e >= today.isoformat()]
        if not exps:
            return None
        return exps[1] if exps[0] == today.isoformat() and len(exps) > 1 else exps[0]

    def _atm_options(self, sym, spot=None):
        """Security ids of the ATM +/- N strikes (CE and PE) for the trade expiry, kept subscribed."""
        spot = spot or self.spot[sym]
        if not spot:
            return []
        try:
            exp = self.trade_expiry(sym, self.day)
            rows = self.instruments.chain(sym, exp) if exp else []
        except Exception as e:
            self._note(sym, "instruments", f"Option list unavailable: {e}", kind="error")
            return []
        if not rows:
            return []
        rows = sorted(rows, key=lambda r: abs(r["strike"] - spot))[: 1 + 2 * cfg.ATM_STRIKES_EACH_SIDE]
        out = []
        for r in rows:
            for typ in ("ce", "pe"):
                if r.get(typ):
                    sid = r[typ]["securityId"]
                    self.options[sid] = {"symbol": sym, "strike": r["strike"], "type": typ.upper(), "expiry": exp,
                                         "name": r[typ].get("name", str(sid))}
                    out.append(sid)
        return out

    def _block(self, sym, now):
        """The runner's reasons for no new entries (logged once when they change)."""
        reasons = []
        if self.data.token_expired():
            reasons.append("Dhan token expired: send a new one with POST /api/token")
        last = self.last_tick[sym]
        age = (now - last).total_seconds() if last else None
        if age is None or age > cfg.STALE_NO_ENTRY_SEC:
            reasons.append(f"spot data stale ({'no tick yet' if age is None else f'{age:.0f} s old'})")
        if self.broker and self.broker.day_pnl() <= -cfg.CAPITAL * cfg.DAY_LOSS_STOP_PCT / 100:
            reasons.append(f"day loss limit reached (P&L {self.broker.day_pnl():,.2f} <= -{cfg.DAY_LOSS_STOP_PCT:g}% of capital)")
        text = "; ".join(reasons)
        self._note(sym, "block", f"New entries paused: {text}" if text else "", now=now)
        if not text and self.notes.get((sym, "blockWas")):
            self.record(sym, "info", "New entries allowed again", now=now)
        self.notes[(sym, "blockWas")] = bool(text)
        return text

    def _index_tick(self, sym, now):
        """Stale exit, 15:15, and what needs the network next: "levels" or the end of a candle to evaluate."""
        st = self.states[sym]
        # stale data with an open position: exit as soon as data returns
        o = st["open"]
        last = self.last_tick[sym]
        if o and last and (now - last).total_seconds() > cfg.STALE_EXIT_SEC and not o.get("staleExit"):
            o["staleExit"] = True
            self.record(sym, "error", f"Spot data stale > {cfg.STALE_EXIT_SEC // 60} min with a position open: "
                                      "will exit at market when data returns", setup=o["setup"], now=now)
            self._save_state(sym)
        # 15:15 square-off
        if o and not o.get("exiting") and now.time() >= cfg.SQUARE_OFF:
            o["exiting"] = True
            self._exit(sym, f"Square-off {cfg.SQUARE_OFF:%H:%M}", now)
        # levels at 09:30
        if st["levels"] is None and now.time() >= cfg.LEVELS_AT:
            if not st.get("levelsRetryAt") or now.isoformat() >= st["levelsRetryAt"]:
                return "levels"
            return None
        # closed 5-minute candles (evaluated 10 s after the close, after the tracker's hh:mm:03 poll): only candles
        # that close inside the session and open at or after the 09:30 level lock
        end = self._last_closed_end(now - timedelta(seconds=10))
        if not end or st["lastCandle"] == end.isoformat() or not st["levels"]:
            return None
        start = end - timedelta(minutes=cfg.CANDLE_MIN)
        if start.time() < cfg.LEVELS_AT or end.time() > cfg.SESSION_TO:
            st["lastCandle"] = end.isoformat()  # used for RSI only
            return None
        return end

    @staticmethod
    def _last_closed_end(t):
        """End of the newest 5-minute bucket that has closed by t (09:15-aligned), inside the session."""
        if t.time() < datetime.strptime("09:20", "%H:%M").time():
            return None
        session_close = t.replace(hour=15, minute=30, second=0, microsecond=0)
        t = min(t, session_close)
        open_ = t.replace(hour=9, minute=15, second=0, microsecond=0)
        n = int((t - open_).total_seconds() // (cfg.CANDLE_MIN * 60))
        return open_ + timedelta(minutes=n * cfg.CANDLE_MIN)

    def _lock_levels(self, sym, now):
        """Fetches the chain (outside the lock) and locks the levels."""
        st = self.states[sym]
        try:
            exp = self.data.expiries(sym)[0]
            ch = self.data.chain(sym, exp)
            spot = ch["spot"]
            levels = {}
            for side in ("R", "S"):
                for i, (k, _) in enumerate(rank_levels(side_oi(ch["oc"], side), spot, side, cfg.LEVEL_RANGE), 1):
                    levels[f"{side}{i}"] = k
        except Exception as e:
            st["levelsRetryAt"] = (now + timedelta(seconds=30)).isoformat()
            self._note(sym, "levels", f"Could not lock levels yet (retrying every 30 s): {e}", kind="error", now=now)
            return
        late = "" if now.time() < (datetime.combine(now.date(), cfg.LEVELS_AT) + timedelta(minutes=2)).time() \
            else f" (late: backend started after {cfg.LEVELS_AT:%H:%M})"
        with self.lock:
            if st["levels"] is not None:
                return
            for ev in lock_levels(st, levels, now):
                self.record(sym, "levels", ev["message"] + f" · expiry {exp} · spot {fmt(spot)}{late}",
                            data={"expiry": exp, "chainSpot": spot}, now=now)
            st.pop("levelsRetryAt", None)
            self._save_state(sym)

    def candle5(self, sym, end):
        start = end - timedelta(minutes=cfg.CANDLE_MIN)
        mins = [c for t, c in sorted(self.minutes[sym].items()) if epoch(start) <= t < epoch(end)]
        if not mins:
            return None
        return {"time": epoch(start), "open": mins[0]["open"], "high": max(c["high"] for c in mins),
                "low": min(c["low"] for c in mins), "close": mins[-1]["close"], "minutes": len(mins)}

    def rsi_now(self, sym, end):
        """RSI(14) of the 5-minute closes up to the candle ending at `end` (previous session included)."""
        five = [c for c in aggregate([self.minutes[sym][t] for t in sorted(self.minutes[sym])], cfg.CANDLE_MIN)
                if c["time"] < epoch(end)]
        vals = rsi([c["close"] for c in five], cfg.RSI_PERIOD)
        return vals[-1] if vals else None

    def filters(self, sym, end, now, rsi_value=None):
        """Filter values at a candle close (network: call without the lock)."""
        f = {"toi": None, "oiChange": None, "components": None, "rsi": rsi_value}
        try:
            exp = self.data.expiries(sym)[0]
        except Exception as e:
            return {**f, "error": f"expiries: {e}"}
        try:
            row = self.data.trending(sym, exp)
            if row:
                age = (now - datetime.fromisoformat(row["ts"].replace(" ", "T")).replace(tzinfo=IST)).total_seconds() / 60
                if age <= cfg.TOI_MAX_AGE_MIN:
                    f["toi"] = {"sentiment": row["sentiment"], "strength": row["strengthPct"], "ts": row["ts"]}
        except Exception as e:
            f["toiError"] = str(e)
        try:
            ch = self.data.chain(sym, exp)
            f["oiChange"] = oi_change_verdict(sym, ch["spot"], ch["oc"], ch.get("lotSize", 1))
        except Exception as e:
            f["oiChangeError"] = str(e)
        try:
            c = self.data.components(sym)
            f["components"] = components_verdict(c["constituents"], c["quotes"], c["history"], now,
                                                  cfg.COMPONENTS_NEUTRAL_BAND)
        except Exception as e:
            f["componentsError"] = str(e)
        return f

    def _close_candle(self, sym, end, now, f):
        st = self.states[sym]
        if st["lastCandle"] == end.isoformat():
            return
        st["lastCandle"] = end.isoformat()
        c = self.candle5(sym, end)
        if c is None:
            self.record(sym, "stale", f"No ticks for the {hm(end)} candle: nothing evaluated", now=now)
            self._save_state(sym)
            return
        block = self._block(sym, now) if self.mode != "off" else ""
        actions = on_candle(st, c, end, f, block)
        self.record(sym, "candle", f"{hm(end)} candle O {fmt(c['open'])} H {fmt(c['high'])} L {fmt(c['low'])} "
                                   f"C {fmt(c['close'])} · RSI {fmt(round(f['rsi'], 1)) if f['rsi'] is not None else '-'}",
                    data={"candle": c, "filters": f}, now=now)
        self._save_state(sym)  # before any order: a restart can never repeat this candle's entry
        for a in actions:
            if a["type"] == "event":
                name = a["data"].pop("setupName", "") or (st["setup"]["name"] if st["setup"] and a["kind"] == "armed" else "")
                self.record(sym, a["kind"], a["message"], setup=name, data={**a["data"], "filters": f}, now=now)
            elif a["type"] == "enter":
                self._enter(sym, a, f, now)
            elif a["type"] == "exit":
                self._exit(sym, a["reason"], now)
        self._save_state(sym)

    # ------------------------------------------------------------ orders (paper engine only)
    def _enter(self, sym, a, f, now):
        st = self.states[sym]
        o = st["open"]
        spot = self.spot[sym] or o["entrySpot"]
        sids = self._atm_options(sym, spot)
        pick = sorted((self.options[s] | {"securityId": s} for s in sids if self.options[s]["type"] == a["side"]),
                      key=lambda x: abs(x["strike"] - spot))
        if not pick:
            self.record(sym, "error", f"{a['setup']}: no {a['side']} option found near {fmt(spot)}; entry dropped",
                        setup=a["setup"], now=now)
            st["open"], st["trades"] = None, st["trades"] - 1
            return
        opt = pick[0]
        o.update(securityId=opt["securityId"], option=opt["name"], strike=opt["strike"], expiry=opt["expiry"],
                 entryAt=now.strftime("%H:%M:%S"), entrySpotLive=spot)
        if self.mode == "paper":
            try:
                order = self.broker.buy(opt["securityId"], cfg.LOTS, now, a["setup"])
            except (OrderError, ValueError) as e:
                order = {"status": "REJECTED", "reason": str(e)}
            if order["status"] != FILLED:
                self.record(sym, "error", f"{a['setup']}: paper BUY {opt['name']} not filled ({order['status']}: "
                                          f"{order.get('reason', '')}); entry dropped", setup=a["setup"], now=now)
                st["open"], st["trades"] = None, st["trades"] - 1
                return
            o.update(entryPrice=order["avg_price"], orderId=order["id"], qty=order["qty"])
        else:
            inst = self.instruments.get(opt["securityId"]) or {}
            o.update(entryPrice=self.broker.ltp(opt["securityId"]) if self.broker else None,
                     qty=cfg.LOTS * inst.get("lotSize", 0) or None)  # signals: would-be quantity for the P&L
        self.record(sym, "entry", f"{'BUY' if self.mode == 'paper' else 'SIGNAL BUY'} {opt['name']} @ "
                                  f"{fmt(o['entryPrice'])} · spot {fmt(spot)} · target {fmt(o['target'])} · "
                                  f"stop: spot {a['data']['spotStop']} or premium -{cfg.PREMIUM_STOP_PCT:g}%. "
                                  f"Why: {a['reason']}", setup=a["setup"], data={**a["data"], "filters": f,
                                                                                  "option": opt, "order": o.get("orderId")},
                    now=now)
        self._save_state(sym)

    def _exit(self, sym, reason, now):
        st = self.states[sym]
        o = st["open"]
        if not o:
            return
        price = self.option_ltp(sym)
        if self.mode == "paper" and o.get("securityId"):
            sid = o["securityId"]
            if self.broker.open_qty(sid) > 0:
                try:
                    if now.time() >= cfg.SQUARE_OFF:  # the engine takes no new orders now: its own square-off sells
                        self.broker.on_time(now)
                    else:
                        self.broker.exit(sid, now, o["setup"])
                except OrderError as e:
                    o.pop("exiting", None)  # tried again on the next tick / candle
                    self._note(sym, "exitfail", f"{o['setup']}: exit not filled yet ({e}); retrying", kind="error", now=now)
                    return
            price = self.broker.last_sell_price(sid) or price
        qty = o.get("qty") or 0
        pnl = round((price - o["entryPrice"]) * qty, 2) if price is not None and o.get("entryPrice") and qty else None
        trade = {k: o.get(k) for k in ("setup", "side", "option", "strike", "expiry", "entryAt", "entrySpot",
                                       "entrySpotLive", "entryPrice", "target", "stop", "reason", "qty", "orderId")}
        trade.update(exitAt=now.strftime("%H:%M:%S"), exitSpot=self.spot[sym], exitPrice=price, exitReason=reason,
                     pnl=pnl)
        st["closed"].append(trade)
        st["open"] = None
        self.notes.pop((sym, "exitfail"), None)
        self.record(sym, "exit", f"{'SELL' if self.mode == 'paper' else 'SIGNAL SELL'} {o.get('option')} @ {fmt(price)} · "
                                 f"spot {fmt(self.spot[sym])} · P&L {fmt(pnl)}. Why: {reason}",
                    setup=o["setup"], data={"trade": trade}, now=now)
        self._save_state(sym)

    # ------------------------------------------------------------ kill switch
    def stop(self, exit_all=False):
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            for sym, st in self.states.items():
                st["stopped"] = True
                st["setup"] = None
                self._save_state(sym)
            self.record("*", "info", "Kill switch: no new entries" + (" and exit all positions" if exit_all else ""),
                        now=now)
            if exit_all:
                for sym, st in self.states.items():
                    if st["open"] and not st["open"].get("exiting"):
                        st["open"]["exiting"] = True
                        self._exit(sym, "Kill switch: stop and exit all", now)

    def resume(self):
        now = self.clock()
        with self.lock:
            self._ensure_day(now)
            for sym, st in self.states.items():
                st["stopped"] = False
                self._save_state(sym)
            self.record("*", "info", "Resumed: new entries allowed", now=now)

    # ------------------------------------------------------------ status
    def status(self):
        now = self.clock()
        with self.lock:
            if self.mode != "off" and self.trading_day(now):
                self._ensure_day(now)
            out = []
            for sym in cfg.SYMBOLS:
                st = self.states.get(sym) or new_state(sym, now.date().isoformat())
                o = st.get("open")
                live = None
                if o:
                    ltp = self.option_ltp(sym)
                    live = {**o, "ltp": ltp, "pnl": round((ltp - o["entryPrice"]) * o["qty"], 2)
                            if ltp is not None and o.get("entryPrice") and o.get("qty") else None}
                last = self.last_tick[sym]
                out.append({
                    "symbol": sym, "levels": st.get("levels"), "levelsAt": st.get("levelsAt"), "trades": st.get("trades", 0),
                    "maxTrades": cfg.MAX_TRADES_PER_INDEX, "stopped": st.get("stopped", False),
                    "setup": st.get("setup") or next(iter(st.get("setups", {}).values()), None),
                    "setups": list(st.get("setups", {}).values()) or ([st["setup"]] if st.get("setup") else []),
                    "open": live, "closed": st.get("closed", []), "lastCandle": st.get("lastCandle"),
                    "spot": self.spot[sym], "dataAgeSec": round((now - last).total_seconds()) if last else None,
                    "state": self._state_label(st, now),
                    "blocked": self.notes.get((sym, "block")) or "",
                })
            return {"meta": {"mode": self.mode, "variant": cfg.RULE_VARIANT, "asOf": now.strftime("%Y-%m-%d %H:%M:%S"),
                             "tokenExpired": self.data.token_expired(), "tradingDay": self.trading_day(now), "health": self.health(now),
                             "account": self.broker.account if self.broker else None,
                             "funds": self.broker.funds() if self.broker else None,
                             "entryWindow": f"{cfg.ENTRY_FROM:%H:%M}-{cfg.ENTRY_TO:%H:%M}",
                             "squareOff": f"{cfg.SQUARE_OFF:%H:%M}", "levelsAt": f"{cfg.LEVELS_AT:%H:%M}",
                             "config": {"buffer": cfg.BUFFER, "premiumStopPct": cfg.PREMIUM_STOP_PCT,
                                        "maxTradesPerIndex": cfg.MAX_TRADES_PER_INDEX,
                                        "dayLossStopPct": cfg.DAY_LOSS_STOP_PCT, "toiStrengthMin": cfg.TOI_STRENGTH_MIN,
                                        "pullbackCandles": cfg.PULLBACK_CANDLES}},
                    "indices": out}

    @staticmethod
    def _state_label(st, now):
        if st.get("stopped"):
            return "stopped"
        if st.get("open"):
            return "in trade"
        if st.get("setup"):
            return f"{st['setup']['name']} armed ({st['setup']['count']}/{cfg.PULLBACK_CANDLES})"
        if st.get("setups"):
            return ", ".join(s["name"] for s in st["setups"].values()) + " armed"
        if not st.get("levels"):
            return f"waiting for {cfg.LEVELS_AT:%H:%M} levels"
        if now.time() >= cfg.ENTRY_TO:
            return "entry window over"
        return "watching"

    def events(self, day=None):
        return self.day_log(day)["rows"]

    def day_log(self, day=None):
        """Decision log (newest first) and closed trades of one IST day. Days missing from the store in use (e.g. a
        day run with Postgres, viewed from a JSON-store run) are read back from that day's log file."""
        day = day or self.clock().date().isoformat()
        rows = self.store.algo_events(day)
        source = "store"
        if not rows:
            rows = parse_log_file(os.path.join(self.log_dir, f"algo-{day}.log"), day)
            source = "log file" if rows else "none"
        trades = []
        try:
            states = self.store.algo_states(day) if source == "store" else {}
        except Exception:
            states = {}
        for sym, st in sorted(states.items()):
            trades += [{**t, "symbol": sym} for t in st.get("closed", [])]
        if not trades:  # from the exit lines (each carries its trade)
            trades = [{**e["data"]["trade"], "symbol": e["symbol"]} for e in rows
                      if e["kind"] == "exit" and isinstance(e.get("data", {}).get("trade"), dict)]
        trades.sort(key=lambda t: t.get("entryAt") or "")
        return {"date": day, "source": source, "rows": list(reversed(rows)), "trades": trades}


def parse_log_file(path, day):
    """logs/algo-YYYY-MM-DD.log -> decision-log rows (oldest first), the same shape as the store's.
    Line: "HH:MM:SS SYMBOL KIND [setup] message | {json}"; indented lines below a row are its traceback."""
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("    ") and rows:
                d = rows[-1]["data"]
                d["traceback"] = (d.get("traceback", "") + line[4:] + "\n")
                continue
            head, sep, js = line.partition(" | ")
            parts = head.split(None, 3)
            if len(parts) < 4 or len(parts[0]) != 8:
                continue
            t, sym, kind, rest = parts
            setup = ""
            if rest.startswith("[") and "] " in rest:
                setup, rest = rest[1:].split("] ", 1)
            try:
                data = json.loads(js) if sep else {}
            except ValueError:
                data = {}
            rows.append({"at": f"{day}T{t}+05:30", "symbol": sym, "setup": setup, "kind": kind.lower(),
                         "message": rest, "data": data})
    return rows

