"""Checks calc.py against the real OI Pulse screenshot (BANKNIFTY, 2026-10-16, 5-min rows)."""
from calc import build_rows, is_aligned, pick_strikes, select_for_interval, summarize

# time, call_chg, put_chg, strength%, chng in direction, direction %, net PCR  (from the screenshot)
SCREEN = [
    ("14:55", 460140, 429360, -7, -30780, 0.0, 0.93),   # first row of our test series
    ("15:00", 462270, 408270, -12, -23220, -75.44, 0.88),
    ("15:05", 447900, 382470, -15, -11430, -21.17, 0.85),
    ("15:10", 451650, 395280, -12, 9060, 13.85, 0.88),
    ("15:15", 422010, 399390, -5, 33750, 59.87, 0.95),
    ("15:20", 365370, 361380, -1, 18630, 82.36, 0.99),
    ("15:25", 261870, 285630, 8, 27750, 695.49, 1.09),
    ("15:30", 191430, 234480, 18, 19290, 81.19, 1.22),
    ("15:35", 136770, 197970, 31, 18150, 42.16, 1.45),
    ("15:40", 88680, 156630, 43, 6750, 11.03, 1.77),
]


def snaps():
    return [{"ts": f"2026-10-16 {t}", "spot": 55800 + i, "call_chg": c, "put_chg": p,
             "call_ltp": 0, "put_ltp": 0, "call_ltp_chg": 0, "put_ltp_chg": 0}
            for i, (t, c, p, *_rest) in enumerate(SCREEN)]


def test_rows_match_screenshot():
    rows = build_rows(snaps())
    for r, (t, c, p, strength, chg, pct, pcr) in zip(rows, SCREEN):
        assert r["diffOi"] == p - c
        assert round(r["strengthPct"]) == strength, t
        assert r["directionChg"] == chg, t
        assert abs(r["directionPct"] - pct) < 0.01, t
        assert abs(r["netPcr"] - pcr) < 0.01, t
        assert r["sentiment"] == ("Bullish" if p - c > 0 else "Bearish"), t


def test_first_row_uses_zero_previous_diff():
    first = build_rows(snaps())[0]
    assert first["directionChg"] == first["diffOi"] and first["directionPct"] == 0.0


def test_diff_day_low_and_high_break():
    rows = build_rows(snaps())
    assert rows[0]["dayHLDiffBreak"] is None          # first row never breaks
    assert rows[2]["dayHLDiffBreak"] == "LOW"         # -65,430 is below -54,000 and -30,780
    assert rows[-1]["dayHLDiffBreak"] == "HIGH"       # 67,950 is above everything earlier


def test_spot_break_flags():
    s = snaps()
    s[1]["spot"] = 56000   # new day high
    s[2]["spot"] = 55000   # new day low
    rows = build_rows(s)
    assert rows[1]["dayHLBreak"] == {"type": "DHB", "level": 55800}
    assert rows[2]["dayHLBreak"] == {"type": "DLB", "level": 55800}


def test_alignment_and_live_row():
    assert is_aligned("2026-10-16 09:20", 5) and not is_aligned("2026-10-16 09:15", 5)
    assert is_aligned("2026-10-16 09:30", 15) and not is_aligned("2026-10-16 09:20", 15)
    assert not is_aligned("2026-10-16 09:35", 15) and is_aligned("2026-10-16 15:30", 15)
    mk = lambda hm: {"ts": f"2026-10-16 {hm}"}
    chosen, live = select_for_interval([mk("09:20"), mk("09:21"), mk("09:25"), mk("09:26")], 5)
    assert [s["ts"][-5:] for s in chosen] == ["09:20", "09:25", "09:26"] and live
    chosen, live = select_for_interval([mk("09:20"), mk("09:25")], 5)
    assert len(chosen) == 2 and not live


def test_pick_strikes_and_summarize():
    avail = [55000 + 100 * i for i in range(30)]
    got = pick_strikes(avail, 55844, 100, 7)
    assert got[7] == 55800 and len(got) == 15 and got[0] == 55100 and got[-1] == 56500
    oc = {55800.0: {"ce": {"oi": 100, "previous_oi": 60, "last_price": 50, "previous_close_price": 70},
                    "pe": {"oi": 90, "previous_oi": 100, "last_price": 40, "previous_close_price": 30}},
          55900.0: {"ce": None, "pe": {"oi": 10, "previous_oi": 0, "last_price": 5, "previous_close_price": 5}}}
    t, used = summarize(oc, [55800.0, 55900.0, 56000.0])
    assert used == 2
    assert t["call_chg"] == 40 and t["put_chg"] == 0
    assert t["call_ltp"] == 50 and t["put_ltp"] == 45
    assert t["call_ltp_chg"] == -20 and t["put_ltp_chg"] == 10
