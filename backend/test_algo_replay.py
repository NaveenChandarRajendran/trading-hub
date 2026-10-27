"""Replay (algo_replay.py): candles from the database (algo_candles / algo_levels) or from 1-minute data, exits
between candle closes, premiums from the option's candles, the Replay account booking, and the report. Simulation only."""
import json
import os
import shutil
import tempfile
from datetime import datetime

import pytest

from algo_replay import (book_replay_account, candles_from_db, candles_from_minutes, fill_at_target, levels_from_db,
                         parse_levels, replay_index, report)
from store import IST, PaperJsonStore
from test_algo_variants import DAY, LEVELS

D = "2026-10-23"


def ep(hm, day=D):
    return int(datetime.fromisoformat(f"{day}T{hm}:00").replace(tzinfo=IST).timestamp())


def five():
    """The test_algo_variants candles (end time -> start epoch) with their RSI."""
    out = []
    for end, o, h, l, c, r in DAY:
        h_, m_ = map(int, end.split(":"))
        start = f"{h_:02d}:{m_ - 5:02d}" if m_ >= 5 else f"{h_ - 1:02d}:{m_ + 55:02d}"
        out.append({"time": ep(start), "open": o, "high": h, "low": l, "close": c, "rsi": r})
    return out


def test_candles_and_levels_come_from_the_database(tmp_path):
    store = PaperJsonStore(str(tmp_path))  # same interface as PaperPgStore
    store.algo_save_levels({"trade_date": D, "index": "NIFTY", "expiry": "2026-10-27", "locked_at": datetime(2026, 10, 23, 9, 30, tzinfo=IST),
                            "levels": {"R1": 22800.0, "S1": 22700.0}, "spot": 22730.2})
    store.algo_save_candle({"trade_date": D, "index": "NIFTY", "candle_start": datetime.fromtimestamp(ep("09:30"), IST).isoformat(),
                            "open": 1, "high": 2, "low": 0.5, "close": 1.5, "rsi": 44.4})
    assert levels_from_db(store, D) == {"NIFTY": {"R1": 22800.0, "S1": 22700.0}}
    assert candles_from_db(store, D, "NIFTY") == [{"time": ep("09:30"), "open": 1, "high": 2, "low": 0.5, "close": 1.5, "rsi": 44.4}]
    assert parse_levels("NIFTY:R1=22800,S1=22700;BANKNIFTY:R1=54800") == {
        "NIFTY": {"R1": 22800.0, "S1": 22700.0}, "BANKNIFTY": {"R1": 54800.0}}


def test_b_on_23_oct_nifty_enters_pe_0950_and_exits_in_the_s2_zone():
    r = replay_index("NIFTY", D, five(), LEVELS, "B")
    assert len(r["trades"]) == 1
    t = r["trades"][0]
    assert (t["setup"], t["entryAt"], t["entrySpot"], t["exitAt"], t["exitSpot"]) == ("Breakdown PE", "09:50", 22661.7, "10:00", 22610.0)
    assert t["points"] == 51.7 and r["points"] == 51.7
    a = replay_index("NIFTY", D, five(), LEVELS, "A")
    assert a["trades"] == [] and [e["kind"] for e in a["events"] if e["kind"] not in ("levels", "level")] == ["skip"]


def test_target_fill_uses_the_open_when_the_market_is_already_through_it():
    pe = {"side": "PE", "target": 22610.0}
    assert fill_at_target(pe, {"open": 22630}) == 22610.0 and fill_at_target(pe, {"open": 22590}) == 22590
    ce = {"side": "CE", "target": 22990.0}
    assert fill_at_target(ce, {"open": 22980}) == 22990.0 and fill_at_target(ce, {"open": 23005}) == 23005


def test_minute_data_premiums_premium_stop_and_rsi_from_minutes():
    # 1-minute candles: the 5-minute candles of DAY spread over their minutes (open, then high / low, then close)
    minutes = []
    for c in five():
        for i, px in enumerate((c["open"], c["high"], c["low"], c["close"], c["close"])):
            minutes.append({"time": c["time"] + 60 * i, "open": px, "high": max(px, c["close"]), "low": min(px, c["close"]),
                            "close": px})
    # option premium: 100 at the entry minute, then falls to 89.5 (premium stop at -10% = 90)
    t0 = ep("09:50")
    prem = {t0 + 60 * i: {"time": t0 + 60 * i, "open": p, "high": p, "low": p, "close": p}
            for i, p in enumerate([100, 98, 95, 89.5, 89, 88])}
    opt = lambda side, spot, t: {"name": "NIFTY 27 OCT 22650 PUT", "candles": prem, "qty": 65}  # noqa: E731
    r = replay_index("NIFTY", D, five(), LEVELS, "B", minutes=minutes, option=opt)
    t = r["trades"][0]
    assert t["option"] == "NIFTY 27 OCT 22650 PUT" and t["entryPrice"] == 100
    assert t["exitReason"].startswith("Premium stop") and t["exitPrice"] == 90.0 and t["premiumPnl"] == -650.0
    # RSI from minutes: same grouping as live, previous session included
    base = ep("13:30", "2026-10-22")
    prev = [{"time": base + 60 * m, "open": 1, "high": 1, "low": 1, "close": 100 + (m % 7)} for m in range(120)]
    out = candles_from_minutes(prev + minutes, D)
    assert out[0]["time"] == five()[0]["time"] and out[0]["rsi"] is not None


def test_replay_account_books_each_variant_separately_and_the_report():
    tmp = tempfile.mkdtemp()
    try:
        store = PaperJsonStore(tmp)
        trades = [{"setup": "Breakdown PE", "entryAt": "09:50", "exitAt": "10:00", "entryPrice": 100.0, "exitPrice": 130.0,
                   "securityId": 7001, "lotSize": 65}]
        acc = book_replay_account(store, "B", D, trades, None)
        assert acc["name"] == "Replay B" and store.active_account(None) is None  # never the manual account
        orders = store.orders(acc["id"], D)
        assert [(o["side"], o["status"], o["source"], o["setup"]) for o in orders] == [
            ("BUY", "FILLED", "replay", "B: Breakdown PE"), ("SELL", "FILLED", "replay", "B: Breakdown PE")]
        pnl = store.day_summary(acc["id"], D, D)[0]
        assert pnl["realized"] == pytest.approx(30 * 65)
        text = report(D, [replay_index("NIFTY", D, five(), LEVELS, v) for v in "AB"], "test")
        assert "**OI not checked**" in text and "| B | NIFTY | 1 | 2 | 1 | 1 | +51.70 |" in text
        assert "- **Breakdown PE** entry 09:50 spot 22,661.7" in text
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
