"""The Trending OI Algo on a real Postgres: its own toi_algo_* tables (events, state, candles, summary, settings), the
strategy + account created once, its strategy card fed by its own broker (never the OI breakout algo's), and a
restart reading the open trade back from Postgres. Runs only with TEST_DATABASE_URL (a throwaway database: the
toi_algo_*, pt_* and th_* tables are TRUNCATEd)."""
import os
from datetime import datetime

import pytest

import trending_oi_algo_config as cfg
from main import strategy_live
from paper_api import PaperService
from store import IST, PaperPgStore, PgStore
from strategies import ensure_toi_strategy
from test_paper_api import FakeFeed
from test_toi_algo_service import DAY, Clock, Instruments, Market, entry, make, sid
from toi_algo_store import PgToiStore

DSN = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="set TEST_DATABASE_URL to run the Postgres Trending OI Algo tests")


@pytest.fixture
def pg():
    pg = PgStore(DSN)
    with pg._cursor() as cur:
        cur.execute("TRUNCATE toi_algo_events, toi_algo_state, toi_algo_candles, toi_algo_daily_summary, toi_algo_settings")
        cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users RESTART IDENTITY CASCADE")
        cur.execute("TRUNCATE pt_accounts RESTART IDENTITY CASCADE")
        cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen')")
    yield pg
    pg.close()


def test_strategy_and_account_are_created_once(pg):
    now = datetime(2026, 11, 12, 9, 0, tzinfo=IST)
    first = ensure_toi_strategy(pg, cfg.STRATEGY_NAME, cfg.CAPITAL, now, log=lambda m: None)
    assert ensure_toi_strategy(pg, cfg.STRATEGY_NAME, cfg.CAPITAL, now, log=lambda m: None) == first
    store = PaperPgStore(pg)
    st = store.strategy(first)
    assert (st["name"], st["kind"], st["capital"]) == ("Trending OI Algo", "algo", 500000.0)
    assert store.active_account(cfg.ACCOUNT_NAME)["strategy_id"] == first


def test_records_restart_and_the_strategy_card_on_postgres(pg):
    now = datetime(2026, 11, 12, 9, 0, tzinfo=IST)
    store = PaperPgStore(pg)
    store.create_strategy(1, "OI Breakout Algo", "", 100000, "algo", now, account_name="Algo")
    toi_sid = ensure_toi_strategy(pg, cfg.STRATEGY_NAME, cfg.CAPITAL, now, log=lambda m: None)
    clock, market, toi = Clock(), Market(), PgToiStore(pg)
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    svc = make(store, toi, paper, market, clock)
    entry(svc, paper, clock)
    assert toi.state(DAY)["open"]["lots"] == 2
    assert [e["type"] for e in toi.events(DAY)][-2:] == ["entry", "info"]
    assert toi.candles(DAY)[-1]["supertrend"] == 23200.0
    # the strategy card: its own broker's open position; the OI breakout algo's card is not mixed in
    unreal, open_n = strategy_live(paper, None, store.strategy(toi_sid), None, svc)
    assert open_n == 1
    # a restart reads the open trade back from Postgres and never enters again
    paper.listeners.remove(svc.on_packet)
    again = make(store, toi, paper, market, clock)
    again.tick(clock.now)
    assert again.state["open"]["securityId"] == sid(23200, "CE") and again.state["trades"] == 1
    svc.set_settings({"maxTrades": 1}, who="naveen")
    assert toi.settings()["maxTrades"] == 1 and toi.events(DAY)[-1]["details"]["old"] == 2
    row = again.write_summary()
    assert toi.summaries(DAY, DAY)[0]["trades"] == row["trades"] == 1
