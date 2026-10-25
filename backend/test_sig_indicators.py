"""Indicator tests. Expected values are worked by hand (shown in the comments) and shared with the TypeScript chart
tests through frontend/src/apps/dashboard/logic/__fixtures__/indicator_cases.json, so the chart and the signal engine compute the same numbers."""
import json
import math
import os

from sig_indicators import atr, bollinger, ema, pivots, rsi, sma, stdev, supertrend, vwap

HERE = os.path.dirname(__file__)
CASES = json.load(open(os.path.join(HERE, "..", "frontend", "src", "apps", "dashboard", "logic", "__fixtures__", "indicator_cases.json")))


def close(a, b, tol=1e-6):
    return a is not None and b is not None and abs(a - b) <= tol


def test_rsi_matches_the_dashboard_chart_values():
    c = CASES["rsi"]
    got = rsi(c["closes"], 14)
    assert all(v is None for v in got[:14])
    assert [round(v, 2) for v in got[14:]] == c["rsi14"]  # same list as dashboard/logic/indicators.test.ts


def test_ema_seed_and_steps():
    # n = 3: seed (1+2+3)/3 = 2; k = 0.5 -> 3 -> 5.5
    assert ema([1, 2, 3, 4, 8], 3) == [None, None, 2, 3, 5.5]


def test_sma_and_population_stdev():
    # [2, 4, 4, 4, 5, 5, 7, 9]: mean 5, population variance 4 -> stdev 2
    assert sma([2, 4, 4, 4, 5, 5, 7, 9], 8)[-1] == 5
    assert stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[-1] == 2


def test_bollinger_hand_case():
    c = CASES["bollinger"]
    basis, upper, lower = bollinger(c["closes"], c["period"], c["mult"])
    for i, (b, u, l) in enumerate(zip(c["basis"], c["upper"], c["lower"])):
        if b is None:
            assert basis[i] is None
        else:
            assert close(basis[i], b) and close(upper[i], u) and close(lower[i], l)


def test_atr_rma_hand_case():
    c = CASES["atr"]
    got = atr(c["high"], c["low"], c["close"], c["period"])
    for g, e in zip(got, c["atr"]):
        assert (g is None and e is None) or close(g, e)


def test_supertrend_hand_case():
    c = CASES["supertrend"]
    line, direction = supertrend(c["high"], c["low"], c["close"], c["period"], c["factor"])
    assert direction == c["direction"]
    for g, e in zip(line, c["line"]):
        assert (g is None and e is None) or close(g, e)


def test_vwap_resets_each_ist_day():
    c = CASES["vwap"]
    got = vwap(c["time"], c["high"], c["low"], c["close"], c["volume"])
    for g, e in zip(got, c["vwap"]):
        assert (g is None and e is None) or close(g, e)


def test_traditional_pivots():
    # H 55134.45, L 54459.35, C 54925.70 -> P = 164519.50 / 3 = 54839.8333
    p = pivots(55134.45, 54459.35, 54925.70)
    assert math.isclose(p["P"], 54839.833333, abs_tol=1e-4)
    assert math.isclose(p["R1"], 2 * p["P"] - 54459.35)
    assert math.isclose(p["S1"], 2 * p["P"] - 55134.45)


def test_williams_r_cci_cpr_by_hand():
    from sig_indicators import cci, cpr, williams_r
    # 3-candle Williams %R: highest high 12, lowest low 8, close 11 -> (12-11)/(12-8) x -100 = -25
    assert williams_r([10, 12, 11], [9, 8, 10], [9.5, 11, 11], 3) == [None, None, -25.0]
    # CCI(3) with typical prices 10, 11, 12: mean 11, mean deviation 2/3 -> (12-11)/(0.015 x 2/3) = 100
    out = cci([10, 11, 12], [10, 11, 12], [10, 11, 12], 3)
    assert out[:2] == [None, None] and round(out[2], 6) == 100.0
    # CPR from H 110, L 90, C 100: P 100, BC 100, TC 100 -> width 0; and from H 120 L 90 C 111: P 107, BC 105, TC 109
    assert cpr(110, 90, 100)["widthPct"] == 0
    c = cpr(120, 90, 111)
    assert (c["P"], c["BC"], c["TC"]) == (107.0, 105.0, 109.0) and round(c["widthPct"], 4) == round(4 / 107 * 100, 4)
