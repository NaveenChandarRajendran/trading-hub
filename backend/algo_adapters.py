"""
algo_adapters.py - each algo behind the common Algos hub API (algos_api.py). An adapter only reads the algo's own
records and calls its own service: no trading logic lives here. Settings: algo_settings.py (th_algo_settings).

Common shapes:
  summary   {name, category, state: running | stopped | stale | closed | off | token | error, stateText, halted,
             todayPnl, mtdPnl, open (one line) | None, lastEvent {ts, text} | None}
  event     {id, ts, type, side, scope, variant, setup, message}     scope: the index ("NIFTY", "ALL") or ""
  trade     {setup, side, instrument, lots, entryAt, entryPrice, exitAt, exitPrice, spotIn, spotOut, pnl, note}
  day row   {date, realized, charges, net, trades, wins, losses}
  settings  algo_settings.AlgoSettings.view(): {editable, fields [...], history [{ts, key, old, new, user}], note}
"""
from datetime import time as dtime

import algo_config as oib_cfg
import toi_algo_logic as TL
import trending_oi_algo_config as toi_cfg
from algo_reports import range_report, trade_points
from algo_settings import AlgoSettings, check

KEEP_NOTE = "New decisions use a change at once; an open trade keeps the stop and lots it was opened with."


def iso(ts):
    return ts.isoformat() if hasattr(ts, "isoformat") else ts


def state_of(mode, market_open, halted, stale, token, error=None):
    if mode == "off":
        return "off", "Off"
    if token:
        return "token", "Dhan token expired"
    if error:
        return "error", error
    if not market_open:
        return "closed", "Market closed" + (" · stopped" if halted else "")
    if halted:
        return "stopped", "Stopped (no new entries)"
    if stale:
        return "stale", "Feed stale"
    return "running", "Running"


def shown(v):
    """A setting's value in a log line: on / off for switches."""
    return ("on" if v else "off") if isinstance(v, bool) else v


def lots_text(n):
    return f"{n} lot{'s' if n != 1 else ''}"


def _f(group, key, label, **kw):
    return {"group": group, "key": key, "label": label, **kw}


# ===================================================================== Trending OI Algo
def toi_fields():
    d = toi_cfg.DEFAULTS
    rows = [
        _f("Direction & no-trade", "toiStrengthMin", "Trending OI strength min %", max=100),
        _f("Direction & no-trade", "toiDotsMin", "Strength dots min", min=1, max=3),
        _f("Direction & no-trade", "flipLookbackMin", "No trade after a flip (min)", max=240),
        _f("Direction & no-trade", "weakDayFrom", "Weak-day check from"),
        _f("Direction & no-trade", "weakDayRangePct", "Weak day: range below %", max=10),
        _f("Direction & no-trade", "maxVwapDistPct", "Over-extended: from VWAP %", max=10),
        _f("Direction & no-trade", "rsiMaxCE", "RSI max for CE", max=100),
        _f("Direction & no-trade", "rsiMinPE", "RSI min for PE", max=100),
        _f("Entry & stop", "touchPts", "Pullback within (pts)", max=500),
        _f("Entry & stop", "entryLots", "Entry lots", min=1, max=50),
        _f("Entry & stop", "maxStopPct", "Skip when stop beyond %", max=10),
        _f("Entry & stop", "entryFrom", "Entries from"),
        _f("Entry & stop", "entryTo", "Entries until"),
        _f("Entry & stop", "maxTrades", "Trades per day", min=1, max=20),
        _f("Entry & stop", "dayLossStopPct", "Day loss stop % of capital", min=0.1, max=50),
        _f("Adds", "avgAddLots", "Averaging adds (lots)", max=50),
        _f("Adds", "avgMaxLots", "Averaging up to (lots)", max=100),
        _f("Adds", "pyrAddLots", "Pyramiding adds (lots)", max=50),
        _f("Adds", "pyrMaxLots", "Pyramiding up to (lots)", max=100),
        _f("Adds", "maxLots", "Never more than (lots)", min=1, max=100),
        _f("Adds", "addRiskMax", "Risk guard (₹)"),
        _f("Adds", "deltaFallback", "Delta without chain data", max=1),
        _f("Exits", "partialMinPts", "Partial level at least (pts)", max=1000),
        _f("Exits", "breakevenAtR", "Breakeven at (R) without levels", max=20),
        _f("Exits", "squareOff", "Square-off"),
        _f("Indicators", "candleMin", "Candle timeframe (min)", choices=[3, 5]),
        _f("Indicators", "supertrendPeriod", "Supertrend period", min=1, max=100),
        _f("Indicators", "supertrendMult", "Supertrend factor", min=0.1, max=20),
        _f("Indicators", "rsiPeriod", "RSI period", min=2, max=100),
        _f("Strike", "strikeFallback", "After 1 ITM, try", choices=["ATM", "2ITM"]),
    ]
    for r in rows:
        v = d[r["key"]]
        r["default"] = v
        r["kind"] = ("list" if isinstance(v, list) else "time" if isinstance(v, str) else
                     "int" if isinstance(v, int) and not isinstance(v, bool) else "number")
    return rows


def toi_cross(v):
    if v["entryFrom"] >= v["entryTo"]:
        return "Entries from must be before Entries until"
    if v["entryTo"] > v["squareOff"]:
        return "Entries until must not be after the square-off"
    return None


class ToiAdapter:
    slug, name, category, rules_doc = "trending-oi", toi_cfg.STRATEGY_NAME, "intraday", "trending-oi-algo"
    live_variant = ""

    def __init__(self, svc):
        self.svc = svc
        self.settings = AlgoSettings(svc.toi.settings_store, self.slug, toi_fields(), toi_cross)

    def today(self):
        return self.svc.clock().date().isoformat()

    def owner_id(self):
        acc = self.svc.broker.account if self.svc.broker else self.svc.store.active_account(toi_cfg.ACCOUNT_NAME)
        st = self.svc.store.strategy(acc["strategy_id"]) if acc and acc.get("strategy_id") else None
        return st["user_id"] if st else None

    def summary(self):
        s = self.svc.status()
        st = s.get("state") or {}
        state, text = state_of(s["mode"], s["marketOpen"], s["halted"], s["stale"], s["tokenExpired"])
        today = (s.get("funds") or {}).get("dayPnl") or 0.0
        before = sum(r["net_pnl"] for r in self.svc.toi.summaries(self.today()[:7] + "-01", self.today()) if r["day"] < self.today())
        o = st.get("open")
        open_line = (f"{o['side']} {TL.fmt(o.get('strike'))} × {lots_text(o['lots'])} · stop index {o['stop']['dir']} "
                     f"{TL.fmt(o['stop']['price'])}") if o else None
        last = next((e for e in self.events(self.today()) if e["type"] != "heartbeat"), None)
        return {"name": self.name, "category": self.category, "state": state, "stateText": text, "halted": s["halted"],
                "todayPnl": round(today, 2), "mtdPnl": round(before + today, 2), "open": open_line,
                "lastEvent": last and {"ts": last["ts"], "text": last["message"]}}

    def events(self, day):
        """Newest first (by time, then id)."""
        rows = [{"id": e["id"], "ts": iso(e["ts"]), "type": e["type"], "side": e.get("side"), "scope": "", "variant": "",
                 "setup": "", "message": e["message"]} for e in self.svc.toi.events(day)]
        return sorted(rows, key=lambda r: (r["ts"], r["id"]), reverse=True)

    def trades(self, day):
        st = self.svc.toi.state(day) or (self.svc.state if day == self.today() else None) or {}
        rows = [self._trade(t, closed=True) for t in st.get("closed", [])]
        if st.get("open") and day == self.today():
            rows.append(self._trade(st["open"], closed=False))
        return rows

    @staticmethod
    def _trade(t, closed):
        adds = t.get("adds") or {}
        return {"setup": "Pullback", "side": t["side"], "instrument": f"NIFTY {TL.fmt(t.get('strike'))} {t['side']}",
                "lots": t.get("lots"), "entryAt": t.get("entryAt"), "entryPrice": t.get("avg"),
                "exitAt": t.get("exitAt") if closed else None, "exitPrice": None, "spotIn": t.get("entrySpot"),
                "spotOut": t.get("exitSpot") if closed else None, "pnl": t.get("pnl") if closed else None,
                "note": f"adds {adds.get('avg', 0)} avg / {adds.get('pyr', 0)} pyr · partials {t.get('partials', 0)}"
                        + ("" if closed else " · open")}

    def reports(self, from_day, to_day):
        days = [{"date": r["day"], "realized": r["gross_pnl"], "charges": r["charges"], "net": r["net_pnl"],
                 "trades": r["trades"], "wins": r["wins"], "losses": r["losses"]} for r in self.svc.toi.summaries(from_day, to_day)]
        pnls = [t["pnl"] for st in self.svc.toi.states_between(from_day, to_day).values() for t in st.get("closed", [])
                if t.get("pnl") is not None]
        return days, pnls

    def settings_view(self):
        return self.settings.view(KEEP_NOTE)

    def save_settings(self, changes, user):
        clean = check(self.settings.fields, changes)
        err = toi_cross({**self.settings.values(), **clean})
        if err:
            raise ValueError(err)
        self.svc.set_settings(clean, who=user)  # saves (th_algo_settings + its log) and writes the decision-log line

    def stop(self, exit_all, user):
        self.svc.stop(exit_all=exit_all, who=user)

    def resume(self, user):
        self.svc.resume(who=user)


# ===================================================================== OI Breakout Algo
def _hm(t):
    return f"{t:%H:%M}"


def _time(s):
    h, m = map(int, s.split(":"))
    return dtime(h, m)


def _put(attr, idx):
    """Setter for one end of a tuple (RSI bands)."""
    def set_(c, v):
        t = list(getattr(c, attr))
        t[idx] = v
        setattr(c, attr, tuple(t))
    return set_


# key -> (read from algo_config, write into algo_config). Values on the page / in the table are JSON ("HH:MM" times).
OIB_ATTRS = {
    "entryFrom": (lambda c: _hm(c.ENTRY_FROM), lambda c, v: setattr(c, "ENTRY_FROM", _time(v))),
    "entryTo": (lambda c: _hm(c.ENTRY_TO), lambda c, v: setattr(c, "ENTRY_TO", _time(v))),
    "lots": (lambda c: c.LOTS, lambda c, v: setattr(c, "LOTS", v)),
    "maxTradesPerIndex": (lambda c: c.MAX_TRADES_PER_INDEX, lambda c, v: setattr(c, "MAX_TRADES_PER_INDEX", v)),
    "stopAfterWin": (lambda c: c.STOP_AFTER_WIN, lambda c, v: setattr(c, "STOP_AFTER_WIN", v)),
    "dayLossStopPct": (lambda c: c.DAY_LOSS_STOP_PCT, lambda c, v: setattr(c, "DAY_LOSS_STOP_PCT", v)),
    "premiumStopPct": (lambda c: c.PREMIUM_STOP_PCT, lambda c, v: setattr(c, "PREMIUM_STOP_PCT", v)),
    "premiumTargetPct": (lambda c: c.PREMIUM_TARGET_PCT, lambda c, v: setattr(c, "PREMIUM_TARGET_PCT", v)),
    "toiStrengthMin": (lambda c: c.TOI_STRENGTH_MIN, lambda c, v: setattr(c, "TOI_STRENGTH_MIN", v)),
    "rsiCeMin": (lambda c: c.RSI_CE[0], _put("RSI_CE", 0)),
    "rsiCeMax": (lambda c: c.RSI_CE[1], _put("RSI_CE", 1)),
    "rsiPeMin": (lambda c: c.RSI_PE[0], _put("RSI_PE", 0)),
    "rsiPeMax": (lambda c: c.RSI_PE[1], _put("RSI_PE", 1)),
    "bufferNifty": (lambda c: c.BUFFER["NIFTY"], lambda c, v: c.BUFFER.__setitem__("NIFTY", v)),
    "bufferBanknifty": (lambda c: c.BUFFER["BANKNIFTY"], lambda c, v: c.BUFFER.__setitem__("BANKNIFTY", v)),
    "pullbackCandles": (lambda c: c.PULLBACK_CANDLES, lambda c, v: setattr(c, "PULLBACK_CANDLES", v)),
    "continuationAfter": (lambda c: c.CONTINUATION_AFTER, lambda c, v: setattr(c, "CONTINUATION_AFTER", v)),
    "minRangeNifty": (lambda c: c.MIN_RANGE_WIDTH["NIFTY"], lambda c, v: c.MIN_RANGE_WIDTH.__setitem__("NIFTY", v)),
    "minRangeBanknifty": (lambda c: c.MIN_RANGE_WIDTH["BANKNIFTY"], lambda c, v: c.MIN_RANGE_WIDTH.__setitem__("BANKNIFTY", v)),
    "rangeTradesPerLevel": (lambda c: c.RANGE_TRADES_PER_LEVEL or 0, lambda c, v: setattr(c, "RANGE_TRADES_PER_LEVEL", v or None)),
    "rangeBlockBroken": (lambda c: c.RANGE_BLOCK_BROKEN, lambda c, v: setattr(c, "RANGE_BLOCK_BROKEN", v)),
    "armOnStopCandle": (lambda c: c.ARM_ON_STOP_CANDLE, lambda c, v: setattr(c, "ARM_ON_STOP_CANDLE", v)),
}
OIB_DEFAULTS = {k: get(oib_cfg) for k, (get, _set) in OIB_ATTRS.items()}  # algo_config.py as written


def oib_fields():
    rows = [
        _f("Entries", "entryFrom", "Entries from", kind="time"),
        _f("Entries", "entryTo", "Entries until", kind="time"),
        _f("Entries", "lots", "Lots per trade", kind="int", min=1, max=20),
        _f("Entries", "maxTradesPerIndex", "Trades per index per day", kind="int", min=1, max=10),
        _f("Entries", "stopAfterWin", "A win ends the index's day", kind="bool"),
        _f("Entries", "dayLossStopPct", "Day loss stop % of capital", kind="number", min=0.1, max=50),
        _f("Exits", "premiumStopPct", "Premium stop %", kind="number", min=1, max=90),
        _f("Exits", "premiumTargetPct", "Premium target %", kind="number", min=1, max=500),
        _f("Filters", "toiStrengthMin", "Trending OI strength min %", kind="number", max=100),
        _f("Filters", "rsiCeMin", "RSI for CE: from", kind="number", max=100),
        _f("Filters", "rsiCeMax", "RSI for CE: to", kind="number", max=100),
        _f("Filters", "rsiPeMin", "RSI for PE: from", kind="number", max=100),
        _f("Filters", "rsiPeMax", "RSI for PE: to", kind="number", max=100),
        _f("Setups", "bufferNifty", "Break buffer NIFTY (pts)", kind="number", max=200),
        _f("Setups", "bufferBanknifty", "Break buffer BANKNIFTY (pts)", kind="number", max=500),
        _f("Setups", "pullbackCandles", "Pullback within (candles)", kind="int", min=1, max=30),
        _f("Setups", "continuationAfter", "Continuation after (candles, C)", kind="int", min=1, max=30),
        _f("Setups", "minRangeNifty", "Range min width NIFTY (pts)", kind="number", max=2000),
        _f("Setups", "minRangeBanknifty", "Range min width BANKNIFTY (pts)", kind="number", max=5000),
        _f("Setups", "rangeTradesPerLevel", "Range trades per level (0 = no limit)", kind="int", max=10),
        _f("Setups", "rangeBlockBroken", "No range trade at a broken level", kind="bool"),
        _f("Setups", "armOnStopCandle", "A break on the stop candle arms", kind="bool"),
    ]
    for r in rows:
        r["default"] = OIB_DEFAULTS[r["key"]]
    fixed = [("Live variant (env ALGO_VARIANT)", oib_cfg.RULE_VARIANT), ("Levels lock at", _hm(oib_cfg.LEVELS_AT)),
             ("Square-off", _hm(oib_cfg.SQUARE_OFF)), ("Candles (min)", oib_cfg.CANDLE_MIN),
             ("Capital (₹)", oib_cfg.CAPITAL), ("Account", oib_cfg.ACCOUNT_NAME)]
    rows += [_f("Fixed (set in code)", f"fixed{i}", label, kind="text", default=v, readOnly=True) for i, (label, v) in enumerate(fixed)]
    return rows


def oib_cross(v):
    if v["entryFrom"] >= v["entryTo"]:
        return "Entries from must be before Entries until"
    if v["entryTo"] > _hm(oib_cfg.SQUARE_OFF):
        return "Entries until must not be after the square-off"
    if v["rsiCeMin"] >= v["rsiCeMax"] or v["rsiPeMin"] >= v["rsiPeMax"]:
        return "an RSI band's from must be below its to"
    return None


def apply_oib(values):
    """Writes the merged values into algo_config, which the OI breakout logic reads at each decision."""
    for k, v in values.items():
        if k in OIB_ATTRS:
            OIB_ATTRS[k][1](oib_cfg, v)


class OiBreakoutAdapter:
    slug, name, category, rules_doc = "oi-breakout", "OI Breakout Algo", "intraday", "oi-breakout"

    def __init__(self, algo, settings_store):
        self.algo = algo
        self.settings = AlgoSettings(settings_store, self.slug, oib_fields(), oib_cross)
        apply_oib(self.settings.values())

    @property
    def live_variant(self):
        return self.algo.variant

    def today(self):
        return self.algo.clock().date().isoformat()

    def owner_id(self):
        return self.algo.owner_id()

    def summary(self):
        s = self.algo.status()
        m = s["meta"]
        h = m.get("health") or {}
        market_open = bool(m.get("tradingDay")) and self.algo.in_session(self.algo.clock())
        halted = any(i.get("stopped") for i in s["indices"])
        state, text = state_of(m["mode"], market_open, halted, h.get("state") == "stale", m.get("tokenExpired"),
                               h.get("reason") if h.get("state") == "error" and market_open else None)
        today = (m.get("funds") or {}).get("dayPnl") or 0.0
        before = sum((r.get("net_pnl") or 0) for r in self.algo.store.algo_summaries(self.today()[:7] + "-01", self.today())
                     if r.get("is_live") and str(r["trade_date"]) < self.today())
        opens = [f"{i['open'].get('option') or i['symbol'] + ' ' + i['open']['side']} × {lots_text(i['open'].get('lots') or oib_cfg.LOTS)}"
                 for i in s["indices"] if i.get("open")]
        last = next((e for e in self.events(self.today(), live_only=True) if e["type"] != "heartbeat"), None)
        return {"name": self.name, "category": self.category, "state": state, "stateText": text, "halted": halted,
                "todayPnl": round(today, 2), "mtdPnl": round(before + today, 2), "open": " · ".join(opens) or None,
                "lastEvent": last and {"ts": last["ts"], "text": last["message"]}}

    def events(self, day, live_only=False):
        rows = self.algo.store.algo_events(day, variant=self.algo.variant if live_only else None)
        out = []
        for n, e in enumerate(rows):
            if e["type"] == "candle":
                continue
            d = e.get("details") or {}
            out.append({"id": n + 1, "ts": iso(e["ts"]), "type": e["type"], "side": (d.get("trade") or {}).get("side") or d.get("side"),
                        "scope": "ALL" if e["index"] == "*" else e["index"],
                        "variant": "" if e["index"] == "*" else e["variant"], "setup": e.get("setup") or "", "message": e["message"]})
        return sorted(out, key=lambda r: (r["ts"], r["id"]), reverse=True)

    def trades(self, day):
        rows = []
        for (ix, var), st in sorted(self.algo.store.algo_states(day).items()):
            if var != self.algo.variant:
                continue
            rows += [self._trade(ix, t, closed=True) for t in st.get("closed", [])]
            if st.get("open") and day == self.today() and st["open"].get("entryAt"):
                rows.append(self._trade(ix, st["open"], closed=False))
        return sorted(rows, key=lambda r: r["entryAt"] or "")

    @staticmethod
    def _trade(ix, t, closed):
        return {"setup": t.get("setup") or "", "side": t.get("side"), "instrument": t.get("option") or f"{ix} {t.get('side')}",
                "lots": t.get("lots") or oib_cfg.LOTS, "entryAt": (t.get("entryAt") or "")[:5] or None,
                "entryPrice": t.get("entryPrice"), "exitAt": ((t.get("exitAt") or "")[:5] or None) if closed else None,
                "exitPrice": t.get("exitPrice") if closed else None, "spotIn": t.get("entrySpotLive") or t.get("entrySpot"),
                "spotOut": t.get("exitSpot") if closed else None, "pnl": t.get("pnl") if closed else None,
                "note": f"{trade_points(t):+.2f} pts · {t.get('exitReason') or ''}" if closed else "open"}

    def reports(self, from_day, to_day):
        r = range_report(self.algo.store, from_day, to_day, None, self.algo.variant)
        days = [{"date": d["trade_date"], "realized": d["gross_pnl"] or 0.0, "charges": d["charges"] or 0.0,
                 "net": d["net_pnl"] or 0.0, "trades": d["entries"], "wins": d["wins"], "losses": d["losses"]}
                for d in r["days"]]
        return days, [t["pnl"] for t in r["trades"] if t.get("pnl") is not None]

    def settings_view(self):
        return self.settings.view(KEEP_NOTE + " The live variant and the shadows use the same values.")

    def save_settings(self, changes, user):
        now = self.algo.clock()
        with self.algo.lock:
            diff = self.settings.change(changes, user, now)
            apply_oib(self.settings.values())
        label = {f["key"]: f["label"] for f in self.settings.fields}
        for k, (old, new) in diff.items():
            self.algo.record("*", "settings", f"Setting {label[k]}: {shown(old)} -> {shown(new)}" + (f" (by {user})" if user else "")
                             + "; open trades keep their stop and lots", now=now, data={"key": k, "old": old, "new": new})

    def stop(self, exit_all, user):
        self.algo.stop(exit_all=exit_all, who=user)

    def resume(self, user):
        self.algo.resume(who=user)
