"""Real days as regression tests. fixtures/scenarios/<day>.json is the day as the live algo saw it: locked levels,
5-minute candles, RSI and the filter values logged for each candle (`python algo_replay.py --date <day>
--export-scenario`). Every rule change must keep these passing; a new day that shows a mistake gets a test here.
Index points only (no premiums): exits are the spot stop and the target zone on the 5-minute high / low."""
import json
import os

import pytest

from algo_logic import active_sides
from algo_replay import RULE_SETS, replay_index, rule_set, scenario_inputs

HERE = os.path.dirname(os.path.abspath(__file__))
DAYS = ("2026-10-23", "2026-10-26", "2026-10-27")


def load(day):
    with open(os.path.join(HERE, "fixtures", "scenarios", f"{day}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def run(day, sym, variant, *rules, oi=True):
    """Replays one index; fails if a level ever holds a CE and a PE setup / trade at the same time."""
    five, levels, filters_at = scenario_inputs(load(day), sym)
    clash = []

    def check(st, end):
        clash.extend((end.strftime("%H:%M"), slot, sides) for slot, sides in active_sides(st).items() if len(sides) > 1)
    with rule_set(*(rules or ("live",))):
        r = replay_index(sym, day, five, levels, variant, filters_at=filters_at if oi else None, after_candle=check)
    assert not clash, clash
    return r


def lines(r, at=None, kind=None):
    return [e["message"] for e in r["events"] if (at is None or e["at"] == at) and (kind is None or e["kind"] == kind)]


@pytest.mark.parametrize("day", DAYS)
@pytest.mark.parametrize("sym", ["NIFTY", "BANKNIFTY"])
@pytest.mark.parametrize("variant", ["A", "B", "C", "D"])
@pytest.mark.parametrize("rules", list(RULE_SETS))
def test_one_setup_per_level_on_every_day_variant_and_rule_set(day, sym, variant, rules):
    run(day, sym, variant, rules)


# ---------------------------------------------------------------- 27-Oct: BANKNIFTY S1 54,500 broken at 10:25
@pytest.mark.parametrize("variant", ["A", "B", "C", "D"])
def test_27_oct_trade_1_range_ce_taken_trade_2_blocked(variant):
    r = run("2026-10-27", "BANKNIFTY", variant)
    ce = [t for t in r["trades"] if t["setup"] == "Range CE (S1 bounce)"]
    assert len(ce) == 1
    assert (ce[0]["entryAt"], ce[0]["entrySpot"], ce[0]["exitAt"], ce[0]["exitSpot"]) == ("09:40", 54514.1, "10:25", 54428.0)
    assert ce[0]["exitReason"].startswith("Spot stop: 10:25 candle")
    assert lines(r, "10:25", "level")[0].startswith("S1 54,500 broken: 10:25 candle")
    if variant != "D":  # D keeps its Breakdown PE armed from 10:25, so the range is not even looked at
        assert lines(r, "10:40", "skip")[0].startswith(
            "Range CE at S1 blocked: S1 broken at 10:25 (closed below S1 - 25), not reclaimed: a retest from below "
            "belongs to the Breakdown PE setup. 10:40 candle O 54,489.2 H 54,517.55 L 54,480.2 C 54,507.05")


def test_27_oct_before_the_fix_b_bought_the_retest_again():
    r = run("2026-10-27", "BANKNIFTY", "B", "before-27oct")
    assert [(t["setup"], t["entryAt"], t["exitAt"]) for t in r["trades"][:2]] == [
        ("Range CE (S1 bounce)", "09:40", "10:25"), ("Range CE (S1 bounce)", "10:40", "11:00")]


def test_27_oct_the_10_25_break_was_never_armed_in_b_position_open():
    """Point 2: the break came on the candle that stopped trade 1, so B ignored it (a position was still open)."""
    r = run("2026-10-27", "BANKNIFTY", "B")
    assert lines(r, "10:25", "skip") == ["Breakdown PE break ignored (position open): 10:25 candle O 54,533.75 H "
                                         "54,542.8 L 54,406.9 C 54,428 closed below S1 54,500 - 25"]
    assert not lines(r, "10:40", "armed")


@pytest.mark.parametrize("variant", ["B", "D"])
def test_27_oct_the_10_40_retest_checked_as_a_breakdown_pe_pullback(variant):
    """B with the proposal (arm on the stop-out candle), and D as it runs today: the retests of S1 from below are
    checked as Breakdown PE pullbacks; every one fails the filters (Trending OI Bullish, RSI above 50), so no trade."""
    r = run("2026-10-27", "BANKNIFTY", variant, *(("live", "arm-on-stop") if variant == "B" else ()))
    assert lines(r, "10:25", "armed")[0].startswith("Breakdown PE armed")
    assert lines(r, "10:40", "skip") == ["Breakdown PE retest at 10:40 not a pullback: high 54,517.55 came within 25 of "
                                         "S1 54,500 but closed 54,507.05 at or above it (a pullback closes below S1)"]
    for t in ("10:30", "10:35", "10:45", "10:50"):
        assert lines(r, t, "skip")[0].startswith(f"Breakdown PE pullback at {t} but filters fail now: Trending OI FAIL")
    assert [t["setup"] for t in r["trades"] if t["entryAt"] < "11:30"] == ["Range CE (S1 bounce)"]


# ---------------------------------------------------------------- 23-Oct: NIFTY S1 22,700 broken at 09:35
def test_23_oct_nifty_a_skips_the_09_35_break():
    for oi in (True, False):
        r = run("2026-10-23", "NIFTY", "A", oi=oi)
        assert lines(r, "09:35", "skip")[0].startswith("Breakdown PE filters failed: 09:35 candle")
        assert "RSI FAIL: 52.5 (need 20-50)" in lines(r, "09:35", "skip")[0]
        assert not [t for t in r["trades"] if t["entryAt"] <= "10:05"]


def test_23_oct_nifty_b_enters_pe_on_the_09_50_pullback_price_and_rsi():
    """The 23-Oct replay without OI history (price + RSI): B enters the Breakdown PE on the 09:50 pullback."""
    r = run("2026-10-23", "NIFTY", "B", oi=False)
    t = r["trades"][0]
    assert (t["setup"], t["side"], t["entryAt"], t["entrySpot"]) == ("Breakdown PE", "PE", "09:50", 22661.7)


def test_23_oct_nifty_b_with_the_logged_trending_oi_skips_the_09_50_pullback():
    """With the Trending OI the live algo logged that morning (Bullish 30.7 % at 09:50), the same pullback fails the
    filters: recorded as it is, pending Naveen's call (27-Oct review)."""
    r = run("2026-10-23", "NIFTY", "B")
    assert lines(r, "09:50", "skip") == ["Breakdown PE pullback at 09:50 but filters fail now: Trending OI FAIL: Bullish "
                                         "30.7% (need Bearish >= 40%); OI change OK: BEARISH (-31.4 pts, need BEARISH); "
                                         "RSI OK: 47.8 (need 20-50); Components OK: Bearish (-0.12%, need not Bullish)"]
    assert not [t for t in r["trades"] if t["entryAt"] <= "10:05"]


# ---------------------------------------------------------------- 26-Oct: no entries with the live filters
@pytest.mark.parametrize("variant", ["A", "B", "C", "D"])
def test_26_oct_no_entries(variant):
    for sym in ("NIFTY", "BANKNIFTY"):
        r = run("2026-10-26", sym, variant)
        assert r["trades"] == [], (sym, r["trades"])
        assert not lines(r, kind="entry")
    bn = run("2026-10-26", "BANKNIFTY", variant)
    blocked = [m for m in lines(bn, kind="skip") if "blocked: R1 - S1 = 100 < 250" in m]
    assert blocked and all(m.startswith(("Range PE (R1 rejection)", "Range CE (S1 bounce)")) for m in blocked)
    breaks = [m for m in lines(bn, kind="skip") if m.startswith("Breakout CE") and "filters fail" in m]
    assert breaks or variant == "A"
    if variant == "A":
        assert [m for m in lines(bn, kind="skip") if m.startswith("Breakout CE filters failed")]
