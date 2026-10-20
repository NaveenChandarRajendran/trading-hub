"""
calc.py - pure Trending OI formulas. No network, no files, no clock.

Formulas verified against the OI Pulse screenshot (BANKNIFTY, 2026-10-16, 5-min rows):
    call_chg   = sum over chosen strikes of (CE oi - CE previous_oi)
    put_chg    = sum over chosen strikes of (PE oi - PE previous_oi)
    diff       = put_chg - call_chg
    strength % = diff / max(call_chg, put_chg) * 100
    net PCR    = put_chg / call_chg
    sentiment  = Bullish if diff > 0 else Bearish
    chng in direction = diff - previous row's diff
    direction %       = chng in direction / |previous row's diff| * 100
    The FIRST row of the day has previous diff = 0 (so chng in direction = diff, % = 0).

NOT verified against a screen (check them live, see README):
    * LTP columns: total LTP = sum of last_price; LTP chng = sum of (last_price - previous_close_price)
    * Day H/L Break: computed from the index spot of the stored rows only
    * Strength when call_chg and put_chg have different signs or are both negative
      (we divide by the larger ABSOLUTE value; identical to the verified formula when both are positive)
"""

OPEN_MINUTE = 9 * 60 + 15  # 09:15 IST


# ----------------------------------------------------------------- strikes
def pick_strikes(available, spot, step, each_side):
    """ATM +/- each_side strikes (by strike step), keeping only strikes present in the chain."""
    avail = sorted(set(float(k) for k in available))
    if not avail:
        return []
    atm = min(avail, key=lambda k: (abs(k - spot), k))
    present = set(avail)
    want = [atm + i * step for i in range(-each_side, each_side + 1)]
    return [k for k in want if k in present]


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def summarize(oc, strikes):
    """Totals over the fixed strike set for ONE snapshot.

    oc: {strike(float): {"ce": {...} | None, "pe": {...} | None}} using Dhan's field names.
    Returns (totals dict, number of strikes found in the chain).
    """
    t = dict(call_chg=0.0, put_chg=0.0, call_ltp=0.0, put_ltp=0.0, call_ltp_chg=0.0, put_ltp_chg=0.0)
    used = 0
    for k in strikes:
        leg = oc.get(k)
        if not leg:
            continue
        used += 1
        ce, pe = leg.get("ce") or {}, leg.get("pe") or {}
        t["call_chg"] += _f(ce.get("oi")) - _f(ce.get("previous_oi"))
        t["put_chg"] += _f(pe.get("oi")) - _f(pe.get("previous_oi"))
        t["call_ltp"] += _f(ce.get("last_price"))
        t["put_ltp"] += _f(pe.get("last_price"))
        t["call_ltp_chg"] += _f(ce.get("last_price")) - _f(ce.get("previous_close_price"))
        t["put_ltp_chg"] += _f(pe.get("last_price")) - _f(pe.get("previous_close_price"))
    return {k: round(v, 2) for k, v in t.items()}, used


# ---------------------------------------------------------------- intervals
def minutes_since_open(ts):
    """ts is 'YYYY-MM-DD HH:MM' (IST)."""
    return int(ts[11:13]) * 60 + int(ts[14:16]) - OPEN_MINUTE


def is_aligned(ts, interval):
    """Row time R is shown when the bar that starts at R - interval has closed.
    So 5-min rows are 09:20, 09:25 ... and 15-min rows are 09:30, 09:45 ... (no 09:15 row)."""
    d = minutes_since_open(ts)
    return d >= interval and d % interval == 0


def select_for_interval(snaps, interval):
    """Pick the snapshots for an interval view. If the newest snapshot is not on the grid it is
    appended as a 'live' row (like OI Pulse's top row at 10:43). Returns (snapshots, live_flag)."""
    rows = [s for s in snaps if is_aligned(s["ts"], interval)]
    live = bool(snaps) and (not rows or snaps[-1]["ts"] > rows[-1]["ts"])
    if live:
        rows.append(snaps[-1])
    return rows, live


# --------------------------------------------------------------------- rows
def build_rows(snaps):
    """snaps oldest -> newest. Returns row dicts oldest -> newest (caller reverses for display)."""
    out = []
    prev_diff = None
    hi_spot = lo_spot = hi_diff = lo_diff = None
    for s in snaps:
        cc, pc = s["call_chg"], s["put_chg"]
        diff = pc - cc
        denom = max(abs(cc), abs(pc))
        strength = diff / denom * 100 if denom else 0.0
        pcr = pc / cc if cc else None

        if prev_diff is None:
            chg, pct = diff, 0.0
        else:
            chg = diff - prev_diff
            pct = chg / abs(prev_diff) * 100 if prev_diff else 0.0

        spot = s["spot"]
        spot_break = None
        if hi_spot is not None:
            if spot > hi_spot:
                spot_break = {"type": "DHB", "level": hi_spot}  # level = the old high that was broken
            elif spot < lo_spot:
                spot_break = {"type": "DLB", "level": lo_spot}

        diff_break = None
        if hi_diff is not None:
            if diff > hi_diff:
                diff_break = "HIGH"
            elif diff < lo_diff:
                diff_break = "LOW"

        out.append({
            "ts": s["ts"],
            "ltp": spot,
            "dayHLBreak": spot_break,
            "callChg": round(cc),
            "putChg": round(pc),
            "diffOi": round(diff),
            "strengthPct": round(strength, 2),
            "directionChg": round(chg),
            "directionPct": round(pct, 2),
            "callLtpTotal": s["call_ltp"],
            "putLtpTotal": s["put_ltp"],
            "callLtpChg": s["call_ltp_chg"],
            "putLtpChg": s["put_ltp_chg"],
            "cePeLtpChg": round(s["call_ltp_chg"] + s["put_ltp_chg"], 2),
            "netPcr": None if pcr is None else round(pcr, 2),
            "dayHLDiffBreak": diff_break,
            "sentiment": "Bullish" if diff > 0 else "Bearish",
            "strikesUsed": s.get("strikes_used"),
        })

        prev_diff = diff
        hi_spot = spot if hi_spot is None else max(hi_spot, spot)
        lo_spot = spot if lo_spot is None else min(lo_spot, spot)
        hi_diff = diff if hi_diff is None else max(hi_diff, diff)
        lo_diff = diff if lo_diff is None else min(lo_diff, diff)
    return out
