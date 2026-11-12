"""
algo_adapters.py - each algo behind the common Algos hub API (algos_api.py). An adapter only reads the algo's own
records and calls its own service: no trading logic lives here.

Common shapes:
  summary   {name, category, state: running | stopped | stale | closed | off | token | error, stateText, halted,
             todayPnl, mtdPnl, open (one line) | None, lastEvent {ts, text} | None}
  event     {id, ts, type, side, variant, setup, message}
  trade     {setup, side, instrument, lots, entryAt, entryPrice, exitAt, exitPrice, spotIn, spotOut, pnl, note}
  day row   {date, realized, charges, net, trades, wins, losses}
  settings  {editable, fields [{key, label, group, kind: number | int | time | list, value, default}], history
             [{ts, key, old, new, user, message}]}
"""
import toi_algo_logic as TL
import trending_oi_algo_config as toi_cfg

TOI_FIELDS = [  # (group, key, label): the Trending OI Algo's settings on the page
    ("Direction & no-trade", "toiStrengthMin", "Trending OI strength min %"), ("Direction & no-trade", "toiDotsMin", "Strength dots min"),
    ("Direction & no-trade", "flipLookbackMin", "No trade after a flip (min)"), ("Direction & no-trade", "weakDayFrom", "Weak-day check from"),
    ("Direction & no-trade", "weakDayRangePct", "Weak day: range below %"), ("Direction & no-trade", "maxVwapDistPct", "Over-extended: from VWAP %"),
    ("Direction & no-trade", "rsiMaxCE", "RSI max for CE"), ("Direction & no-trade", "rsiMinPE", "RSI min for PE"),
    ("Entry & stop", "touchPts", "Pullback within (pts)"), ("Entry & stop", "entryLots", "Entry lots"),
    ("Entry & stop", "maxStopPct", "Skip when stop beyond %"), ("Entry & stop", "entryFrom", "Entries from"),
    ("Entry & stop", "entryTo", "Entries until"), ("Entry & stop", "maxTrades", "Trades per day"),
    ("Entry & stop", "dayLossStopPct", "Day loss stop % of capital"),
    ("Adds", "avgAddLots", "Averaging adds (lots)"), ("Adds", "avgMaxLots", "Averaging up to (lots)"),
    ("Adds", "pyrAddLots", "Pyramiding adds (lots)"), ("Adds", "pyrMaxLots", "Pyramiding up to (lots)"),
    ("Adds", "maxLots", "Never more than (lots)"), ("Adds", "addRiskMax", "Risk guard (₹)"), ("Adds", "deltaFallback", "Delta without chain data"),
    ("Exits & indicators", "partialMinPts", "Partial level at least (pts)"), ("Exits & indicators", "breakevenAtR", "Breakeven at (R) without levels"),
    ("Exits & indicators", "squareOff", "Square-off"), ("Exits & indicators", "candleMin", "Candle timeframe (3 or 5 min)"),
    ("Exits & indicators", "supertrendPeriod", "Supertrend period"), ("Exits & indicators", "supertrendMult", "Supertrend factor"),
    ("Exits & indicators", "rsiPeriod", "RSI period"), ("Strike", "strikeFallback", "After 1 ITM, try"),
]


def iso(ts):
    return ts.isoformat() if hasattr(ts, "isoformat") else ts


def kind_of(default):
    if isinstance(default, list):
        return "list"
    if isinstance(default, str):
        return "time"
    if isinstance(default, int) and not isinstance(default, bool):
        return "int"
    return "number"


def state_of(mode, market_open, halted, stale, token):
    if mode == "off":
        return "off", "Off"
    if token:
        return "token", "Dhan token expired"
    if not market_open:
        return "closed", "Market closed"
    if halted:
        return "stopped", "Stopped (no new entries)"
    if stale:
        return "stale", "Feed stale"
    return "running", "Running"


class ToiAdapter:
    slug, name, category, rules_doc = "trending-oi", toi_cfg.STRATEGY_NAME, "intraday", "trending-oi-algo"

    def __init__(self, svc):
        self.svc = svc

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
        month = self.today()[:7] + "-01"
        before = sum(r["net_pnl"] for r in self.svc.toi.summaries(month, self.today()) if r["day"] < self.today())
        o = st.get("open")
        open_line = (f"{o['side']} {TL.fmt(o.get('strike'))} × {o['lots']} lot{'s' if o['lots'] != 1 else ''} · stop index "
                     f"{o['stop']['dir']} {TL.fmt(o['stop']['price'])}") if o else None
        events = self.events(self.today())
        last = next((e for e in events if e["type"] != "heartbeat"), None)
        return {"name": self.name, "category": self.category, "state": state, "stateText": text, "halted": s["halted"],
                "todayPnl": round(today, 2), "mtdPnl": round(before + today, 2), "open": open_line,
                "lastEvent": last and {"ts": last["ts"], "text": last["message"]}}

    def events(self, day):
        """Newest first (by time, then id)."""
        rows = [{"id": e["id"], "ts": iso(e["ts"]), "type": e["type"], "side": e.get("side"), "variant": "", "setup": "",
                 "message": e["message"]} for e in self.svc.toi.events(day)]
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
        cur = self.svc.settings()
        fields = [{"key": k, "label": label, "group": g, "kind": kind_of(toi_cfg.DEFAULTS[k]), "value": cur[k],
                   "default": toi_cfg.DEFAULTS[k]} for g, k, label in TOI_FIELDS]
        hist = [{"ts": iso(e["ts"]), "key": e["details"].get("key"),
                 "old": e["details"].get("old"), "new": e["details"].get("new"),
                 "user": (e["message"].split("(by ")[1].split(")")[0] if "(by " in e["message"] else ""), "message": e["message"]}
                for e in self.svc.toi.settings_history()]
        return {"editable": True, "fields": fields, "history": hist,
                "note": "New decisions use these at once; an open trade keeps the stop and lots it was opened with."}

    def save_settings(self, changes, user):
        from toi_algo_api import check_settings
        from fastapi import HTTPException
        try:
            clean = check_settings(changes)
        except HTTPException as e:
            raise ValueError(e.detail) from None
        self.svc.set_settings(clean, who=user)

    def stop(self, exit_all, user):
        self.svc.stop(exit_all=exit_all, who=user)

    def resume(self, user):
        self.svc.resume(who=user)
