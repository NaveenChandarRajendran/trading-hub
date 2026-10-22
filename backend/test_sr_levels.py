"""sr_levels.py: raw ranking (parity with OI Support & Resistance), the stability rule and history rows."""
import json
from pathlib import Path

from dhan_client import parse_chain
from sr_levels import DEFAULTS, LevelState, apply_changes, rank_levels, side_oi

RAW = json.loads((Path(__file__).parent / "fixtures" / "dhan_chain_NIFTY_2026-10-27.json").read_text(encoding="utf-8"))


def test_raw_ranking_matches_oi_support_and_resistance():
    # Same chain as frontend dashboard.test.ts / osrLive.test.ts: R 23,000 / 23,100 / 23,200, S 22,700 / 22,600 / 22,500
    chain = parse_chain(RAW)
    r = rank_levels(side_oi(chain["oc"], "R"), chain["spot"], "R", 500)
    s = rank_levels(side_oi(chain["oc"], "S"), chain["spot"], "S", 500)
    assert [k for k, _ in r] == [23000, 23100, 23200]
    assert [k for k, _ in s] == [22700, 22600, 22500]
    assert r[0][1] == chain["oc"][23000.0]["ce"]["oi"]  # OI in units, as Dhan sends it


def test_ranking_ties_and_range_edges():
    oi = {100.0: 5, 110.0: 5, 120.0: 9, 90.0: 7}
    assert rank_levels(oi, 100, "R", 20) == [(100.0, 5), (110.0, 5), (120.0, 9)]  # spot itself counts for R
    assert rank_levels(oi, 100, "S", 20) == [(90.0, 7)]  # strictly below spot for S
    assert rank_levels({100.0: 5, 110.0: 5, 120.0: 5, 130.0: 5}, 100, "R", 50)[0][0] == 100.0  # ties keep lower strikes


def chain(puts, calls=None):
    """Dhan-style oc from {strike: put OI} (+ optional call OI)."""
    calls = calls or {}
    return {float(k): {"ce": {"oi": calls.get(k, 0)}, "pe": {"oi": v}} for k, v in puts.items()} | \
        {float(k): {"ce": {"oi": v}, "pe": {"oi": 0}} for k, v in calls.items() if k not in puts}


BASE = {22700: 1000, 22600: 900, 22500: 800, 22400: 100}  # put OI
CALLS = {22700: 50, 22900: 1200, 23000: 1500, 23100: 900}  # call OI (R side); 22,700 is below spot, not a level
SPOT = 22811


def chain_p(puts):
    return chain(puts, CALLS)


def opened():
    st = LevelState()
    changes = st.update(chain_p(BASE), SPOT, DEFAULTS)
    assert changes == {"R1": (22900, "open"), "R2": (23000, "open"), "R3": (23100, "open"),
                       "S1": (22700, "open"), "S2": (22600, "open"), "S3": (22500, "open")}
    return st


def test_brief_oi_flip_does_not_move_a_level():
    st = opened()
    flip = {**BASE, 22400: 900}  # 900 >= 800 × 1.10 = 880 -> ahead of the weakest level (S3 22,500)
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {}
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {}
    assert st.update(chain_p(BASE), SPOT, DEFAULTS) == {}  # falls back: the count starts again
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {}
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {}
    assert {k: v for k, v in st.slots().items() if k[0] == "S"} == {"S1": 22700, "S2": 22600, "S3": 22500}


def test_sustained_lead_of_10pct_for_3_refreshes_moves_it():
    st = opened()
    flip = {**BASE, 22400: 900}
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {}
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {}
    assert st.update(chain_p(flip), SPOT, DEFAULTS) == {"S3": (22400, "oi")}  # third refresh in a row
    assert {k: v for k, v in st.slots().items() if k[0] == "S"} == {"S1": 22700, "S2": 22600, "S3": 22400}


def test_a_lead_under_10pct_never_moves_it():
    st = opened()
    near = {**BASE, 22400: 870}  # 870 < 880
    for _ in range(6):
        assert st.update(chain_p(near), SPOT, DEFAULTS) == {}


def test_settings_change_the_rule():
    st = opened()
    flip = {**BASE, 22400: 850}  # +6.25 % over 800
    rule = {"leadPct": 5, "confirmRefreshes": 1, "range": 500}
    assert st.update(chain_p(flip), SPOT, rule) == {"S3": (22400, "oi")}


def test_a_new_nearer_level_renumbers_the_others():
    st = opened()
    near = {**BASE, 22750: 2000}  # a big put build just below spot, beats S3 (800) easily
    for _ in range(2):
        assert st.update(chain_p(near), SPOT, DEFAULTS) == {}
    assert st.update(chain_p(near), SPOT, DEFAULTS) == {
        "S1": (22750, "oi"), "S2": (22700, "renumber"), "S3": (22600, "renumber")}


def test_a_crossed_level_is_replaced_at_once():
    st = opened()
    changes = st.update(chain_p(BASE), 22650, DEFAULTS)  # spot fell through S1 22,700
    assert changes == {"S1": (22600, "crossed"), "S2": (22500, "renumber"), "S3": (22400, "crossed")}
    # R side unchanged: 22,700 is now above spot but holds almost no call OI, and it isn't a current level
    assert {k: v for k, v in st.slots().items() if k[0] == "R"} == {"R1": 22900, "R2": 23000, "R3": 23100}


def test_resume_after_restart_and_missing_levels():
    st = LevelState.from_slots({"S2": 22600.0, "S1": 22700.0, "R1": 23000.0})
    assert st.slots() == {"R1": 23000.0, "S1": 22700.0, "S2": 22600.0}
    few = LevelState()
    assert few.update(chain({22700: 5}), SPOT, DEFAULTS) == {"S1": (22700, "open")}  # one strike in range only
    assert few.update(chain({22700: 5, 22600: 3}), SPOT, DEFAULTS) == {"S2": (22600, "fill")}  # later: filled at once


def test_history_rows_open_and_close():
    open_rows = {"S1": {"slot": "S1", "strike": 22700, "oi": 1000, "valid_from": "2026-10-22 09:16", "valid_to": None, "reason": "open"}}
    closed, opened_rows = apply_changes(open_rows, {"S1": (22600, "crossed")}, "2026-10-22 10:47", {"S1": 900})
    assert closed == [{**open_rows["S1"], "valid_to": "2026-10-22 10:47"}]
    assert opened_rows == [{"slot": "S1", "strike": 22600, "oi": 900, "valid_from": "2026-10-22 10:47", "valid_to": None, "reason": "crossed"}]
    closed, opened_rows = apply_changes(open_rows, {"S1": (None, "range")}, "2026-10-22 11:00", {})
    assert len(closed) == 1 and opened_rows == []
    assert apply_changes(open_rows, {}, "2026-10-22 11:01", {}) == ([], [])  # nothing changed: nothing written
