"""The ORB Algo on a real Postgres: orb_algo_* tables, settings in th_algo_settings (slug "orb"), its strategy +
account created once, and a restart reading the open trade back. Runs only with TEST_DATABASE_URL (a throwaway
database: the orb_algo_*, th_algo_settings*, pt_* and th_* tables are TRUNCATEd)."""
import os
from datetime import datetime

import pytest

import orb_config as cfg
from orb_store import PgOrbStore
from paper_api import PaperService
from store import IST, PaperPgStore, PgStore
from strategies import ensure_algo_strategy
from test_orb_service import DAY, Clock, Instruments, Market, make, minute, morning, sid
from test_paper_api import FakeFeed

DSN = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="set TEST_DATABASE_URL to run the Postgres ORB Algo tests")


@pytest.fixture
def pg():
    pg = PgStore(DSN)
    with pg._cursor() as cur:
        cur.execute("TRUNCATE orb_algo_events, orb_algo_state, orb_algo_daily_summary, th_algo_settings, th_algo_settings_log")
        cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users RESTART IDENTITY CASCADE")
        cur.execute("TRUNCATE pt_accounts RESTART IDENTITY CASCADE")
        cur.execute("INSERT INTO th_users (username, display_name) VALUES ('naveen', 'Naveen')")
    yield pg
    pg.close()


def test_orb_records_settings_restart_and_summary_on_postgres(pg):
    now = datetime(2026, 11, 13, 9, 0, tzinfo=IST)
    first = ensure_algo_strategy(pg, cfg.STRATEGY_NAME, cfg.CAPITAL, now, log=lambda m: None)
    assert ensure_algo_strategy(pg, cfg.STRATEGY_NAME, cfg.CAPITAL, now, log=lambda m: None) == first
    store = PaperPgStore(pg)
    clock, market, orb = Clock(), Market(), PgOrbStore(pg)
    paper = PaperService(store, FakeFeed(), Instruments(), clock=clock)
    svc = make(store, orb, paper, market, clock)
    assert svc.broker.account["strategy_id"] == first
    svc.set_settings({"lots": 2}, who="naveen")
    morning(svc, paper, clock)
    minute(svc, paper, clock, "10:20", 24040, 24065, 24040, 24060)
    assert orb.state(DAY)["setups"]["b60"]["open"]["lots"] == 2
    assert [e["setup"] for e in orb.events(DAY) if e["type"] == "entry"] == ["b60"]
    assert orb.settings_store.overrides(cfg.SLUG) == {"lots": 2}
    # a restart reads the open trade back and never enters again
    market.history = [c for _t, c in sorted(svc.minutes.items())]
    paper.listeners.remove(svc.on_packet)
    again = make(store, orb, paper, market, clock)
    again.tick(clock.now)
    assert again.state["setups"]["b60"]["open"]["securityId"] == sid(24000, "CE") and again.state["trades"] == 1
    again.write_summary()  # the b60 trade is still open: no closed trade in any setup yet
    assert {r["setup"]: r["trades"] for r in orb.summaries(DAY, DAY)} == {"b60": 0, "r30": 0, "v5": 0}
    assert len(orb.states_between(DAY, DAY)) == 1
