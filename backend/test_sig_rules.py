"""Rule tests on hand-built states: each case sets the indicator values directly, so the expected verdict follows from
the written rules (docs/strategies/*.md) alone."""
from datetime import datetime

from sig_indicators import IST, pivots
from sig_rules import BORDER, FAIL, NOT_CHECKED, PASS, four_pillar_rule, megabull_rule, supertrend_rule, trading_hub_exit, trading_hub_rule


def ts(hm):
    h, m = map(int, hm.split(":"))
    return int(datetime(2026, 10, 23, h, m, tzinfo=IST).timestamp())


def bar(hm, close, high=None, low=None):
    return {"time": ts(hm), "open": close, "high": high or close + 5, "low": low or close - 5, "close": close, "volume": 1000}


PREV = {"high": 55134.45, "low": 54459.35, "close": 54925.70}  # pivot 54,839.83


def state(closes, symbol="BANKNIFTY", times=None, **ind_last):
    """closes: last few 5-min closes (the last one = the signal candle). ind_last: indicator values for the last two
    candles as (previous, last) or a single value for the last."""
    times = times or [f"{10 + (k * 5) // 60:02d}:{(k * 5) % 60:02d}" for k in range(len(closes))]
    bars = [bar(t, c) for t, c in zip(times, closes)]
    n = len(bars)
    ind = {k: [None] * n for k in ("st_line", "st_dir", "bb_basis", "bb_upper", "bb_lower", "ema20", "vwap", "rsi")}
    for k, v in ind_last.items():
        if isinstance(v, tuple):
            ind[k][-2], ind[k][-1] = v
        else:
            ind[k][-1] = v
    last = datetime.fromtimestamp(bars[-1]["time"] + 300, IST)
    return {
        "symbol": symbol, "bars": bars, "i": n - 1, "ind": ind, "prev": PREV, "piv": pivots(**PREV),
        "oi": {"verdict": "Bearish"}, "sr": {"levels": {"R": [{"strike": 55300, "oi": 1}], "S": [{"strike": 54000, "oi": 1}]}},
        "toi": [{"time": "10:15", "strengthPct": -102}, {"time": "10:10", "strengthPct": -98}, {"time": "10:05", "strengthPct": -60}],
        "vix": 13.2, "pcr": 0.79, "hm": (last.hour, last.minute), "marketOpen": True, "positions": {},
    }


def put_state(**over):
    # close 54,700: below pivot 54,839.83, VWAP 54,800, EMA 54,780; SuperTrend red at 54,900; bands 54,600-55,000
    # (basis 54,800, outer-half line 54,700), widening 380 -> 400; RSI 40 (put zone 30-45)
    s = state([54750, 54720, 54700], st_line=54900, st_dir=1, ema20=54780, vwap=54800, rsi=40,
              bb_basis=(54800, 54800), bb_upper=(54990, 55000), bb_lower=(54610, 54600))
    s.update(over)
    return s


def states(r):
    return {c["id"]: c["state"] for c in r["checks"]}


def test_trading_hub_put_grade_a():
    r = trading_hub_rule(put_state())
    assert r["side"] == "PE" and r["go"] and r["grade"] == "A"
    assert states(r)["delta"] == NOT_CHECKED  # not readable: does not block (owner, 23-Oct)


def test_trading_hub_rsi_below_30_is_borderline_so_grade_b():
    s = put_state()
    s["ind"]["rsi"][-1] = 25
    r = trading_hub_rule(s)
    assert states(r)["rsi"] == BORDER and r["grade"] == "B" and r["go"]


def test_two_other_checks_off_is_no_go():
    s = put_state()
    s["ind"]["rsi"][-1] = 25
    s["ind"]["bb_upper"][-1], s["ind"]["bb_lower"][-1] = 54900, 54700  # width 200 < 380: narrowing
    r = trading_hub_rule(s)
    assert r["grade"] is None and not r["go"]


def test_trending_oi_must_hold_for_three_rows_and_dhan_oi_must_agree():
    s = put_state()
    s["toi"][2]["strengthPct"] = -45
    assert not trading_hub_rule(s)["go"]
    s = put_state(oi={"verdict": "Bullish"})
    r = trading_hub_rule(s)
    assert not r["go"] and states(r)["trendingOi"] != PASS


def test_no_new_entries_after_1430_or_with_an_open_position():
    s = put_state()
    s["hm"] = (14, 35)
    r = trading_hub_rule(s)
    assert r["grade"] == "A" and not r["go"] and r["blocked"]
    r = trading_hub_rule(put_state(positions={"tradingHub": True}))
    assert not r["go"]


def test_signal_exit():
    s = put_state()
    assert trading_hub_exit(s, "PE") is None
    s["toi"][0]["strengthPct"] = -45
    assert "inside 50%" in trading_hub_exit(s, "PE")
    s = put_state()
    s["bars"][-1]["close"] = 54950  # above the 54,900 line
    assert "SuperTrend" in trading_hub_exit(s, "PE")


def four_pillar_call(**over):
    # 10:00 54,800 <= pivot 54,839.83 < 10:05 54,880 (trigger); 10:10 54,900 holds (confirmation); entry 10:15.
    s = state([54800, 54880, 54900], ema20=54850, vwap=54860, rsi=58, st_dir=-1, st_line=54700)
    s.update(vix=13.2, pcr=1.05)
    s.update(over)
    return s


def test_four_pillar_call_go():
    r = megabull_rule(four_pillar_call())
    assert r["setup"] == "4 Pillar Rules" and r["rule"] == "fourPillar" and r["side"] == "CE"
    assert states(r)["trigger"] == PASS and states(r)["confirmation"] == PASS and states(r)["room"] == PASS  # 400 pts to 55,300
    assert r["go"]


def test_four_pillar_needs_confirmation_vix_and_pcr():
    s = four_pillar_call()
    s["bars"][-1]["close"] = 54830  # closed back under the pivot
    r = megabull_rule(s)
    assert states(r)["confirmation"] == FAIL and not r["go"]
    assert not megabull_rule(four_pillar_call(vix=15.2))["go"]
    assert not megabull_rule(four_pillar_call(pcr=0.85))["go"]  # call needs PCR >= 0.9 (owner, 23-Oct evening)
    assert megabull_rule(four_pillar_call(pcr=0.9))["go"]


def test_four_pillar_trigger_in_first_15_minutes_is_skipped():
    s = state([54800, 54880, 54900], times=["09:15", "09:20", "09:25"], ema20=54850, vwap=54860, rsi=58)
    s.update(vix=13.2, pcr=1.05)
    r = megabull_rule(s)
    assert states(r)["trigger"] == FAIL and not r["go"]


def test_room_to_the_wall():
    s = four_pillar_call(sr={"levels": {"R": [{"strike": 55000, "oi": 1}], "S": []}})  # 100 pts < 200
    r = megabull_rule(s)
    assert states(r)["room"] == FAIL and not r["go"]


def test_dharani_put_go():
    # NIFTY pivot from 22,812.30 / 22,521.10 / 22,687.65 = 22,673.68; S1 = 22,535.06
    prev = {"high": 22812.30, "low": 22521.10, "close": 22687.65}
    s = state([22700, 22660, 22640], symbol="NIFTY", st_line=22720, st_dir=1, rsi=38, bb_upper=22760, bb_lower=22640, bb_basis=22700)
    s["bars"][-1]["low"] = 22630  # pressed the lower band
    s.update(prev=prev, piv=pivots(**prev), sr={"levels": {"R": [], "S": [{"strike": 22500, "oi": 1}]}})
    r = megabull_rule(s)
    assert r["setup"] == "SuperTrend Rules" and r["rule"] == "superTrend" and r["side"] == "PE"
    assert all(states(r)[k] == PASS for k in ("trigger", "confirmation", "pillar1", "pillar2", "pillar3", "pillar4", "room"))
    assert r["go"]
    s["ind"]["rsi"][-1] = 50  # 45-55 = no trade
    assert not megabull_rule(s)["go"]


def test_dharani_supertrend_flip_is_a_trigger():
    # no level crossed; SuperTrend flips green on the 10:05 candle (line 22,640), 10:10 closes above it -> trigger + confirmation
    prev = {"high": 22812.30, "low": 22521.10, "close": 22687.65}
    s = state([22650, 22655, 22660], symbol="NIFTY", rsi=58, bb_upper=22655, bb_lower=22550, bb_basis=22600)
    s["ind"]["st_dir"] = [1, -1, -1]
    s["ind"]["st_line"] = [22700, 22640, 22645]
    s.update(prev=prev, piv=pivots(**prev), sr={"levels": {"R": [{"strike": 22800, "oi": 1}], "S": []}})
    r = megabull_rule(s)
    c = {x["id"]: x for x in r["checks"]}
    assert r["side"] == "CE" and c["trigger"]["state"] == PASS and "SuperTrend flip" in c["trigger"]["detail"]
    assert c["confirmation"]["state"] == PASS


def test_settings_are_easy_to_change():
    import sig_rules
    old = sig_rules.MB_WALL_ROOM
    try:
        sig_rules.configure({"wallRoom": {"BANKNIFTY": 450}, "ignored": 1})
        assert sig_rules.MB_WALL_ROOM == {"NIFTY": 50.0, "BANKNIFTY": 450}
        assert not megabull_rule(four_pillar_call())["go"]  # 400 pts to 55,300 < 450
    finally:
        sig_rules.MB_WALL_ROOM = old


def test_both_megabull_rules_run_on_any_index():
    """Owner, 25-Oct-2026: 4 Pillar Rules and SuperTrend Rules on NIFTY and BANKNIFTY."""
    s = four_pillar_call()
    assert four_pillar_rule(s)["go"] and supertrend_rule(s)["rule"] == "superTrend"
    n = {**s, "symbol": "NIFTY"}
    r = four_pillar_rule(n)
    assert r["symbol"] == "NIFTY" and r["name"] == "4 PILLAR RULES" and r["checks"]  # NIFTY thresholds exist
