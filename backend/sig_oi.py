"""
sig_oi.py - the OI views the signal engine reads, ported line by line from the frontend apps. Pure.

Input is the GET /api/option-chain body (chain_cache.chain_response): {"meta": {symbol, spot, lotSize, ...}, "rows": [...]}
with Dhan's raw legs (units). The frontend formulas these mirror (keep them in step when one changes):

    oi_change_view   OI & OI Change Live = option-strategy/logic/oiCalculation.ts analyzeOptionChain on
                     shared/dhan/chainAdapter.ts toOptionChain (OI in contracts = units / lot size).
                     Verdict: final average (mean of the ATM +/- 5/10/15/20/25 window averages) vs spot.
                     PCR = (put OI + put change) / (call OI + call change), all strikes.
    sensibull_view   Sensibull OI Change Live = sensibull-oi/logic/sensibullCalc.ts analyzeSnapshot on toSbSnapshot,
                     cut to ATM +/- 25 (sensibull-oi-live range.ts), metric "change", windows 10 + 20.
                     Record only: shown and logged, never part of a rule tick (owner, 23-Oct-2026).
    sr_view          OI Support & Resistance Live = oi-support-resistance/logic/levels.ts analyzeChain + topLevels:
                     R1-R3 = biggest call OI from spot to spot + 500, S1-S3 = biggest put OI from spot - 500 to below
                     spot, numbered nearest first. PCR = total put OI / total call OI. Max pain.
"""
INTERVAL_BY_SYMBOL = {"BANKNIFTY": 100, "NIFTY": 50}
OI_WINDOWS = (5, 10, 15, 20, 25)
SB_RANGE = 25
SB_WINDOWS = (5, 10, 15, 20, 25)
SB_DEFAULT = (10, 20)
SR_RANGE = 500
SR_NEAR_WINDOW = 1500
SR_COUNT = 3
LAKH = 100000.0


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f else 0.0  # NaN -> 0


def _div(a, b):
    return 0.0 if b == 0 else a / b


def _mean(xs):
    xs = list(xs)
    return _div(sum(xs), len(xs))


def _nearest_index(values, target):
    best = 0
    for i, v in enumerate(values):
        if abs(v - target) < abs(values[best] - target):
            best = i
    return best


def _rows(body):
    return sorted((r for r in body.get("rows", []) if _num(r.get("strike")) > 0), key=lambda r: _num(r["strike"]))


# ------------------------------------------------------------------ OI & OI Change
def oi_change_view(body):
    meta = body["meta"]
    lot = meta.get("lotSize") or 1
    lot = lot if lot > 0 else 1
    spot = _num(meta.get("spot"))
    interval = INTERVAL_BY_SYMBOL.get(meta.get("symbol"), 100)
    rows = []
    for r in _rows(body):
        ce, pe = r.get("ce") or {}, r.get("pe") or {}
        call_oi, put_oi = _num(ce.get("oi")) / lot, _num(pe.get("oi")) / lot
        call_chg = (_num(ce.get("oi")) - _num(ce.get("previous_oi"))) / lot if r.get("ce") else 0.0
        put_chg = (_num(pe.get("oi")) - _num(pe.get("previous_oi"))) / lot if r.get("pe") else 0.0
        call_net, put_net = call_oi + call_chg, put_oi + put_chg
        net = call_net + put_net
        call_pct = _div(call_net, net)
        rows.append({"strike": _num(r["strike"]), "callOi": call_oi, "callChg": call_chg, "callNet": call_net,
                     "putOi": put_oi, "putChg": put_chg, "putNet": put_net, "average": _num(r["strike"]) - call_pct * interval})
    if not rows:
        return None
    atm = _nearest_index([x["strike"] for x in rows], spot)
    windows = []
    for n in OI_WINDOWS:
        part = rows[max(0, atm - n):min(len(rows) - 1, atm + n) + 1]
        windows.append({"n": n, "from": part[0]["strike"], "to": part[-1]["strike"], "strikes": len(part),
                        "average": _mean(x["average"] for x in part)})
    final = _mean(w["average"] for w in windows)
    points = final - spot
    tot = lambda k: sum(x[k] for x in rows)  # noqa: E731
    return {
        "verdict": "Bullish" if points > 0 else "Bearish" if points < 0 else "Neutral",
        "average": final, "points": points, "spot": spot,
        "pcr": _div(tot("putNet"), tot("callNet")),
        "callOi": tot("callOi"), "callChg": tot("callChg"), "putOi": tot("putOi"), "putChg": tot("putChg"),
        "windows": windows, "unit": "contracts",
        # owner 26-Oct-2026: the "lean" next to the verdict (share of puts in OI + change) and where spot sits vs the ATM strike
        "atm": rows[atm]["strike"], "putShare": _div(tot("putNet") * 100, tot("putNet") + tot("callNet")),
    }


# ------------------------------------------------------------------ Sensibull OI Change
def sensibull_view(body, range_=SB_RANGE, picked=SB_DEFAULT):
    meta = body["meta"]
    spot = _num(meta.get("spot"))
    symbol = meta.get("symbol")
    # from = the 09:15 OI like Sensibull ("open_oi", chain_cache.OpeningOi); previous-day settled OI if not recorded
    base = lambda leg: _num(leg.get("open_oi") if leg.get("open_oi") is not None else leg.get("previous_oi"))  # noqa: E731
    strikes = [{"strike": _num(r["strike"]),
                "fromCall": base(r.get("ce") or {}), "fromPut": base(r.get("pe") or {}),
                "toCall": _num((r.get("ce") or {}).get("oi")), "toPut": _num((r.get("pe") or {}).get("oi"))}
               for r in _rows(body)]
    if not strikes:
        return None
    atm_strike = strikes[_nearest_index([s["strike"] for s in strikes], spot)]["strike"]
    # limitRange: R strikes below ATM, ATM, R above
    a = next(i for i, s in enumerate(strikes) if s["strike"] == atm_strike)
    strikes = strikes[max(0, a - range_):a + range_ + 1]
    step = strikes[1]["strike"] - strikes[0]["strike"] if len(strikes) > 1 else 100
    interval = INTERVAL_BY_SYMBOL.get(symbol, step)
    blocks = []
    for s in strikes:
        put, call = (s["toPut"] - s["fromPut"]) / LAKH, (s["toCall"] - s["fromCall"]) / LAKH
        total = put + call
        put_pct = _div(put, total)
        blocks.append({"strike": s["strike"], "put": put, "call": call, "average": s["strike"] - put_pct * interval})
    atm = _nearest_index([b["strike"] for b in blocks], atm_strike)
    max_r = max(1, min(atm + 1, len(blocks) - 1 - atm))
    sizes = [n for n in SB_WINDOWS if n <= max_r] or [max_r]

    def window(n):
        part = blocks[max(0, atm - (n - 1)):min(len(blocks) - 1, atm + n) + 1]
        put, call = sum(b["put"] for b in part), sum(b["call"] for b in part)
        return {"n": n, "from": part[0]["strike"], "to": part[-1]["strike"], "put": put, "call": call,
                "pcr": _div(call, put), "average": _mean(b["average"] for b in part)}

    windows = [window(n) for n in sizes]
    default = [n for n in SB_DEFAULT if n in sizes]
    if len(default) < 2 and max(sizes) not in default:
        default.append(max(sizes))
    used = [n for n in picked if n in sizes] or sorted(default)
    chosen = [w for w in windows if w["n"] in used]
    anticipated = _mean(w["average"] for w in chosen)
    points = anticipated - spot
    return {
        "verdict": "Bullish" if points > 0 else "Bearish" if points < 0 else "Neutral",
        "average": anticipated, "points": points, "spot": spot,
        "support": anticipated - interval, "resistance": anticipated + interval,
        "pcr": _mean(w["pcr"] for w in chosen), "used": used, "unit": "lakh units",
        "since": meta.get("openOiAt") or "previous close",  # what the change in OI counts from
    }


# ------------------------------------------------------------------ OI Support & Resistance
def max_pain(oi):
    """oi: {strike: (call OI, put OI)}. Strike with the smallest total payout to option buyers; ties keep the lowest."""
    strikes = sorted(oi)
    best, low = None, float("inf")
    for x in strikes:
        pain = sum((x - s) * oi[s][0] for s in strikes if x > s) + sum((s - x) * oi[s][1] for s in strikes if x < s)
        if pain < low:
            best, low = x, pain
    return best


def top_levels(rows, spot, side, range_=SR_RANGE, count=SR_COUNT):
    i = 0 if side == "R" else 1
    if side == "R":
        cands = [k for k in rows if spot <= k <= spot + range_]
    else:
        cands = [k for k in rows if spot - range_ <= k < spot]
    picked = sorted(sorted(cands), key=lambda k: -rows[k][i])[:count]  # biggest OI; stable for ties (lower strike)
    picked.sort(reverse=(side == "S"))
    return [{"strike": k, "oi": rows[k][i]} for k in picked]


def sr_view(body, range_=SR_RANGE):
    meta = body["meta"]
    lot = meta.get("lotSize") or 1
    lot = lot if lot > 0 else 1
    spot = _num(meta.get("spot"))
    all_oi, near = {}, {}
    tot_ce = tot_pe = 0.0
    for r in _rows(body):
        k = _num(r["strike"])
        co, po = _num((r.get("ce") or {}).get("oi")) / lot, _num((r.get("pe") or {}).get("oi")) / lot
        all_oi[k] = (co, po)
        tot_ce += co
        tot_pe += po
        if abs(k - spot) <= SR_NEAR_WINDOW:
            near[k] = (co, po)
    if not near:
        return None
    levels = {"R": top_levels(near, spot, "R", range_), "S": top_levels(near, spot, "S", range_)}
    above = [k for k in near if k > spot]
    below = [k for k in near if k < spot]
    big_call = max(above, key=lambda k: (near[k][0], -k)) if above else None
    big_put = max(below, key=lambda k: (near[k][1], k)) if below else None
    return {
        "spot": spot, "levels": levels, "pcr": (tot_pe / tot_ce) if tot_ce else None, "maxPain": max_pain(all_oi),
        "biggestCallAbove": {"strike": big_call, "oi": near[big_call][0]} if big_call is not None else None,
        "biggestPutBelow": {"strike": big_put, "oi": near[big_put][1]} if big_put is not None else None,
        "unit": "contracts",
    }


# ------------------------------------------------------------------ Trending OI as a third view
def trending_view(rows):
    """Trending OI as a third OI view for the dashboard card (rows: completed 5-min rows, newest first). Verdict uses the
    rule's threshold: every one of the last N rows at +strength or more = Bullish, at -strength or less = Bearish,
    otherwise Neutral. Record only here; the Trading Hub rule applies the same test itself."""
    import sig_rules
    th, n = sig_rules.TH_TOI_STRENGTH, int(sig_rules.TH_TOI_ROWS)
    last = (rows or [])[:n]
    if not last:
        return None
    if len(last) == n and all(r["strengthPct"] >= th for r in last):
        verdict = "Bullish"
    elif len(last) == n and all(r["strengthPct"] <= -th for r in last):
        verdict = "Bearish"
    else:
        verdict = "Neutral"
    r0 = last[0]
    return {"verdict": verdict, "time": r0.get("time"), "strength": [r["strengthPct"] for r in last], "threshold": th,
            "callChg": r0.get("callChg"), "putChg": r0.get("putChg"), "pcr": r0.get("netPcr"), "unit": "units"}


def votes(*views):
    """'3 of 3 Bearish', '2 of 3 Bearish', ... over the views that have a verdict."""
    vs = [v["verdict"] for v in views if v]
    if not vs:
        return None
    top = max(set(vs), key=vs.count)
    return f"{vs.count(top)} of {len(vs)} {top}"
