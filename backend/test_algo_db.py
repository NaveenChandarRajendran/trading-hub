"""Postgres as the single source of truth for the algo: refusing to start without a database, the idempotent import,
daily summary numbers, IST date ranges around midnight, and the 23-Oct day view - all on a real Postgres.

Runs only with TEST_DATABASE_URL (a throwaway database: the algo_, pt_, toi_, sr_ and oc_ tables are TRUNCATEd), e.g.
    set TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/trading_hub_test
"""
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))

import algo_api  # noqa: E402
import import_legacy  # noqa: E402
from algo_reports import day_summaries, range_report, write_day_summaries  # noqa: E402
from algo_service import AlgoService  # noqa: E402
from paper_api import PaperService  # noqa: E402
from store import IST, PaperPgStore, PgStore  # noqa: E402
from test_algo_service import (GOOD_CE, Clock, Instruments, at, books, breakout_entry, ce, make_data,  # noqa: E402
                               tick)
from test_paper_api import FakeFeed  # noqa: E402

DSN = os.getenv("TEST_DATABASE_URL")
TABLES = ("algo_events", "algo_state", "algo_levels", "algo_candles", "algo_daily_summary", "oc_snapshots",
          "pt_order_levels", "pt_positions", "pt_trades", "pt_orders", "pt_accounts", "toi_snapshot", "toi_session",
          "sr_levels")
LOG = os.path.join(HERE, "fixtures", "algo-2026-10-23.log")


# ---------------------------------------------------------------- refusing to start (no database needed)
def test_backend_refuses_to_start_without_a_database(monkeypatch, tmp_path):
    import main
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(SystemExit) as e:
        main.open_stores(env_file=str(tmp_path / "missing.env"))
    assert "DATABASE_URL is not set" in str(e.value) and "backend/.env.local" in str(e.value)
    assert "postgresql://USER:PASSWORD@localhost:5432/algo_trading" in str(e.value)


def test_backend_refuses_to_start_when_the_database_is_unreachable(monkeypatch, tmp_path):
    import main
    env = tmp_path / ".env.local"
    env.write_text("DATABASE_URL=postgresql://nobody:wrong@127.0.0.1:1/nothing\n", encoding="utf-8")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(SystemExit) as e:
        main.open_stores(env_file=str(env))
    assert "Cannot connect to Postgres with DATABASE_URL from backend/.env.local" in str(e.value)


def test_no_json_fallback_in_the_app():
    for name in ("main.py", "algo_service.py", "algo_api.py", "algo_reports.py", "algo_replay.py"):
        src = open(os.path.join(HERE, name), encoding="utf-8").read()
        assert "JsonStore" not in src and "parse_log_file" not in src, name


# ---------------------------------------------------------------- Postgres
@pytest.fixture
def db():
    if not DSN:
        pytest.skip("set TEST_DATABASE_URL to run the Postgres algo tests")
    pg = PgStore(DSN)
    with pg._cursor() as cur:
        cur.execute(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE")
    yield pg, PaperPgStore(pg)
    pg.close()


def test_import_is_idempotent(db, tmp_path):
    pg, paper = db
    data, logs = tmp_path / "data", tmp_path / "logs"
    data.mkdir()
    logs.mkdir()
    shutil.copy(LOG, logs / "algo-2026-10-23.log")
    snap = {"ts": "2026-10-22 09:16", "spot": 22800.0, "strikes_used": 15, "call_chg": 1.0, "put_chg": 2.0,
            "call_ltp": 3.0, "put_ltp": 4.0, "call_ltp_chg": 0.5, "put_ltp_chg": 0.25}
    (data / "NIFTY_2026-10-27_2026-10-22.json").write_text(json.dumps({"strikes": [22700, 22800], "snaps": [snap]}))
    order = {"id": "PT20261022-0001", "security_id": 61001, "side": "BUY", "order_type": "MARKET", "lots": 1,
             "lot_size": 65, "price": None, "trigger_price": None, "status": "FILLED", "avg_price": 100.0,
             "slippage_capped": False, "reason": "", "blocked": 0.0, "created_at": "2026-10-22T10:00:00+05:30",
             "updated_at": "2026-10-22T10:00:00+05:30", "filled_at": "2026-10-22T10:00:00+05:30", "qty": 65}
    (data / "paper.json").write_text(json.dumps({
        "accounts": [{"id": 1, "capital": 100000.0, "created_at": "2026-10-21T09:57:01+05:30", "archived_at": None}],
        "orders": {"1": {"2026-10-22": {order["id"]: order}}}, "trades": {}, "positions": {}}))
    first = import_legacy.run(pg, paper, str(data), str(logs), out=lambda *a: None)
    assert first["algo_events"] == 15 and first["algo_candles"] == 142 and first["algo_levels"] == 2
    assert first["toi_session"] == 1 and first["toi_snapshot"] == 1 and first["pt_orders"] == 1
    assert first["pt_accounts"] == 1 and first["algo_daily_summary"] == 0  # no state rows for 23-Oct in this import
    second = import_legacy.run(pg, paper, str(data), str(logs), out=lambda *a: None)
    assert all(v == 0 for v in second.values()), second
    with pg._cursor() as cur:
        cur.execute("SELECT count(*), count(DISTINCT uid) FROM algo_events")
        assert cur.fetchone() == (15, 15)


def test_daily_summary_matches_the_trades_of_a_sample_day(db):
    pg, paper = db
    clock = Clock()
    clock.now = at("09:20")
    svc = PaperService(paper, FakeFeed(), Instruments(), clock=clock)
    algo = AlgoService(paper, svc, Instruments(), make_data(), clock, mode="paper", log_dir=tempfile.mkdtemp(),
                       variant="B", shadows=("A", "C", "D"))
    algo.filters = lambda sym, end, now, r=None: dict(GOOD_CE)
    breakout_entry(algo, svc, clock)
    books(svc, clock, at("10:20"), {ce(22800): 190.0})
    tick(svc, clock, at("10:21"), 22991)
    rows = {(r["index"], r["variant"]): r for r in write_day_summaries(paper, "2026-10-23")}
    live = rows[("NIFTY", "B")]
    t = algo.states["NIFTY"]["closed"][0]
    with pg._cursor() as cur:
        cur.execute("SELECT SUM(brokerage + stt + transaction + sebi + stamp + gst) FROM pt_trades WHERE account_id=%s",
                    (algo.broker.account["id"],))
        charges = round(cur.fetchone()[0], 2)
    assert live["is_live"] and live["entries"] == 1 and live["wins"] == 1 and live["losses"] == 0
    assert live["signals"] == 1 and live["points"] == pytest.approx(22991 - 22821, abs=0.01)
    assert live["gross_pnl"] == pytest.approx((189.95 - 120.05) * 65) and t["pnl"] == live["gross_pnl"]
    assert live["charges"] == pytest.approx(charges) and live["net_pnl"] == pytest.approx(live["gross_pnl"] - charges)
    for v in "ACD":
        sh = rows[("NIFTY", v)]
        assert not sh["is_live"] and sh["entries"] == 1 and sh["net_pnl"] is None and sh["gross_pnl"] is None
        assert sh["points"] == pytest.approx(22991 - 22821, abs=0.01)
    stored = paper.algo_summaries("2026-10-23", "2026-10-23", index="NIFTY", variant="B")
    assert stored[0]["net_pnl"] == pytest.approx(live["net_pnl"])
    assert day_summaries(paper, "2026-10-23") == list(rows.values())  # recomputable: the same numbers again


def test_range_queries_use_the_ist_trading_date_around_midnight(db):
    pg, paper = db
    late = datetime(2026, 10, 23, 23, 59, 59, tzinfo=IST)  # 18:29:59 UTC on the 23rd
    early = datetime(2026, 10, 24, 0, 0, 1, tzinfo=IST)  # 18:30:01 UTC on the 23rd: still the 24th in IST
    for ts in (late, early):
        paper.algo_add_event({"ts": ts.isoformat(), "trade_date": ts.date().isoformat(), "index": "NIFTY", "variant": "B",
                              "type": "info", "setup": "", "message": f"at {ts:%H:%M:%S}", "details": {}})
        paper.algo_save_state(ts.date().isoformat(), "NIFTY", "B", {"live": True, "closed": [], "trades": 0})
    paper.algo_save_summaries([
        {"trade_date": d, "index": "NIFTY", "variant": "B", "is_live": True, "signals": 1, "entries": 0, "wins": 0,
         "losses": 0, "points": 0.0, "gross_pnl": 0.0, "charges": 0.0, "net_pnl": n}
        for d, n in (("2026-10-23", 100.0), ("2026-10-24", -50.0), ("2026-10-25", 7.0))])
    with pg._cursor() as cur:
        cur.execute("SET TIME ZONE 'UTC'")  # a UTC session must not move anything to another day
    assert [e["message"] for e in paper.algo_events("2026-10-24")] == ["at 00:00:01"]
    assert [e["message"] for e in paper.algo_events("2026-10-23")] == ["at 23:59:59"]
    assert [r["trade_date"] for r in paper.algo_summaries("2026-10-24", "2026-10-24")] == ["2026-10-24"]
    assert paper.algo_days("2026-10-24", "2026-10-24") == ["2026-10-24"]
    rep = range_report(paper, "2026-10-23", "2026-10-24", variant="B")
    assert [d["trade_date"] for d in rep["days"]] == ["2026-10-23", "2026-10-24"]
    assert rep["tiles"]["netPnl"] == 50.0 and rep["tiles"]["bestDay"] == ("2026-10-23", 100.0)
    assert rep["tiles"]["worstDay"] == ("2026-10-24", -50.0)


def test_day_view_loads_23_oct_from_postgres(db, tmp_path):
    pg, paper = db
    logs = tmp_path / "logs"
    logs.mkdir()
    shutil.copy(LOG, logs / "algo-2026-10-23.log")
    import_legacy.run(pg, paper, str(tmp_path / "none"), str(logs), out=lambda *a: None)
    clock = Clock()
    clock.now = datetime(2026, 10, 26, 9, 0, tzinfo=IST)
    algo = AlgoService(paper, None, Instruments(), make_data(), clock, mode="signals", log_dir=str(tmp_path / "other"))
    app = FastAPI()
    algo_api.register(app, algo)
    c = TestClient(app)
    for q in ("2026-10-23", "23-10-2026"):
        d = c.get(f"/api/algo/day?date={q}").json()
        assert d["date"] == "2026-10-23"
        assert d["levels"]["NIFTY"]["levels"] == {"R1": 22800.0, "R2": 23000.0, "R3": 23200.0, "S1": 22700.0,
                                                  "S2": 22600.0, "S3": 22500.0}
        assert d["levels"]["BANKNIFTY"]["levels"]["R1"] == 54800.0 and d["levels"]["NIFTY"]["spot"] == 22730.2
        assert len(d["candles"]) == 142 and {x["index"] for x in d["candles"]} == {"NIFTY", "BANKNIFTY"}
        first = next(x for x in d["candles"] if x["index"] == "NIFTY")
        assert first["candle_start"].startswith("2026-10-23T09:20") and first["rsi"] == pytest.approx(61.3, abs=0.05)
        assert first["toi_sentiment"] and first["oi_change"] in ("BULLISH", "BEARISH", "NEUTRAL")
        assert len(d["events"]) == 15 and d["events"][0]["ts"] >= d["events"][-1]["ts"]
        assert {e["variant"] for e in d["events"]} == {"A"}
    assert c.get("/api/algo/day?date=2026-10-22").json()["events"] == []
