"""Rule variants B, C, D (algo_logic.py) on NIFTY's real 23-Oct 5-minute candles from that day's log, price + RSI only
("OI not checked"), plus synthetic cases for cancel / expiry / continuation / the ladder retest."""
from datetime import datetime

import pytest

from algo_logic import lock_levels, new_state, next_slot, on_candle, on_tick
from store import IST

LEVELS = {"R1": 22800.0, "R2": 23000.0, "R3": 23200.0, "S1": 22700.0, "S2": 22600.0, "S3": 22500.0}
# 23-Oct NIFTY, from logs/algo-2026-10-23.log: end time, O, H, L, C, RSI(14)
DAY = [
    ("09:35", 22725.9, 22733.0, 22676.15, 22681.4, 52.5),
    ("09:40", 22680.9, 22695.2, 22663.75, 22686.95, 53.6),
    ("09:45", 22687.6, 22730.9, 22686.9, 22689.45, 54.1),
    ("09:50", 22689.0, 22703.15, 22657.45, 22661.7, 47.8),
    ("09:55", 22661.7, 22669.4, 22630.1, 22637.9, 43.2),
    ("10:00", 22638.0, 22649.95, 22602.8, 22607.8, 38.2),
    ("10:05", 22609.15, 22610.9, 22555.0, 22560.95, 32.0),
]


def at(hm):
    return datetime.fromisoformat(f"2026-10-23T{hm}:00").replace(tzinfo=IST)


def state():
    s = new_state("NIFTY", "2026-10-23")
    lock_levels(s, LEVELS, at("09:30"))
    return s


def f(rsi):
    return {"oiChecked": False, "toi": None, "oiChange": None, "components": None, "rsi": rsi}


def run(s, rows, variant):
    out = []
    for end, o, h, l, c, r in rows:
        acts = on_candle(s, {"open": o, "high": h, "low": l, "close": c}, at(end), f(r), variant=variant)
        out += [(end, a.get("kind", a["type"]), a) for a in acts]
    return out


def test_a_skips_the_0935_breakdown_on_rsi_and_never_enters():
    s = state()
    out = run(s, DAY, "A")
    assert [(e, k) for e, k, _ in out] == [("09:35", "skip")]
    assert "RSI FAIL: 52.5 (need 20-50)" in out[0][2]["message"] and "Trending OI OK: not checked" in out[0][2]["message"]
    assert s["trades"] == 0


@pytest.mark.parametrize("variant", ["B", "C", "D"])
def test_b_c_d_wait_for_rsi_and_enter_pe_on_the_0950_pullback_targeting_s2(variant):
    s = state()
    out = run(s, DAY[:4], variant)
    kinds = [(e, k) for e, k, _ in out]
    assert kinds == [("09:35", "armed"), ("09:40", "skip"), ("09:45", "skip"), ("09:50", "enter")]
    assert "pullback at 09:40 but filters fail now" in out[1][2]["message"] and "RSI FAIL: 53.6" in out[1][2]["message"]
    e = out[3][2]
    assert (e["side"], e["setup"], e["data"]["target"], e["data"]["spotStop"]) == ("PE", "Breakdown PE", 22610.0, "close above 22,710")
    assert "high 22,703.15 within 10 of S1 22,700 and closed 22,661.7 below it" in e["reason"] and "RSI OK: 47.8" in e["reason"]


def test_b_expires_after_6_candles_and_a_close_back_through_cancels():
    s = state()
    on_candle(s, {"open": 22700, "high": 22702, "low": 22670, "close": 22680}, at("10:00"), f(60), variant="B")
    for i in range(5):  # no pullback (high stays below S1 - buffer)
        assert not [a for a in on_candle(s, {"open": 22650, "high": 22660, "low": 22640, "close": 22650},
                                         at(f"10:{5 + 5 * i:02d}"), f(40), variant="B") if a.get("kind") == "expire"]
    out = on_candle(s, {"open": 22650, "high": 22660, "low": 22640, "close": 22650}, at("10:30"), f(40), variant="B")
    assert [a["kind"] for a in out] == ["expire"]
    s = state()
    on_candle(s, {"open": 22700, "high": 22702, "low": 22670, "close": 22680}, at("10:00"), f(60), variant="B")
    out = on_candle(s, {"open": 22680, "high": 22720, "low": 22678, "close": 22715}, at("10:05"), f(40), variant="B")
    assert out[0]["kind"] == "cancel" and "closed 22,715 back above S1 22,700 + 10" in out[0]["message"]


def test_c_continuation_after_3_candles_without_pullback():
    s = state()
    on_candle(s, {"open": 22700, "high": 22702, "low": 22670, "close": 22680}, at("10:00"), f(45), variant="C")
    for i, close in enumerate((22675, 22672, 22674)):  # no pullback, not below the break candle's low yet
        assert [a.get("kind") for a in on_candle(s, {"open": 22680, "high": 22684, "low": 22671, "close": close},
                                                 at(f"10:{5 + 5 * i:02d}"), f(45), variant="C")] == []
    out = on_candle(s, {"open": 22674, "high": 22676, "low": 22655, "close": 22660}, at("10:20"), f(42), variant="C")
    assert out[0]["type"] == "enter" and "continuation 10:20 candle" in out[0]["reason"]
    assert "below the break candle's low 22,670" in out[0]["reason"]
    s = state()  # B never does this
    on_candle(s, {"open": 22700, "high": 22702, "low": 22670, "close": 22680}, at("10:00"), f(45), variant="B")
    for i, close in enumerate((22675, 22672, 22674, 22660)):
        assert not [a for a in on_candle(s, {"open": 22680, "high": 22684, "low": 22655, "close": close},
                                         at(f"10:{5 + 5 * i:02d}"), f(42), variant="B") if a["type"] == "enter"]


def test_d_ladder_arms_each_broken_level_and_a_later_retest_from_below_is_a_pullback():
    s = state()
    run(s, DAY[:4], "D")  # 09:50: PE entry at S1 (target S2 zone)
    assert on_tick(s, 22609, None)["reason"].startswith("Target zone reached: spot 22,609 <= 22,610")
    s["open"] = None  # the runner closes the trade
    out = run(s, DAY[4:], "D")  # 10:05 closes 22,560.95 below S2 - 10: S2 becomes the breakout level
    assert [(e, k) for e, k, _ in out] == [("10:05", "armed")] and "Breakdown PE S2 armed [D]" in out[0][2]["message"]
    for i in range(30):  # hours later, still below S2 and never closed back above it: still armed (no expiry)
        on_candle(s, {"open": 22450, "high": 22480, "low": 22440, "close": 22460}, at(f"{11 + i // 12}:{(i % 12) * 5:02d}"),
                  f(35), variant="D")
    assert "S2" in s["setups"]
    out = on_candle(s, {"open": 22513, "high": 22595, "low": 22510, "close": 22579.3}, at("13:45"), f(45), variant="D")
    e = [a for a in out if a["type"] == "enter"][0]
    assert e["setup"] == "Breakdown PE S2" and e["data"]["target"] == 22510.0  # S3 zone
    assert "high 22,595 within 10 of S2 22,600 and closed 22,579.3 below it" in e["reason"]


def test_ladder_targets():
    assert [next_slot(x) for x in ("R1", "R2", "R3", "S1", "S2", "S3")] == ["R2", "R3", None, "S2", "S3", None]
