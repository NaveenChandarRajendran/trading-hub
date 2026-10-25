"""
sig_service.py - the signal watcher (brief Part 3, Step 1) and its API.

Every 5 minutes during the session (35 s after each 5-minute candle closes, so Dhan's candles and the tracker's
hh:mm:03 snapshot are in) both rules are evaluated for NIFTY and BANKNIFTY:
- one snapshot row per index goes to <logDir>/snapshots_YYYY-MM-DD.csv, GO or NO GO, so skips can be reviewed;
  another row is written on every order;
- a GO goes to the auto paper trader (autopaper.py), which trades only when Auto is ON; a NO GO waits. There are no
  notifications for GO / NO GO.
- Alerts are only about the program itself: the watcher crashed, a data feed or API call failed twice in a row, the
  MegaBull key is older than 25 days, a daily limit was hit; plus ONE end-of-day summary at 15:31.

Endpoints:
    GET  /api/signals/state?symbol=NIFTY     everything the dashboard's rule cards, OI section and paper card show
    GET  /api/signals/snapshots.csv?date=    the day's snapshot log (Download CSV)
    POST /api/autopaper/auto      {"on": true}
    POST /api/autopaper/bracket   {"securityId": 12345}   stop + target on a hand-bought Trading Hub paper position
    POST /api/autopaper/exit      {"tradeId": "..."}
"""
import csv
import json
import logging
import os
import threading
import time
from collections import Counter
from datetime import datetime, timedelta

from fastapi import HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from chain_cache import chain_response
from dhan_client import INDIA_VIX
from sig_indicators import IST
from sig_market import build_state
from sig_oi import trending_view, votes
from sig_rules import PASS, dharani_v2_rule, megabull_rule, trading_hub_rule

log = logging.getLogger("signals")
SYMBOLS = ("NIFTY", "BANKNIFTY")
SESSION = ((9, 15), (15, 30))
ON_DEMAND_TTL = 60  # seconds: the dashboard's own evaluation between watcher runs (no trading)
VIX_TTL = 30
HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT_FIELDS = [
    "time", "event", "index", "signal_candle", "spot", "open", "high", "low", "close", "volume",
    "rsi14", "ema20", "vwap", "supertrend", "supertrend_dir", "bb_basis", "bb_upper", "bb_lower",
    "prev_high", "prev_low", "prev_close", "pivot", "today_high", "today_low", "vix", "pcr",
    "toi_time", "toi_strength", "toi_strength_2", "toi_strength_3", "toi_call_chg", "toi_put_chg", "toi_diff",
    "toi_direction_pct", "toi_net_pcr", "toi_sentiment", "toi_day_hl_break", "toi_call_ltp_chg", "toi_put_ltp_chg",
    "toi_put_ltp", "toi_oi_hl_break",
    "dhan_oi_verdict", "dhan_oi_average", "sensibull_verdict", "sensibull_average", "oi_agreement",
    "oi_r1", "oi_s1", "biggest_call_wall", "biggest_put_wall",
    "th_side", "th_go", "th_grade", "th_blocked", "th_checks", "mb_setup", "mb_side", "mb_go", "mb_blocked", "mb_checks",
    "d2_side", "d2_go", "d2_score", "d2_blocked", "d2_checks",
    "est_delta", "est_cumulative_delta", "dext_typed", "dext_match",
    "auto", "action", "note",
]


def load_config(path=os.path.join(HERE, "autopaper.json")):
    cfg = json.load(open(path, encoding="utf-8"))
    local = os.path.join(HERE, "autopaper.local.json")  # optional, not committed
    if os.path.exists(local):
        for k, v in json.load(open(local, encoding="utf-8")).items():
            cfg[k] = {**cfg[k], **v} if isinstance(v, dict) and isinstance(cfg.get(k), dict) else v
    for k in ("logDir",):
        p = os.path.expanduser(cfg[k])
        cfg[k] = p if os.path.isabs(p) else os.path.normpath(os.path.join(HERE, p))
    return cfg


def _r(x, d=2):
    return None if x is None else round(x, d)


def agreement(oi, sb):
    if not oi or not sb:
        return None
    return "Agree" if oi["verdict"] == sb["verdict"] else "Mixed"


class MarketSources:
    """What build_state reads, from the backend's existing caches (no extra Dhan load apart from one VIX call / 30 s)."""

    def __init__(self, tracker, candles, get_expiries, lot_size, trending_oi_body, trader):
        self.tracker, self._candles, self._exp, self._lot, self._toi, self.trader = tracker, candles, get_expiries, lot_size, trending_oi_body, trader
        self._vix = (0.0, None)

    def market_open(self):
        return self.tracker.market_open()

    def positions(self, symbol):
        return self.trader.positions(symbol) if self.trader else {}

    def candles(self, symbol, max_age=None):
        return self._candles.get(symbol, max_age=max_age)

    def expiry(self, symbol):
        return self._exp(symbol)[0]

    def chain(self, symbol, expiry):
        entry, cached = self.tracker.chains.get(symbol, expiry)
        return chain_response(symbol, expiry, entry, cached, self._lot(symbol, expiry), self.tracker.clock(),
                              self.tracker.market_open(), self.tracker.client.token_expired)

    def trending(self, symbol, expiry):
        return self._toi(symbol, expiry, 5)["rows"]

    def vix(self):
        at, v = self._vix
        if time.time() - at < VIX_TTL:
            return v
        v = self.tracker.client.index_ltp([INDIA_VIX]).get(str(INDIA_VIX))
        self._vix = (time.time(), v)
        return v


class SignalService:
    def __init__(self, cfg, sources, trader, clock=lambda: datetime.now(IST), orderflow=None, paper=None):
        self.cfg, self.src, self.trader, self.clock = cfg, sources, trader, clock
        self.orderflow, self.paper = orderflow, paper
        self.lock = threading.RLock()
        self.last = {}  # symbol -> {"at": epoch, "state": ..., "results": {...}, "problems": [...], "source": "watcher"|"page"}
        self.alerts = []  # newest last
        self.heartbeat = None
        self.skips = Counter()  # (rule, reason) today, for the end-of-day summary
        self._fails = Counter()  # data problem -> consecutive failures
        self._summary_day = None
        self._key_alert_day = None
        self._stop = threading.Event()
        self._thread = None

    # ---------- alerts ----------
    def alert(self, kind, message):
        now = self.clock()
        a = {"time": now.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "message": message}
        with self.lock:
            if self.alerts and self.alerts[-1]["message"] == message:
                return
            self.alerts = (self.alerts + [a])[-50:]
        log.warning("ALERT %s: %s", kind, message)
        self._append(os.path.join(self.cfg["logDir"], "alerts.log"), f"{a['time']} [{kind}] {message}\n")

    def _append(self, path, text):
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(text)
        except OSError as e:
            log.warning("could not write %s: %s", path, e)

    # ---------- evaluation ----------
    def evaluate(self, symbol, source="page", max_age=None):
        now = self.clock()
        state, problems = build_state(symbol, now, self.src) if max_age is None else self._fresh_state(symbol, now, max_age)
        results = {}
        if state:
            results = {"tradingHub": trading_hub_rule(state), "megabull": megabull_rule(state), "dharaniV2": dharani_v2_rule(state)}
        rec = {"at": time.time(), "time": now.strftime("%H:%M:%S"), "state": state, "results": results, "problems": problems, "source": source}
        with self.lock:
            if source == "watcher" or symbol not in self.last or self.last[symbol]["source"] != "watcher" \
                    or (state and self.last[symbol]["state"] and state["signalTime"] != self.last[symbol]["state"]["signalTime"]):
                self.last[symbol] = rec
        return rec

    def _fresh_state(self, symbol, now, max_age):
        class Fresh:  # same sources, but candles no older than max_age
            def __getattr__(_s, name):
                return getattr(self.src, name)

            def candles(_s, sym):
                return self.src.candles(sym, max_age=max_age)
        return build_state(symbol, now, Fresh())

    def cached(self, symbol):
        with self.lock:
            rec = self.last.get(symbol)
        if rec and time.time() - rec["at"] < ON_DEMAND_TTL:
            return rec
        if rec and rec["source"] == "watcher" and not self.src.market_open():
            return rec
        return self.evaluate(symbol, "page")

    def run_once(self):
        """One watcher cycle: both indices, both rules; snapshot rows; hand GO results to the trader."""
        self.heartbeat = self.clock()
        self.subscribe_futures()  # the near-month future rolls the day after expiry
        for symbol in SYMBOLS:
            rec = None
            for attempt in range(3):  # Dhan's last minute can trail: retry a complete candle twice, 20 s apart
                rec = self.evaluate(symbol, "watcher", max_age=15)
                st = rec["state"]
                if st and st.get("complete"):
                    break
                if attempt < 2:
                    time.sleep(20)
            self._track_problems(symbol, rec)
            st = rec["state"]
            if not st:
                continue
            action = ""
            if self.trader:
                self.trader.update_watch(symbol, st.get("expiry"), st.get("spot"))
                self.trader.on_candle(symbol, st)
                for key in ("tradingHub", "megabull", "dharaniV2"):
                    r = rec["results"][key]
                    if r["go"]:
                        why = self.trader.on_signal(r, st)
                        action += f"{key}: {why or 'not sent'}; "
                        if why != "Entry sent" and not st["positions"].get(key):
                            # a GO the account could not take (MegaBull still off, Auto OFF, a limit): track it in the
                            # shadow log so the rule's results are not lost (owner: MegaBull setups go to the shadow log)
                            self.trader.add_skip(r, st, "-", f"GO, not sent: {why or 'account not available'}")
                    else:
                        self.skips[(key, self._skip_reason(r))] += 1
                        setup = skipped_setup(r)
                        if setup and not st["positions"].get(key):
                            self.trader.add_skip(r, st, *setup)
            self.write_snapshot(symbol, rec, "5min", action.strip("; "))

    def _skip_reason(self, r):
        if r["blocked"] and r.get("grade"):
            return r["blocked"][0]
        off = [c["label"] for c in r["checks"] if c["state"] != PASS and not c.get("exempt")]
        return off[0] if off else (r["blocked"][0] if r["blocked"] else "NO GO")

    def _track_problems(self, symbol, rec):
        keys = set()
        for p in rec["problems"]:
            k = p.split(":")[0]
            keys.add(k)
            self._fails[k] += 1
            if self._fails[k] == 2:
                self.alert("data", f"Data problem twice in a row: {p}")
        for k in list(self._fails):
            if k not in keys and k.startswith(symbol):
                self._fails[k] = 0

    # ---------- snapshot log ----------
    def snapshot_path(self, day=None):
        day = day or self.clock().date().isoformat()
        return os.path.join(self.cfg["logDir"], f"snapshots_{day}.csv")

    def write_snapshot(self, symbol, rec, event, action="", note=""):
        st, res = rec["state"], rec["results"]
        if not st:
            return
        i, b, ind = st["i"], st["bars"][st["i"]], st["ind"]
        toi = st.get("toi") or []
        t0 = toi[0] if toi else {}
        sr = st.get("sr") or {}
        th, mb, d2 = res.get("tradingHub") or {}, res.get("megabull") or {}, res.get("dharaniV2") or {}
        fmt_checks = lambda r: "; ".join(f"{c['id']}={c['state']}" for c in r.get("checks", []))  # noqa: E731
        row = {
            "time": self.clock().strftime("%H:%M:%S"), "event": event, "index": symbol, "signal_candle": st["signalTime"],
            "spot": st.get("spot"), "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b.get("volume"),
            "rsi14": _r(ind["rsi"][i]), "ema20": _r(ind["ema20"][i]), "vwap": _r(ind["vwap"][i]), "supertrend": _r(ind["st_line"][i]),
            "supertrend_dir": {-1: "green", 1: "red"}.get(ind["st_dir"][i]), "bb_basis": _r(ind["bb_basis"][i]),
            "bb_upper": _r(ind["bb_upper"][i]), "bb_lower": _r(ind["bb_lower"][i]),
            "prev_high": (st.get("prev") or {}).get("high"), "prev_low": (st.get("prev") or {}).get("low"),
            "prev_close": (st.get("prev") or {}).get("close"), "pivot": _r((st.get("piv") or {}).get("P")),
            "today_high": (st.get("today") or {}).get("high"), "today_low": (st.get("today") or {}).get("low"),
            "vix": st.get("vix"), "pcr": _r(st.get("pcr"), 3),
            "toi_time": t0.get("time"), "toi_strength": t0.get("strengthPct"),
            "toi_strength_2": toi[1]["strengthPct"] if len(toi) > 1 else None, "toi_strength_3": toi[2]["strengthPct"] if len(toi) > 2 else None,
            "toi_call_chg": t0.get("callChg"), "toi_put_chg": t0.get("putChg"), "toi_diff": t0.get("diffOi"),
            "toi_direction_pct": t0.get("directionPct"), "toi_net_pcr": t0.get("netPcr"), "toi_sentiment": t0.get("sentiment"),
            "toi_day_hl_break": (t0.get("dayHLBreak") or {}).get("type") if t0 else None, "toi_call_ltp_chg": t0.get("callLtpChg"),
            "toi_put_ltp_chg": t0.get("putLtpChg"), "toi_put_ltp": t0.get("putLtpTotal"), "toi_oi_hl_break": t0.get("dayHLDiffBreak"),
            "dhan_oi_verdict": (st.get("oi") or {}).get("verdict"), "dhan_oi_average": _r((st.get("oi") or {}).get("average")),
            "sensibull_verdict": (st.get("sb") or {}).get("verdict"), "sensibull_average": _r((st.get("sb") or {}).get("average")),
            "oi_agreement": agreement(st.get("oi"), st.get("sb")),
            "oi_r1": (sr.get("levels", {}).get("R") or [{}])[0].get("strike") if sr else None,
            "oi_s1": (sr.get("levels", {}).get("S") or [{}])[0].get("strike") if sr else None,
            "biggest_call_wall": (sr.get("biggestCallAbove") or {}).get("strike"), "biggest_put_wall": (sr.get("biggestPutBelow") or {}).get("strike"),
            "th_side": th.get("side"), "th_go": th.get("go"), "th_grade": th.get("grade"), "th_blocked": "; ".join(th.get("blocked", [])),
            "th_checks": fmt_checks(th), "mb_setup": mb.get("setup"), "mb_side": mb.get("side"), "mb_go": mb.get("go"),
            "mb_blocked": "; ".join(mb.get("blocked", [])), "mb_checks": fmt_checks(mb),
            "d2_side": d2.get("side"), "d2_go": d2.get("go"), "d2_score": d2.get("score"),
            "d2_blocked": "; ".join(d2.get("blocked", [])), "d2_checks": fmt_checks(d2),
            "auto": self.trader.state["auto"] if self.trader else False, "action": action, "note": note,
        }
        row.update(self._flow_cols(symbol, st["signalTime"]))
        path = self.snapshot_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            new = not os.path.exists(path)
            with open(path, "a", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=SNAPSHOT_FIELDS)
                if new:
                    w.writeheader()
                w.writerow(row)
        except OSError as e:
            self.alert("log", f"Could not write the snapshot log ({path}): {e}")

    def _flow_cols(self, symbol, candle):
        if not self.orderflow:
            return {}
        try:
            _f, bars = self.orderflow.series(symbol, 5)
        except Exception:
            return {}
        b = next((x for x in bars if datetime.fromtimestamp(x["time"], IST).strftime("%H:%M") == candle), None)
        if not b:
            return {}
        from orderflow import dext_match
        typed = self.orderflow.typed(symbol, 5).get(candle)
        m = dext_match(b["delta"], typed)
        return {"est_delta": b["delta"], "est_cumulative_delta": b["cumulative"], "dext_typed": typed,
                "dext_match": None if m is None else ("Y" if m else "N")}

    def on_order(self, trade, event):
        """Called by the trader on every order: one snapshot row for that index."""
        rec = self.last.get(trade["symbol"])
        if rec:
            self.write_snapshot(trade["symbol"], rec, "order",
                                f"{trade['rule']} {event}", f"{trade['instrument']['name']} entry {trade['entryPrice']} stop {trade['stop']} target {trade['target']}")

    def manual_positions(self, symbol):
        """Open Trading Hub paper positions on this index that no auto trade is managing (for the paper card's
        "Place stop + target together" button)."""
        acc = self.trader.accounts.get("tradingHub") if self.trader else None
        if not acc:
            return []
        managed = {t["instrument"]["id"] for t in self.trader.state["trades"] if t["status"] == "open" and t["account"] == "tradingHub"}
        try:
            rows = acc.paper.positions()
        except Exception:
            return []
        return [p for p in rows if p["open_qty"] > 0 and p.get("symbol") == symbol and p["security_id"] not in managed]

    def flow_summary(self, symbol, side=None):
        """The main page's 'Order flow, last 30 min' card: estimated delta of the last 6 completed 5-minute candles."""
        if not self.orderflow:
            return None
        fut, bars = self.orderflow.series(symbol, 5)
        if not fut or not bars:  # nothing recorded yet today: the card shows "No order flow yet"
            return None
        now = self.clock().timestamp()
        done = [b for b in bars if b["time"] + 300 <= now]
        last6 = done[-6:]
        typed = self.orderflow.typed(symbol, 5)
        checked = [(b, typed.get(datetime.fromtimestamp(b["time"], IST).strftime("%H:%M"))) for b in done]
        pairs = [(b["delta"], v) for b, v in checked if v is not None]
        cum = bars[-1]["cumulative"] if bars else 0
        neg = sum(1 for b in last6 if b["delta"] < 0)
        pos = sum(1 for b in last6 if b["delta"] > 0)
        agrees = None
        if side and last6:
            agrees = (cum < 0 and neg > pos) if side == "PE" else (cum > 0 and pos > neg)
        from orderflow import dext_match
        return {
            "future": fut["name"], "cumulative": cum, "change30": sum(b["delta"] for b in last6),
            "last6": [{"time": datetime.fromtimestamp(b["time"], IST).strftime("%H:%M"), "delta": b["delta"]} for b in last6],
            "negative": neg, "positive": pos, "side": side, "agrees": agrees,
            "dext": {"typed": len(pairs), "matched": sum(1 for d, v in pairs if dext_match(d, v))},
            "usedInRules": bool(self.cfg.get("orderFlow", {}).get("useEstimatedDelta")),
        }

    def subscribe_futures(self):
        """Keep both index futures on the feed all session (order flow needs every tick, dashboard open or not)."""
        if self.orderflow and self.paper:
            try:
                ids = [f["securityId"] for f in self.orderflow.future_ids().values()]
                self.paper.watch(ids, group="orderflow")
            except Exception as e:
                log.warning("could not subscribe the index futures for order flow: %s", e)

    def snapshot_info(self):
        path = self.snapshot_path()
        rows, last = 0, None
        try:
            with open(path, encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    rows += 1
                    last = r["time"]
        except OSError:
            pass
        return {"rowsToday": rows, "lastSaved": last, "path": path}

    # ---------- end of day ----------
    def summary(self):
        st = self.trader.status() if self.trader else {"today": []}
        trades = [t for t in st["today"] if t["status"] == "closed"]
        lines = [f"Auto paper summary {self.clock():%d %b %Y}"]
        for key, name in (("tradingHub", "Trading Hub"), ("megabull", "MegaBull (4 Pillar / Dharani v1)"),
                          ("dharaniV2", "MegaBull Dharani v2")):
            ts = [t for t in trades if (t.get("slot") or t["account"]) == key]
            net = sum(t.get("netPnl") or 0 for t in ts)
            lines.append(f"{name}: {len(ts)} trades, net Rs {net:,.2f}")
            for t in ts:
                lines.append(f"  {t['symbol']} {t['instrument']['name']} {t['grade']}: {t['entryPrice']} -> {t.get('exitPrice')} "
                             f"({t.get('exitReason')}), net Rs {t.get('netPnl') or 0:,.2f}")
            top = [(r, n) for (k, r), n in self.skips.most_common() if k == key][:3]
            if top:
                lines.append("  Most common skip reasons: " + "; ".join(f"{r} ({n} candles)" for r, n in top))
        if self.trader:
            sh = self.trader.shadow_summary()
            lines.append(f"Shadow log: {sh['skipped']} skipped setups, {sh['wouldHaveWorked']} would have worked (shadow_skips.csv).")
        return "\n".join(lines)

    def _end_of_day(self, now):
        if now.time() >= datetime.strptime("15:31", "%H:%M").time() and self._summary_day != now.date() and self._traded_today(now):
            self._summary_day = now.date()
            if self.trader:
                self.trader.finish_day()
            text = self.summary()
            self._append(os.path.join(self.cfg["logDir"], f"summary_{now.date()}.txt"), text + "\n")
            self.alert("summary", text)
            self.skips.clear()

    def _traded_today(self, now):
        return now.weekday() < 5 and self.heartbeat is not None and self.heartbeat.date() == now.date()

    def check_key_age(self):
        acc = self.trader.accounts.get("megabull") if self.trader else None
        if not acc:
            return
        try:
            age = acc.client.key_age_days()
        except Exception:
            return
        if age is not None and age > self.cfg["keyMaxAgeDays"] and self._key_alert_day != self.clock().date():
            self._key_alert_day = self.clock().date()
            self.alert("key", f"The MegaBull API key is {age} days old (it expires after a month). Make a new one and update {self.cfg['keysFile']}.")

    # ---------- loop ----------
    def _next_run(self, now):
        """The next 5-minute candle close + the delay (e.g. 10:05:35), strictly after now."""
        delay = timedelta(seconds=self.cfg.get("evaluateAfterCloseSeconds", 35))
        base = now.replace(second=0, microsecond=0)
        nxt = base - timedelta(minutes=base.minute % 5) + delay
        while nxt <= now:
            nxt += timedelta(minutes=5)
        return nxt

    def _loop(self):
        self.check_key_age()
        self.subscribe_futures()
        crashes = 0
        while not self._stop.is_set():
            now = self.clock()
            nxt = self._next_run(now)
            if self._stop.wait(max(1.0, (nxt - now).total_seconds())):
                return
            now = self.clock()
            hm = (now.hour, now.minute)
            try:
                if self.src.market_open() and SESSION[0] < hm <= SESSION[1]:
                    self.run_once()
                    crashes = 0
                self._end_of_day(now)
                if hm == (9, 0):
                    self.check_key_age()
            except Exception as e:
                crashes += 1
                log.exception("signal watcher cycle failed")
                if crashes >= 2:
                    self.alert("crash", f"The signal watcher failed twice in a row: {e}")

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="signal-watcher", daemon=True)
        self._thread.start()
        if self.trader:
            self.trader.start()

    def stop(self):
        self._stop.set()
        if self.trader:
            self.trader.stop()

    def watcher_status(self):
        now = self.clock()
        hm = (now.hour, now.minute)
        in_session = self.src.market_open() and SESSION[0] < hm <= SESSION[1]
        late = in_session and hm >= (9, 25) and (self.heartbeat is None or (now - self.heartbeat).total_seconds() > 420)
        return {"running": bool(self._thread and self._thread.is_alive()), "lastRun": self.heartbeat.strftime("%H:%M:%S") if self.heartbeat else None,
                "late": late}


# ======================================================================= routes
class AutoBody(BaseModel):
    on: bool


class BracketBody(BaseModel):
    securityId: int


class ExitBody(BaseModel):
    tradeId: str


class DextBody(BaseModel):
    symbol: str
    interval: int = 5
    time: str  # candle start "HH:MM"
    value: float | None = None


def skipped_setup(r):
    """(filters missed, why skipped) when a rule result is a skipped SETUP worth shadowing (owner's brief 7b), else None.
    MegaBull: the trigger candle happened but the rule said NO GO (Grade A only, so one missed filter is a skip).
    Trend: Trending OI or SuperTrend fired but a must-have was missed, or two or more other checks were off."""
    if r["go"]:
        return None
    by = {c["id"]: c for c in r["checks"]}
    off = [c["label"] for c in r["checks"] if c["state"] != PASS and not c.get("exempt")]
    if r["rule"] == "dharaniV2":  # SuperTrend on the side and exactly one of the other three conditions missed
        if by.get("supertrend", {}).get("state") != PASS or r.get("score") != 3 or by.get("window", {}).get("state") != PASS:
            return None
        return "; ".join(off) or "-", "; ".join(r["blocked"]) or ("All four needed: " + ", ".join(off) + " missed")
    if r["rule"] == "megabull":
        if by.get("trigger", {}).get("state") != PASS:
            return None
        return "; ".join(off) or "-", "; ".join(r["blocked"]) or ("Grade A only: " + ", ".join(off) + " missed")
    st, toi = by.get("supertrend", {}).get("state"), by.get("trendingOi", {}).get("state")
    if PASS not in (st, toi):
        return None
    if r.get("grade"):  # a valid grade blocked only by a gate (time, open position): not a skipped setup
        return None
    must_off = [c["label"] for c in r["checks"] if c["must"] and not c.get("exempt") and c["state"] != PASS]
    soft_off = [c["label"] for c in r["checks"] if not c["must"] and c["state"] != PASS]
    why = "Must-have missed" if must_off else f"{len(soft_off)} other checks off (Grade B allows one)"
    return "; ".join(must_off + soft_off), why


def _context_row(state):
    if not state:
        return None
    prev, piv, today = state.get("prev") or {}, state.get("piv") or {}, state.get("today") or {}
    return {"symbol": state["symbol"], "prevHigh": prev.get("high"), "prevClose": prev.get("close"), "prevLow": prev.get("low"),
            "pivot": piv.get("P"), "todayHigh": today.get("high"), "todayLow": today.get("low"), "vix": state.get("vix"),
            "pcr": state.get("pcr"), "spot": state.get("spot")}


def register(app, svc):
    @app.get("/api/signals/state")
    def signals_state(symbol: str = "NIFTY"):
        symbol = symbol.upper()
        if symbol not in SYMBOLS:
            raise HTTPException(400, f"symbol must be one of {list(SYMBOLS)}")
        recs = {s: svc.cached(s) for s in SYMBOLS}
        rec = recs[symbol]
        st = rec["state"]
        now = svc.clock()
        body = {
            "meta": {"symbol": symbol, "asOf": now.strftime("%Y-%m-%d %H:%M:%S"), "evaluatedAt": rec["time"], "source": rec["source"],
                     "signalCandle": st["signalTime"] if st else None, "marketOpen": svc.src.market_open(),
                     "problems": rec["problems"], "watcher": svc.watcher_status()},
            "context": [_context_row(recs[s]["state"]) for s in SYMBOLS],
            "rules": rec["results"],
            "trendingOi": (st.get("toiAll") or [])[:5] if st else [],
            "oiViews": {"dhan": st.get("oi"), "sensibull": st.get("sb"), "agreement": agreement(st.get("oi"), st.get("sb")),
                        "trending": trending_view(st.get("toi")),
                        "votes": votes(st.get("oi"), st.get("sb"), trending_view(st.get("toi")))} if st else None,
            "sr": st.get("sr") if st else None,
            "auto": svc.trader.status() if svc.trader else None,
            "alerts": svc.alerts[-10:],
            "snapshots": svc.snapshot_info(),
            "paperPositions": svc.manual_positions(symbol),
            "shadow": svc.trader.shadow_summary() if svc.trader else None,
            "orderFlow": svc.flow_summary(symbol, (rec["results"].get("tradingHub") or {}).get("side")),
        }
        if st:
            for w in ("windows",):
                if body["oiViews"]["dhan"]:
                    body["oiViews"]["dhan"] = {k: v for k, v in body["oiViews"]["dhan"].items() if k != w}
        return body

    @app.get("/api/signals/snapshots.csv")
    def snapshots_csv(date: str = ""):
        path = svc.snapshot_path(date or None)
        if not os.path.exists(path):
            raise HTTPException(404, "No snapshots saved for that day yet.")
        return PlainTextResponse(open(path, encoding="utf-8").read(), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{os.path.basename(path)}"'})

    @app.get("/api/orderflow/days")
    def orderflow_days():
        if not svc.orderflow:
            raise HTTPException(503, "Order flow is not running (paper trading feed is off).")
        return {"days": svc.orderflow.days()}

    @app.get("/api/orderflow")
    def orderflow(symbol: str = "NIFTY", interval: int = 5, date: str = ""):
        symbol = symbol.upper()
        if symbol not in SYMBOLS:
            raise HTTPException(400, f"symbol must be one of {list(SYMBOLS)}")
        if interval not in (1, 3, 5, 10, 15, 20, 30, 45, 60):
            raise HTTPException(400, "interval must be 1, 3, 5, 10, 15, 20, 30, 45 or 60")
        if not svc.orderflow:
            raise HTTPException(503, "Order flow is not running (paper trading feed is off).")
        day = None
        if date:
            try:
                day = datetime.strptime(date, "%Y-%m-%d").date()
            except ValueError:
                raise HTTPException(400, "date must look like 2026-10-21")
        from orderflow import dext_match
        fut, bars = svc.orderflow.series(symbol, interval, day)
        typed = svc.orderflow.typed(symbol, interval, day)
        jump = svc.cfg.get("orderFlow", {}).get("deltaJump", {}).get(symbol)
        rows = []
        for b in bars:
            hhmm = datetime.fromtimestamp(b["time"], IST).strftime("%H:%M")
            v = typed.get(hhmm)
            rows.append({**b, "hhmm": hhmm, "dext": v, "match": dext_match(b["delta"], v),
                         "jump": bool(jump) and abs(b["delta"]) >= jump})
        return {"meta": {"symbol": symbol, "interval": interval, "future": fut["name"] if fut else None,
                         "date": (day or svc.clock().date()).isoformat(), "live": day is None or day == svc.clock().date(),
                         "asOf": svc.clock().strftime("%Y-%m-%d %H:%M:%S"), "deltaJump": jump,
                         "usedInRules": bool(svc.cfg.get("orderFlow", {}).get("useEstimatedDelta")),
                         "message": "" if fut else ("Nothing was recorded on that day (the backend was not running)." if day
                                                    else "No index future in Dhan's instrument list yet.")},
                "rows": rows}

    @app.post("/api/orderflow/dext")
    def set_dext(body: DextBody):
        if not svc.orderflow:
            raise HTTPException(503, "Order flow is not running.")
        svc.orderflow.set_dext(body.symbol.upper(), body.interval, body.time, body.value)
        return {"ok": True}

    @app.post("/api/autopaper/auto")
    def set_auto(body: AutoBody):
        if not svc.trader:
            raise HTTPException(503, "Auto paper trading is not running (paper trading is off).")
        svc.trader.set_auto(body.on)
        return svc.trader.status()

    @app.post("/api/autopaper/bracket")
    def bracket(body: BracketBody):
        try:
            return svc.trader.bracket(body.securityId)
        except Exception as e:
            raise HTTPException(409, str(e))

    @app.get("/api/autopaper/check")
    def startup_check():
        """For the daily start file: is the MegaBull key there, how old is it, does MegaBull answer (read-only)."""
        acc = svc.trader.accounts.get("megabull") if svc.trader else None
        if not acc:
            return {"megabull": {"ok": False, "message": "Auto paper trading is not running."}}
        try:
            client = acc.client
        except Exception as e:
            return {"megabull": {"ok": False, "message": str(e)}}
        age = client.key_age_days()
        try:
            client.me()
            msg = "MegaBull answered." + ("" if acc.enabled else " MegaBull auto orders are still OFF (by design until tested).")
            ok = True
        except Exception as e:
            ok, msg = False, f"MegaBull did not answer: {e}"
        if age is not None and age > svc.cfg["keyMaxAgeDays"]:
            msg += f" The key is {age} days old: make a new one."
        return {"megabull": {"ok": ok, "message": msg, "keyAgeDays": age}}

    @app.get("/api/autopaper/orders")
    def account_orders(account: str = "tradingHub"):
        if not svc.trader:
            raise HTTPException(503, "Auto paper trading is not running.")
        try:
            return {"account": account, "rows": svc.trader.account_orders(account)}
        except Exception as e:
            raise HTTPException(409, str(e))

    @app.post("/api/autopaper/exit")
    def exit_trade(body: ExitBody):
        try:
            svc.trader.exit_trade(body.tradeId)
        except Exception as e:
            raise HTTPException(409, str(e))
        return svc.trader.status()
