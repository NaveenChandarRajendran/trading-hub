"""
orderflow.py - ESTIMATED order flow (buy / sell volume, delta, cumulative delta) for the near-month index futures.

Dext (Dhan's order-flow tool) has no export or API, and Dhan's data API has no aggressor side (owner, 23-Oct-2026). So
delta is estimated from the live feed's Full packets of the future:
    traded qty since the last packet = day volume now - day volume at the previous packet
    side: price at or above the previous best ask -> buy; at or below the previous best bid -> sell;
          in between -> tick rule (up from the last price -> buy, down -> sell, unchanged -> same side as the last trade)
    per IST minute: buy, sell, delta = buy - sell; cumulative delta = running sum over the day.
Minutes when the backend was not running are missing (no backfill). Several trades between two packets get one side.

The estimate is NOT used by the rules until it matches the owner's Dext readings most of the time
(autopaper.json orderFlow.useEstimatedDelta). The owner types Dext's per-candle delta for a few days; match = same sign.
Pure DeltaBuilder (tested) + OrderFlowStore (one JSON file per IST day in data/).
"""
import json
import os
import threading
from datetime import datetime

from candles import bucket_start, epoch, in_session
from sig_indicators import IST


class DeltaBuilder:
    def __init__(self):
        self._st = {}  # security id -> {"day", "vol", "ltp", "bid", "ask", "side"}
        self.minutes = {}  # security id -> {minute epoch: {"time", "buy", "sell", "close"}}

    def restore(self, security_id, minutes):
        self.minutes[security_id] = {m["time"]: dict(m) for m in minutes}

    def on_full(self, security_id, ltp, day_volume, bid, ask, now):
        """One Full packet of a future. Returns the updated minute dict or None."""
        if not ltp or day_volume is None or not in_session(now):
            return None
        day = now.astimezone(IST).date()
        st = self._st.get(security_id)
        if st is None or st["day"] != day or day_volume < st["vol"]:  # first packet, new day or a feed reset
            self._st[security_id] = {"day": day, "vol": day_volume, "ltp": ltp, "bid": bid, "ask": ask, "side": 0}
            return None
        qty = day_volume - st["vol"]
        side = 0
        if qty > 0:
            if st["ask"] and ltp >= st["ask"]:
                side = 1
            elif st["bid"] and ltp <= st["bid"]:
                side = -1
            elif ltp > st["ltp"]:
                side = 1
            elif ltp < st["ltp"]:
                side = -1
            else:
                side = st["side"]
        minute = epoch(bucket_start(now, 1))
        bars = self.minutes.setdefault(security_id, {})
        m = bars.setdefault(minute, {"time": minute, "buy": 0, "sell": 0, "close": ltp})
        if side > 0:
            m["buy"] += qty
        elif side < 0:
            m["sell"] += qty
        m["close"] = ltp
        st.update(vol=day_volume, ltp=ltp, bid=bid or st["bid"], ask=ask or st["ask"], side=side or st["side"])
        return dict(m)

    def series(self, security_id, day=None):
        """This day's minutes (oldest first) with delta and cumulative delta."""
        rows = sorted(self.minutes.get(security_id, {}).values(), key=lambda m: m["time"])
        if day is not None:
            rows = [m for m in rows if datetime.fromtimestamp(m["time"], IST).date() == day]
        out, cum = [], 0
        for m in rows:
            d = m["buy"] - m["sell"]
            cum += d
            out.append({**m, "delta": d, "cumulative": cum})
        return out


def aggregate_flow(minutes, interval):
    """Per-minute flow -> interval candles (09:15-aligned), summing buy / sell; cumulative = value at the bucket's end."""
    out = []
    for m in minutes:
        start = epoch(bucket_start(datetime.fromtimestamp(m["time"], IST), interval))
        if out and out[-1]["time"] == start:
            o = out[-1]
            o["buy"] += m["buy"]
            o["sell"] += m["sell"]
            o["delta"] = o["buy"] - o["sell"]
            o["cumulative"], o["close"] = m["cumulative"], m["close"]
        else:
            out.append({"time": start, "buy": m["buy"], "sell": m["sell"], "delta": m["buy"] - m["sell"],
                        "cumulative": m["cumulative"], "close": m["close"]})
    return out


def dext_match(estimated, typed):
    """Same sign = match. None when nothing was typed."""
    if typed is None:
        return None
    return (estimated > 0 and typed > 0) or (estimated < 0 and typed < 0) or (estimated == 0 and typed == 0)


class OrderFlowStore:
    """Today's minutes per future and the owner's typed Dext values, in data/orderflow_YYYY-MM-DD.json."""

    def __init__(self, data_dir="data"):
        self.data_dir = data_dir
        self.lock = threading.Lock()

    def path(self, day):
        return os.path.join(self.data_dir, f"orderflow_{day}.json")

    def load(self, day):
        try:
            return json.load(open(self.path(day), encoding="utf-8"))
        except (OSError, ValueError):
            return {"minutes": {}, "dext": {}}

    def save(self, day, data):
        with self.lock:
            os.makedirs(self.data_dir, exist_ok=True)
            tmp = self.path(day) + ".tmp"
            json.dump(data, open(tmp, "w", encoding="utf-8"))
            os.replace(tmp, self.path(day))


class OrderFlowService:
    """Feeds the DeltaBuilder from the paper service's feed and serves the series to the dashboard and the watcher."""

    def __init__(self, store, futures, clock=lambda: datetime.now(IST)):
        self.store, self.futures, self.clock = store, futures, clock  # futures: symbol -> near future dict or None
        self.builder = DeltaBuilder()
        self._day = None
        self._last_save = 0.0
        self.dext = {}

    def _ensure_day(self):
        day = self.clock().date()
        if self._day == day:
            return
        self._day = day
        data = self.store.load(day.isoformat())
        self.builder = DeltaBuilder()
        for sid, mins in data.get("minutes", {}).items():
            self.builder.restore(int(sid), mins)
        self.dext = data.get("dext", {})

    def future_ids(self):
        out = {}
        for sym in ("NIFTY", "BANKNIFTY"):
            try:
                f = self.futures(sym)
            except Exception:
                f = None
            if f:
                out[sym] = f
        return out

    def on_packet(self, security_id, pkt, prev_book):
        """Called by the paper service for every Full packet of an index future."""
        self._ensure_day()
        bid = prev_book.best_bid if prev_book else None
        ask = prev_book.best_ask if prev_book else None
        now = self.clock()
        if self.builder.on_full(security_id, pkt.get("ltp"), pkt.get("volume"), bid, ask, now) and now.timestamp() - self._last_save > 30:
            self._last_save = now.timestamp()
            self.save()

    def save(self):
        futs = {str(f["securityId"]): {"symbol": sym, "name": f["name"]} for sym, f in self.future_ids().items()}
        data = {"minutes": {str(sid): list(m.values()) for sid, m in self.builder.minutes.items()}, "dext": self.dext,
                "futures": futs}
        try:
            self.store.save(self._day.isoformat(), data)
        except OSError:
            pass

    def series(self, symbol, interval=1, day=None):
        """(future, rows) for today, or for an earlier day saved on disk (the date picker)."""
        self._ensure_day()
        if day is not None and day != self._day:
            return self._past(symbol, interval, day)
        f = self.future_ids().get(symbol)
        if not f:
            return None, []
        mins = self.builder.series(f["securityId"], self._day)
        return f, (mins if interval == 1 else aggregate_flow(mins, interval))

    def _past(self, symbol, interval, day):
        data = self.store.load(day.isoformat())
        futs = data.get("futures", {})
        sid = next((k for k, v in futs.items() if v.get("symbol") == symbol), None)
        if sid is None:  # older file without the futures map: today's future of that index, if it was recorded
            f = self.future_ids().get(symbol)
            sid = str(f["securityId"]) if f else None
        if sid is None or sid not in data.get("minutes", {}):
            return None, []
        b = DeltaBuilder()
        b.restore(int(sid), data["minutes"][sid])
        mins = b.series(int(sid), day)
        f = {"securityId": int(sid), "name": futs.get(sid, {}).get("name", f"{symbol} future")}
        return f, (mins if interval == 1 else aggregate_flow(mins, interval))

    def days(self):
        """Days with a saved order flow file, newest first."""
        try:
            names = os.listdir(self.store.data_dir)
        except OSError:
            return []
        return sorted((n[10:20] for n in names if n.startswith("orderflow_") and n.endswith(".json")), reverse=True)

    def set_dext(self, symbol, interval, hhmm, value):
        self._ensure_day()
        key = f"{symbol}|{interval}|{hhmm}"
        if value is None:
            self.dext.pop(key, None)
        else:
            self.dext[key] = float(value)
        self.save()

    def typed(self, symbol, interval, day=None):
        self._ensure_day()
        dext = self.dext if day is None or day == self._day else self.store.load(day.isoformat()).get("dext", {})
        prefix = f"{symbol}|{interval}|"
        return {k[len(prefix):]: v for k, v in dext.items() if k.startswith(prefix)}
