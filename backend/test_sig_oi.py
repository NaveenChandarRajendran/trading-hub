"""sig_oi.py = the frontend OI apps' formulas. Same real fixture and the same hand-worked checks as the frontend tests
(shared/dhan/chainAdapter.test.ts, oi-change-live, sensibull-oi-live, oi-support-resistance-live), worked from the raw
Dhan units in the file, not from the code under test."""
import json
import math
import os

from sig_oi import oi_change_view, sensibull_view, sr_view, top_levels

HERE = os.path.dirname(__file__)
FIX = os.path.join(HERE, "..", "frontend", "src", "shared", "dhan", "__fixtures__", "nifty-2026-10-21.json")
BODY = json.load(open(FIX))
ROWS = {r["strike"]: r for r in BODY["rows"]}
SPOT = 22811.35


def raw_average(strike):
    """OI & OI Change column I from raw units: strike - call share x 50 (lot size cancels out)."""
    r = ROWS[strike]
    call = 2 * r["ce"]["oi"] - r["ce"]["previous_oi"]
    put = 2 * r["pe"]["oi"] - r["pe"]["previous_oi"]
    return strike - call / (call + put) * 50


def test_oi_change_windows_pcr_and_verdict():
    v = oi_change_view(BODY)
    assert [w["strikes"] for w in v["windows"]] == [11, 21, 31, 41, 51]
    assert (v["windows"][0]["from"], v["windows"][0]["to"]) == (22550, 23050)
    w5 = sum(raw_average(k) for k in range(22550, 23051, 50)) / 11
    assert math.isclose(v["windows"][0]["average"], w5, abs_tol=1e-9)
    net = lambda k: sum(2 * (r[k] or {}).get("oi", 0) - (r[k] or {}).get("previous_oi", 0) for r in BODY["rows"])  # noqa: E731
    assert math.isclose(v["pcr"], net("pe") / net("ce"), rel_tol=1e-12)
    assert math.isclose(v["points"], v["average"] - SPOT, abs_tol=1e-9)
    assert v["verdict"] == ("Bullish" if v["points"] > 0 else "Bearish")


def test_oi_change_lot_size_only_scales_oi():
    units = oi_change_view({**BODY, "meta": {**BODY["meta"], "lotSize": 1}})
    v = oi_change_view(BODY)
    assert math.isclose(units["callOi"], v["callOi"] * 65, rel_tol=1e-12)
    assert math.isclose(units["average"], v["average"], abs_tol=1e-9)
    assert units["verdict"] == v["verdict"]


def test_sensibull_default_windows_and_anticipated():
    v = sensibull_view(BODY)
    assert v["used"] == [10, 20]

    def avg(k):
        r = ROWS[k]
        put = r["pe"]["oi"] - r["pe"]["previous_oi"]
        call = r["ce"]["oi"] - r["ce"]["previous_oi"]
        return k - put / (put + call) * 50

    def window(lo, hi):
        ks = [k for k in ROWS if lo <= k <= hi]
        return sum(avg(k) for k in ks) / len(ks)

    expected = (window(22350, 23300) + window(21850, 23800)) / 2  # 9 below ATM + ATM + 10 above; 19 + 1 + 20
    assert math.isclose(v["average"], expected, abs_tol=1e-9)
    assert math.isclose(v["support"], expected - 50, abs_tol=1e-9)


def test_sr_levels_pcr_and_walls():
    v = sr_view(BODY)
    top3 = lambda side, ok: [k for k, _ in sorted(((k, ROWS[k][side]["oi"]) for k in ROWS if ok(k)), key=lambda x: -x[1])[:3]]  # noqa: E731
    r = sorted(top3("ce", lambda k: SPOT <= k <= SPOT + 500))
    s = sorted(top3("pe", lambda k: SPOT - 500 <= k < SPOT), reverse=True)
    assert [x["strike"] for x in v["levels"]["R"]] == r
    assert [x["strike"] for x in v["levels"]["S"]] == s
    assert v["levels"]["R"][0]["oi"] == ROWS[r[0]]["ce"]["oi"] / 65
    tot = lambda side: sum(x[side]["oi"] for x in BODY["rows"])  # noqa: E731
    assert math.isclose(v["pcr"], tot("pe") / tot("ce"), rel_tol=1e-12)
    big = max((k for k in ROWS if SPOT < k <= SPOT + 1500), key=lambda k: ROWS[k]["ce"]["oi"])
    assert v["biggestCallAbove"]["strike"] == big


def test_top_levels_ties_keep_the_lower_strike_and_number_nearest_first():
    rows = {100: (5, 0), 110: (5, 0), 120: (9, 0), 130: (1, 0)}
    assert [x["strike"] for x in top_levels(rows, 95, "R", 100, 3)] == [100, 110, 120]
    rows = {80: (0, 7), 70: (0, 7), 60: (0, 9)}
    assert [x["strike"] for x in top_levels(rows, 95, "S", 100, 2)] == [70, 60]


def test_sensibull_view_counts_from_the_0915_oi_when_recorded():
    from sig_oi import sensibull_view
    rows = [{"strike": k, "ce": {"oi": 1000, "previous_oi": 0, "open_oi": 900}, "pe": {"oi": 500, "previous_oi": 0, "open_oi": 500}}
            for k in (22500, 22550, 22600, 22650, 22700)]
    body = {"meta": {"symbol": "NIFTY", "spot": 22600, "openOiAt": "09:15:03"}, "rows": rows}
    v = sensibull_view(body)
    assert v["since"] == "09:15:03"
    # only call OI rose since 09:15 -> every strike's average sits at strike - 0 -> anticipated = mean of strikes = spot
    body2 = {"meta": {"symbol": "NIFTY", "spot": 22600}, "rows": [{**r, "ce": {"oi": 1000, "previous_oi": 0}, "pe": {"oi": 500, "previous_oi": 0}} for r in rows]}
    assert sensibull_view(body2)["since"] == "previous close"


def test_oi_change_lean_and_atm_strike():
    """Owner 26-Oct-2026: puts' share of OI + change ("lean") and the ATM strike the windows centre on."""
    v = oi_change_view(BODY)
    net = lambda k: sum(2 * (r[k] or {}).get("oi", 0) - (r[k] or {}).get("previous_oi", 0) for r in BODY["rows"])  # noqa: E731
    assert math.isclose(v["putShare"], net("pe") / (net("pe") + net("ce")) * 100, rel_tol=1e-12)
    assert v["atm"] == 22800  # spot 22,811.35, Nifty strikes every 50
    from sig_service import _spot_vs_atm
    assert _spot_vs_atm(v) == 11.35
    assert _spot_vs_atm(None) is None


def test_build_up_reads_put_heavy_oi_as_support():
    """Owner 30-Oct-2026: puts 63 % of OI + change and more puts added today = Bullish (support), not Bearish."""
    from sig_oi import build_up
    assert build_up(6177613, 3617530, 1620843, 790150)["verdict"] == "Bullish"
    assert build_up(3617530, 6177613, 790150, 1620843)["verdict"] == "Bearish"
    assert build_up(6177613, 3617530, 500, 900)["verdict"] == "Neutral"  # more calls added today: mixed
    assert build_up(5100, 4900)["verdict"] == "Neutral"  # 51 % puts: inside the band
    assert build_up(0, 0) is None
