"""
bt_data.py - past market data for the backtest (backtest.py), downloaded once from Dhan's Data API and cached in
data/backtest/. READ ONLY: market data, no orders.

What Dhan gives (checked 25-Oct-2026 with the owner's token, docs dhanhq.co/docs/v2):
- index 1-minute candles (NIFTY 13, BANKNIFTY 25, INDIA VIX 21) for the last 5 years, up to 90 days per call;
- expired / live option prices per minute "rolling" by moneyness (ATM, ATM+1 ...: the strike changes as spot moves;
  each row carries the strike), up to ATM +/- 10 near expiry, 30 days per call, last 5 years, with OI, IV and spot;
- NO intraday data for expired futures (daily only), so the backtest uses the index where the live rule reads futures.
Files: data/backtest/idx_<SYM>_<from>.json.gz and opt_<SYM>_<CALL|PUT>_<offset>_<from>.json.gz (arrays per field).
A window is downloaded again only if its file is missing or it ends today or later.
"""
import gzip
import json
import os
import time
from datetime import date, timedelta

from dhan_client import DhanError, TokenExpired

ROOT = os.path.join("data", "backtest")
START = date(2021, 11, 1)  # Dhan keeps 5 years
IDX = {"NIFTY": 13, "BANKNIFTY": 25, "VIX": 21}
BN_MONTHLY_FROM = date(2024, 11, 20)  # BANKNIFTY weekly options ended (SEBI, Nov 2024): monthly only after
OFFSETS = {"CALL": range(-6, 5), "PUT": range(-4, 7)}  # ITM side deeper (Dharani buys a ~Rs 250 / 500 premium)


def strike_code(off):
    return "ATM" if off == 0 else f"ATM{off:+d}"


def _path(name):
    return os.path.join(ROOT, name + ".json.gz")


def save(name, data):
    os.makedirs(ROOT, exist_ok=True)
    tmp = _path(name) + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, _path(name))


def load(name):
    try:
        with gzip.open(_path(name), "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def windows(start, end, days):
    """[from, to) windows of at most `days` days covering start..end (end exclusive)."""
    out, d = [], start
    while d < end:
        e = min(d + timedelta(days=days), end)
        out.append((d, e))
        d = e
    return out


def half_months(start, end):
    """[from, to) windows: 1st-16th and 16th-1st of each month (each under Dhan's 30-day limit)."""
    out, d = [], start
    while d < end:
        mid = d.replace(day=16)
        nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
        e = mid if d < mid else nxt
        out.append((d, min(e, end)))
        d = e
    return out


def _call(client, path, body, tries=4):
    for k in range(tries):
        try:
            return client._post(path, body, gap=0.3)
        except TokenExpired:
            raise
        except DhanError as e:
            if k == tries - 1:
                raise
            time.sleep(2 * (k + 1))
            if "429" in str(e):
                time.sleep(5)


def download(client, today, symbols=("NIFTY", "BANKNIFTY"), log=print):
    """Fills the cache. Returns (calls made, windows skipped as cached)."""
    calls = skipped = 0
    end = today  # up to yesterday (end exclusive)
    jobs = []
    for sym in list(symbols) + ["VIX"]:
        for frm, to in windows(START, end, 89):
            jobs.append(("idx", sym, frm, to, None, None))
    for sym in symbols:
        for frm, to in half_months(START, end):
            parts = [(frm, to)]
            if sym == "BANKNIFTY" and frm < BN_MONTHLY_FROM < to:
                parts = [(frm, BN_MONTHLY_FROM), (BN_MONTHLY_FROM, to)]
            for a, b in parts:
                for side, offs in OFFSETS.items():
                    for off in offs:
                        jobs.append(("opt", sym, a, b, side, off))
    total = len(jobs)
    for n, (kind, sym, frm, to, side, off) in enumerate(jobs, 1):
        name = f"idx_{sym}_{frm}" if kind == "idx" else f"opt_{sym}_{side}_{off}_{frm}"
        if to < today and os.path.exists(_path(name)):
            skipped += 1
            continue
        if kind == "idx":
            p = _call(client, "/charts/intraday", {"securityId": str(IDX[sym]), "exchangeSegment": "IDX_I", "instrument": "INDEX",
                      "interval": "1", "oi": False, "fromDate": f"{frm} 09:15:00", "toDate": f"{to} 09:15:00"})
            data = {k: (p or {}).get(k) or [] for k in ("timestamp", "open", "high", "low", "close", "volume")}
        else:
            flag = "MONTH" if sym == "BANKNIFTY" and frm >= BN_MONTHLY_FROM else "WEEK"
            p = _call(client, "/charts/rollingoption", {
                "exchangeSegment": "NSE_FNO", "interval": "1", "securityId": IDX[sym], "instrument": "OPTIDX",
                "expiryFlag": flag, "expiryCode": 1, "strike": strike_code(off), "drvOptionType": side,
                "requiredData": ["open", "high", "low", "close", "strike"],
                "fromDate": str(frm), "toDate": str(to)})
            d = ((p or {}).get("data") or {}).get("ce" if side == "CALL" else "pe") or {}
            data = {k: d.get(k) or [] for k in ("timestamp", "open", "high", "low", "close", "strike")}
            data["expiryFlag"] = flag
        save(name, data)
        calls += 1
        if calls % 25 == 0 or n == total:
            log(f"  downloaded {n} of {total} pieces ({skipped} already saved)")
    return calls, skipped


def index_minutes(sym):
    """All cached 1-minute candles of an index, ascending, de-duplicated: dict of lists."""
    rows = {}
    for f in sorted(os.listdir(ROOT)) if os.path.isdir(ROOT) else []:
        if f.startswith(f"idx_{sym}_") and f.endswith(".json.gz"):
            d = load(f[:-8]) or {}
            for i, t in enumerate(d.get("timestamp") or []):
                rows[int(t)] = (d["open"][i], d["high"][i], d["low"][i], d["close"][i], (d.get("volume") or [0] * (i + 1))[i] or 0)
    ts = sorted(rows)
    return {"t": ts, "o": [rows[t][0] for t in ts], "h": [rows[t][1] for t in ts], "l": [rows[t][2] for t in ts],
            "c": [rows[t][3] for t in ts], "v": [rows[t][4] for t in ts]}


class OptionPrices:
    """Fixed-strike option prices rebuilt from the ATM-relative series of one half-month window:
    minute -> {strike: (open, high, low, close)} per side. Loaded lazily, one window at a time."""

    def __init__(self, sym):
        self.sym = sym
        self._win, self._data = None, {}

    def _ensure(self, day):
        frm = day.replace(day=1) if day.day < 16 else day.replace(day=16)
        if self.sym == "BANKNIFTY" and frm < BN_MONTHLY_FROM <= day:
            frm = BN_MONTHLY_FROM
        if self._win == frm:
            return
        self._win, self._data = frm, {"CALL": {}, "PUT": {}}
        for side, offs in OFFSETS.items():
            for off in offs:
                d = load(f"opt_{self.sym}_{side}_{off}_{frm}")
                if not d:
                    continue
                m = self._data[side]
                for i, t in enumerate(d["timestamp"]):
                    k = d["strike"][i]
                    if k:
                        m.setdefault(int(t), {})[float(k)] = (d["open"][i], d["high"][i], d["low"][i], d["close"][i], off)

    def at(self, day, side, minute_ts):
        """{strike: (o, h, l, c, offset)} for that minute (empty if Dhan has no row)."""
        self._ensure(day)
        return self._data["CALL" if side == "CE" else "PUT"].get(int(minute_ts), {})
