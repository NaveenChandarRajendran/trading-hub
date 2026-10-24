"""Option-chain snapshots every minute (chain_snapshots.py + tracker + store), and replays reading them for the OI
filters."""
import json
import os
import shutil
import tempfile
from datetime import datetime

import pytest

from algo_filters import oi_change_verdict
from algo_replay import oi_filters_from_store, replay_index
from chain_snapshots import COLUMNS, EACH_SIDE, make_snapshot, to_oc
from store import IST, JsonStore
from test_algo_variants import LEVELS
from test_sr_api import KEY, make, poll

FIX = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "shared", "dhan", "__fixtures__")


def fixture_chain(symbol):
    body = json.load(open(os.path.join(FIX, f"{symbol.lower()}-2026-10-21.json"), encoding="utf-8"))
    return body["meta"]["spot"], {float(r["strike"]): {"ce": r["ce"], "pe": r["pe"]} for r in body["rows"]}


@pytest.mark.parametrize("symbol", ["NIFTY", "BANKNIFTY"])
def test_snapshot_keeps_atm_25_each_side_and_gives_the_same_oi_change_verdict(symbol):
    spot, oc = fixture_chain(symbol)
    snap = make_snapshot("2026-10-21 15:29", "2026-10-21T15:29:03+05:30", spot, oc)
    strikes = [r[0] for r in snap["rows"]]
    atm = min(oc, key=lambda k: abs(k - spot))
    assert len(strikes) == 2 * EACH_SIDE + 1 and strikes[EACH_SIDE] == atm and snap["columns"] == COLUMNS
    full = oi_change_verdict(symbol, spot, oc)
    again = oi_change_verdict(symbol, spot, to_oc(snap))
    assert again["verdict"] == full["verdict"] and again["average"] == pytest.approx(full["average"], abs=1e-9)
    leg = to_oc(snap)[atm]["ce"]
    assert leg["oi"] == float(oc[atm]["ce"]["oi"]) and leg["last_price"] == float(oc[atm]["ce"]["last_price"])


def test_json_store_appends_reads_back_and_lists_expiries():
    tmp = tempfile.mkdtemp()
    try:
        st = JsonStore(tmp)
        spot, oc = fixture_chain("NIFTY")
        for ts in ("2026-10-23 09:16", "2026-10-23 09:17", "2026-10-23 09:16"):
            st.save_chain_snapshot("NIFTY", "2026-10-27", "2026-10-23", make_snapshot(ts, ts, spot, oc))
        with open(os.path.join(tmp, "chain_NIFTY_2026-10-27_2026-10-23.jsonl"), "a", encoding="utf-8") as f:
            f.write('{"ts": "2026-10-23 09:18", "cut sh')  # a crash mid-write
        got = st.chain_snapshots("NIFTY", "2026-10-27", "2026-10-23")
        assert [s["ts"] for s in got] == ["2026-10-23 09:16", "2026-10-23 09:17"]
        assert st.chain_snapshot_expiries("NIFTY", "2026-10-23") == ["2026-10-27"]
        assert st.active_keys("2026-10-23") == []  # the .jsonl files are not Trending OI sessions
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_tracker_saves_one_snapshot_per_minute_poll():
    fake, tr, c, tmp = make()
    poll(tr, "09:16", "09:17", "09:17")
    snaps = tr.store.chain_snapshots(*KEY, "2026-10-22")
    assert [s["ts"] for s in snaps] == ["2026-10-22 09:16", "2026-10-22 09:17"] and snaps[0]["spot"] == 22811.0
    assert snaps[0]["fetchedAt"].startswith("2026-10-22T09:16:03")


def test_a_failing_snapshot_write_never_breaks_trending_oi():
    fake, tr, c, tmp = make()

    def boom(*a):
        raise OSError("disk full")

    tr.store.save_chain_snapshot = boom
    assert poll(tr, "09:16") is None and tr.view(KEY)["snaps"]  # the Trending OI snapshot is still there


def test_replay_checks_trending_oi_and_oi_change_from_saved_snapshots():
    fake, tr, c, tmp = make()
    fake.spot = 22650.0
    poll(tr, *[f"10:{m:02d}" for m in range(0, 16)])
    fa = oi_filters_from_store(tr.store, "NIFTY", "2026-10-22")
    f = fa(datetime(2026, 10, 22, 10, 15, tzinfo=IST))
    assert f["oiChange"]["verdict"] in ("BULLISH", "BEARISH", "NEUTRAL") and f["toi"]["ts"] == "2026-10-22 10:15"
    assert f["componentsChecked"] is False and f["expiry"] == "2026-10-27"
    assert oi_filters_from_store(tr.store, "NIFTY", "2026-10-21") is None  # no snapshots that day: OI not checked
    five = [{"time": int(datetime(2026, 10, 22, 10, 0, tzinfo=IST).timestamp()), "open": 22710, "high": 22712,
             "low": 22680, "close": 22685, "rsi": 45.0}]
    r = replay_index("NIFTY", "2026-10-22", five, LEVELS, "A", filters_at=fa)
    assert r["oiChecked"] is True
    msg = [e["message"] for e in r["events"] if e["kind"] in ("skip", "armed")][0]
    assert "not checked (no OI history)" not in msg and "Components OK: not checked (no history)" in msg
