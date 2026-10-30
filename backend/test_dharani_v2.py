"""Dharani v2 (docs/strategies/dharani-v2.md) on hand-built states: indicator values are set directly, so each verdict
follows from the written conditions alone."""
from datetime import datetime, timedelta

from sig_dharani_v2 import build_state_v2, closed_bars, dharani_v2_exit, dharani_v2_rule
from sig_indicators import IST
from sig_rules import FAIL, NOT_CHECKED, PASS

PIV = {"P": 25000, "R1": 25100, "S1": 24900, "R2": 25200, "S2": 24800, "R3": 25300, "S3": 24700}


def state(**over):
    s = {
        "symbol": "NIFTY", "hm": (10, 3), "signalTime": "10:00", "marketOpen": True, "positions": {}, "piv": PIV,
        "idx": {"bar": {"close": 25150}, "ind": {"st_line": 25050, "st_dir": -1, "rsi": 74, "bb_upper": 25140, "wr": -12}},
        "fut": {"bar": {"close": 25180}, "piv": {**PIV, "S1": 24950}, "cpr": {"widthPct": 0.1},
                "ind": {"st_line": 25100, "st_dir": -1, "ema": 25000, "rsi": 70, "cci": 150, "wr": -10, "bb_lower": 24950}},
    }
    s.update(over)
    return s


def put_state():
    return state(idx={"bar": {"close": 24850}, "ind": {"st_line": 24950, "st_dir": 1, "rsi": 25, "bb_upper": 25100, "wr": -95}},
                 fut={"bar": {"close": 24880}, "piv": {**PIV, "S1": 24930}, "cpr": {"widthPct": 0.15},
                      "ind": {"st_line": 24990, "st_dir": 1, "ema": 25050, "rsi": 24, "cci": -260, "wr": -92, "bb_lower": 24900}})


def states(r):
    return {c["id"]: c["state"] for c in r["checks"]}


def test_call_needs_all_five():
    r = dharani_v2_rule(state())
    assert r["side"] == "CE" and r["go"] and (r["score"], r["total"]) == (5, 5) and r["noTarget"]
    s = state()
    s["idx"]["ind"]["wr"] = -35  # Williams %R must be above -30
    r = dharani_v2_rule(s)
    assert not r["go"] and states(r)["williams"] == FAIL and r["score"] == 4
    s = state()
    s["idx"]["bar"]["close"] = 25130  # inside the upper band 25,140
    assert states(dharani_v2_rule(s))["bollinger"] == FAIL


def test_put_uses_the_futures_and_needs_all_eight():
    r = dharani_v2_rule(put_state())
    assert r["side"] == "PE" and r["go"] and r["total"] == 8
    s = put_state()
    s["fut"]["cpr"]["widthPct"] = 0.35  # CPR not narrow
    r = dharani_v2_rule(s)
    assert not r["go"] and states(r)["cprNarrow"] == FAIL
    s = put_state()
    s["fut"]["ind"]["cci"] = -150  # CCI must be below -200
    assert not dharani_v2_rule(s)["go"]
    s = put_state()
    s["fut"] = None  # no futures data: the put cannot be checked
    r = dharani_v2_rule(s)
    assert not r["go"]


def test_window_and_own_position():
    s = state(hm=(9, 18))
    assert dharani_v2_rule(s)["go"]  # first 3-minute candle is allowed (the teacher trades from 09:15)
    assert not dharani_v2_rule(state(hm=(15, 3)))["go"]
    assert dharani_v2_rule(state(positions={"megabull": True}))["go"]  # v1's trade does not block v2
    assert not dharani_v2_rule(state(positions={"dharaniV2": True}))["go"]


def test_supertrend_exit():
    s = state()
    assert dharani_v2_exit(s, "CE") is None
    s["idx"]["bar"]["close"] = 25040
    assert "below SuperTrend" in dharani_v2_exit(s, "CE")
    p = put_state()
    assert dharani_v2_exit(p, "PE") is None
    p["fut"]["bar"]["close"] = 25000
    assert "above SuperTrend" in dharani_v2_exit(p, "PE")


def test_closed_bars_are_three_minutes_aligned_to_0915():
    t0 = int(datetime(2026, 10, 26, 9, 15, tzinfo=IST).timestamp())
    one = [{"time": t0 + 60 * k, "open": 1, "high": 2 + k, "low": 1, "close": 1.5 + k} for k in range(7)]
    bars, complete = closed_bars(one, datetime(2026, 10, 26, 9, 21, 35, tzinfo=IST))
    assert [b["time"] for b in bars] == [t0, t0 + 180] and complete
    assert bars[0]["high"] == 4 and bars[1]["close"] == 6.5


class Src:
    def __init__(self, fut=True):
        self.fut = fut

    def market_open(self):
        return True

    def positions(self, symbol):
        return {}

    def candles_v2(self, symbol, max_age=None, n=4):
        days = [datetime(2026, 10, 23, tzinfo=IST), datetime(2026, 10, 26, tzinfo=IST)]
        rows = []
        for d in days:
            t = int(d.replace(hour=9, minute=15).timestamp())
            for k in range(375 if d.day == 23 else 30):
                p = 25000 + k
                rows.append({"time": t + 60 * k, "open": p, "high": p + 2, "low": p - 2, "close": p + 1})
        return [d.date() for d in days], rows, ([dict(r, close=r["close"] + 50) for r in rows] if self.fut else []), ""


def test_build_state_reads_index_and_futures():
    now = datetime(2026, 10, 26, 9, 45, 35, tzinfo=IST)
    st, problems = build_state_v2("NIFTY", now, Src())
    assert st["signalTime"] == "09:42" and st["hm"] == (9, 45) and st["fut"] and not problems
    assert st["piv"]["P"] == (25376 + 24998 + 25375) / 3  # previous day high / low / close of the index
    st, problems = build_state_v2("NIFTY", now, Src(fut=False))
    assert st["fut"] is None and problems
    assert dharani_v2_rule(st)["side"] in ("CE", "PE")


def test_banknifty_uses_its_own_premium_target():
    s = state(symbol="BANKNIFTY")
    assert dharani_v2_rule(s)["premiumNear"] == 500
    assert dharani_v2_rule(state())["premiumNear"] == 250
    assert dharani_v2_rule(state(premiumNear=300))["premiumNear"] == 300  # autopaper.json override
