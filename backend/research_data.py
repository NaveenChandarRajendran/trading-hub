"""
research_data.py - fast day-by-day arrays for strategy_research.py, built once from the backtest cache (bt_data.py).
READ ONLY: market data, no orders.

Per symbol and trading day (09:15-15:29 IST = 375 one-minute slots):
  idx   : index o / h / l / c, shape (375, 4) (NaN where Dhan has no minute)
  vix   : India VIX close per slot (375,)
  atm   : {"CE": (375,), "PE": (375,)} the ATM strike (offset 0 of the nearest-expiry series) per slot
  opt   : {"CE": {strike: (375, 4)}, "PE": {...}} o / h / l / c of every strike that is ATM at some minute of the day;
          a minute with no row keeps the last close (as backtest.py does)
Saved as data/backtest/research_<SYM>.pkl (about 0.3-0.5 GB each; not in git). Rebuilt when missing.
"""
import os
import pickle
from datetime import datetime

import numpy as np

import bt_data
from sig_indicators import IST

SLOTS = 375
OFFSETS = range(-10, 11)


def slot_of(ts):
    dt = datetime.fromtimestamp(ts, IST)
    return dt.date(), dt.hour * 60 + dt.minute - 555


def _path(sym):
    return os.path.join(bt_data.ROOT, f"research_{sym}.pkl")


def build(sym, log=print):
    m = bt_data.index_minutes(sym)
    vm = bt_data.index_minutes("VIX")
    days = {}
    for i, t in enumerate(m["t"]):
        d, s = slot_of(t)
        if 0 <= s < SLOTS:
            a = days.setdefault(d, {"idx": np.full((SLOTS, 4), np.nan, dtype=np.float64), "vix": np.full(SLOTS, np.nan)})["idx"]
            a[s] = (m["o"][i], m["h"][i], m["l"][i], m["c"][i])
    for i, t in enumerate(vm["t"]):
        d, s = slot_of(t)
        if d in days and 0 <= s < SLOTS:
            days[d]["vix"][s] = vm["c"][i]
    # options, one half-month window at a time
    windows = {}
    for d in days:
        frm = d.replace(day=1) if d.day < 16 else d.replace(day=16)
        if sym == "BANKNIFTY" and frm < bt_data.BN_MONTHLY_FROM <= d:
            frm = bt_data.BN_MONTHLY_FROM
        windows.setdefault(frm, []).append(d)
    for n, (frm, ds) in enumerate(sorted(windows.items()), 1):
        raw = {"CE": {}, "PE": {}}  # day -> strike -> {slot: row}
        atm = {d: {"CE": np.full(SLOTS, np.nan), "PE": np.full(SLOTS, np.nan)} for d in ds}
        for side, dside in (("CALL", "CE"), ("PUT", "PE")):
            for off in OFFSETS:
                f = bt_data.load(f"opt2_{sym}_{side}_{off}_{frm}")
                if not f:
                    continue
                for i, t in enumerate(f["timestamp"]):
                    k = f["strike"][i]
                    if not k:
                        continue
                    d, s = slot_of(int(t))
                    if d not in atm or not 0 <= s < SLOTS:
                        continue
                    raw[dside].setdefault(d, {}).setdefault(float(k), {})[s] = (f["open"][i], f["high"][i], f["low"][i], f["close"][i])
                    if off == 0:
                        atm[d][dside][s] = float(k)
        for d in ds:
            days[d]["atm"] = atm[d]
            days[d]["opt"] = {}
            for side in ("CE", "PE"):
                keep = {k for k in np.unique(atm[d][side][~np.isnan(atm[d][side])])}
                out = {}
                for k in keep:
                    rows = raw[side].get(d, {}).get(k, {})
                    a = np.full((SLOTS, 4), np.nan)
                    last = np.nan
                    for s in range(SLOTS):
                        r = rows.get(s)
                        if r:
                            a[s] = r
                            last = r[3]
                        elif last == last:
                            a[s] = (last, last, last, last)
                    out[k] = a.astype(np.float32)
                days[d]["opt"][side] = out
        if n % 20 == 0:
            log(f"  {sym}: {n} of {len(windows)} windows")
    with open(_path(sym), "wb") as fh:
        pickle.dump(days, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return days


def load(sym, log=print):
    if os.path.exists(_path(sym)):
        with open(_path(sym), "rb") as fh:
            return pickle.load(fh)
    log(f"{sym}: building the research arrays from the backtest cache (once, a few minutes)...")
    return build(sym, log)


if __name__ == "__main__":
    import sys
    for s in sys.argv[1:] or ["NIFTY", "BANKNIFTY"]:
        d = load(s)
        print(s, len(d), "days")
