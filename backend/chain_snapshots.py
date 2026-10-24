"""
chain_snapshots.py - one option-chain snapshot per tracked expiry per minute (written by the tracker during market
hours), so replays can check the OI filters on past days. Pure helpers; storage is in store.py.

Snapshot: {"ts": "YYYY-MM-DD HH:MM" (IST minute), "fetchedAt": ISO time, "spot": float,
           "columns": COLUMNS, "rows": [[strike, ce_oi, ce_prev_oi, ce_ltp, ce_prev_close, ce_volume, ce_iv,
                                         pe_oi, pe_prev_oi, pe_ltp, pe_prev_close, pe_volume, pe_iv], ...]}
ATM +/- EACH_SIDE strikes: 25, because OI & OI Change's verdict averages windows of up to 25 strikes each side
(the requested +/- 10 is inside it). OI in units, as Dhan sends it.
"""
EACH_SIDE = 25
LEG = ("oi", "previous_oi", "last_price", "previous_close_price", "volume", "implied_volatility")
COLUMNS = ["strike"] + [f"ce_{k}" for k in LEG] + [f"pe_{k}" for k in LEG]


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def make_snapshot(ts, fetched_at, spot, oc, each_side=EACH_SIDE):
    """A Dhan chain ({strike: {"ce": {...}, "pe": {...}}}) -> one snapshot of the ATM +/- each_side strikes."""
    strikes = sorted(float(k) for k in oc)
    if not strikes:
        return {"ts": ts, "fetchedAt": fetched_at, "spot": spot, "columns": COLUMNS, "rows": []}
    atm = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    keep = strikes[max(0, atm - each_side): atm + each_side + 1]
    by_strike = {float(k): v for k, v in oc.items()}
    rows = []
    for k in keep:
        v = by_strike[k]
        ce, pe = v.get("ce") or {}, v.get("pe") or {}
        rows.append([k] + [_num(ce.get(f)) for f in LEG] + [_num(pe.get(f)) for f in LEG])
    return {"ts": ts, "fetchedAt": fetched_at, "spot": spot, "columns": COLUMNS, "rows": rows}


def to_oc(snap):
    """Snapshot -> the Dhan chain shape the algo filters read ({strike: {"ce": {...}, "pe": {...}}})."""
    out = {}
    for r in snap["rows"]:
        ce = dict(zip(LEG, r[1:1 + len(LEG)]))
        pe = dict(zip(LEG, r[1 + len(LEG):]))
        out[r[0]] = {"ce": ce, "pe": pe}
    return out
