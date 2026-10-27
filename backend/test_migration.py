"""scripts/migrate_users_strategies.py on the throwaway TEST_DATABASE_URL database (skipped without it): today's shape
(Manual with an old reset period, Algo, Scalper; orders, fills, positions, algo rows, a Scalper daily summary) moves
under user naveen without losing a row, every P&L number stays the same, a second run changes nothing, and the backup
runs before anything changes. Teardown makes the strategy_id columns nullable again for the other Postgres tests."""
import os
import sys
from datetime import datetime

import pytest

from store import IST, PaperPgStore, PgStore

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import migrate_users_strategies as mig  # noqa: E402

DSN = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="set TEST_DATABASE_URL to run the migration tests")
DAY, DAY2 = "2026-10-21", "2026-10-22"
T = lambda d, hm: datetime.fromisoformat(f"{d}T{hm}:00").replace(tzinfo=IST)  # noqa: E731
CHARGES = {"brokerage": 20.0, "stt": 6.5, "transaction": 3.2, "sebi": 0.01, "stamp": 0.2, "gst": 4.18, "total": 34.09}


def relax(cur):
    for t in mig.NOT_NULL:
        cur.execute(f"ALTER TABLE {t} ALTER COLUMN strategy_id DROP NOT NULL")


@pytest.fixture
def db():
    pg = PgStore(DSN)
    with pg._cursor() as cur:
        relax(cur)
        cur.execute("TRUNCATE th_sessions, th_login_attempts, th_user_prefs, th_users, th_strategies, pt_accounts, "
                    "pt_daily_summary, scalper_daily_summary, algo_events, algo_state, algo_daily_summary "
                    "RESTART IDENTITY CASCADE")
    yield pg, PaperPgStore(pg)
    with pg._cursor() as cur:
        relax(cur)
    pg.close()


def fill(store, acc, day, n, sid, buy, sell, at):
    """A bought-and-sold round trip of 65 units: two orders, two fills, one closed position."""
    for i, (side, price) in enumerate((("BUY", buy), ("SELL", sell))):
        oid = f"PT{day.replace('-', '')}-{n}{i}"
        store.save_order(acc, day, {"id": oid, "security_id": sid, "side": side, "order_type": "MARKET", "lots": 1,
                                    "lot_size": 65, "price": None, "trigger_price": None, "status": "FILLED",
                                    "avg_price": price, "slippage_capped": False, "reason": "", "blocked": 0,
                                    "created_at": at, "updated_at": at, "filled_at": at})
        store.save_trade(acc, day, {"id": f"TR{day.replace('-', '')}-{n}{i}", "order_id": oid, "security_id": sid,
                                    "side": side, "qty": 65, "price": price, "value": price * 65, "charges": CHARGES,
                                    "time": at})
    store.save_position(acc, day, {"security_id": sid, "lot_size": 65, "buy_qty": 65, "sell_qty": 65, "avg_buy": buy,
                                   "avg_sell": sell, "realized": round((sell - buy) * 65, 2)})


def seed(store, algo=True):
    old = store.create_account(100000, T(DAY, "09:00"))           # manual, reset later
    fill(store, old["id"], DAY, 1, 111, 100.0, 110.0, T(DAY, "09:30"))
    store.archive_account(old["id"], T(DAY, "15:40"))
    manual = store.create_account(150000, T(DAY2, "09:00"))
    fill(store, manual["id"], DAY2, 2, 112, 120.0, 112.5, T(DAY2, "10:00"))
    scalper = store.create_account(100000, T(DAY, "09:00"), "Scalper")
    fill(store, scalper["id"], DAY2, 3, 113, 48.55, 51.0, T(DAY2, "11:00"))
    store.scalper_save_summary({"account_id": scalper["id"], "trade_date": DAY2, "trades": 1, "wins": 1, "losses": 0,
                                "fills": 2, "realized": 159.25, "charges": 68.18, "net": 91.07, "best_trade": 91.07,
                                "worst_trade": 91.07})
    accs = {"manual_old": old, "manual": manual, "scalper": scalper}
    if algo:
        a = store.create_account(100000, T(DAY, "09:00"), "Algo")
        fill(store, a["id"], DAY, 4, 114, 80.0, 88.0, T(DAY, "10:30"))
        store.algo_add_event({"ts": T(DAY, "10:30"), "trade_date": DAY, "index": "NIFTY", "variant": "B",
                              "type": "entry", "setup": "Range CE", "message": "entry", "details": {}})
        store.algo_save_state(DAY, "NIFTY", "B", {"trades": 1})
        store.algo_save_summaries([{"trade_date": DAY, "index": "NIFTY", "variant": "B", "is_live": True, "signals": 1,
                                    "entries": 1, "wins": 1, "losses": 0, "points": 8.0, "gross_pnl": 520.0,
                                    "charges": 68.18, "net_pnl": 451.82}])
        accs["algo"] = a
    return accs


def run(**kw):
    out = []
    before, after, result = mig.main(kw.pop("argv", []), dsn=DSN, backup=kw.pop("backup", lambda: "backup.sql"),
                                     log=out.append)
    return before, after, result, "\n".join(out)


def strategy_of(pg, acc):
    with pg._cursor() as cur:
        cur.execute("SELECT s.name, s.kind, s.capital FROM pt_accounts a JOIN th_strategies s ON s.id=a.strategy_id "
                    "WHERE a.id=%s", (acc,))
        return cur.fetchone()


def test_moves_everything_under_naveen_without_losing_a_row(db):
    pg, store = db
    accs = seed(store)
    calendars = {k: store.day_summary(a["id"], DAY, DAY2) for k, a in accs.items()}  # the P&L calendar's source
    before, after, result, out = run()
    for t in mig.COUNTED:  # no row lost or duplicated; only the new user, strategies and copied summary are added
        added = {"th_users": 1, "th_strategies": 3, "pt_daily_summary": 1}.get(t, 0)
        assert after[t] == before[t] + added, t
    assert before["pt_orders"] == 8 and before["pt_trades"] == 8 and before["algo_events"] == 1
    assert strategy_of(pg, accs["manual_old"]["id"]) == ("Manual (legacy)", "manual", 150000)  # open period's capital
    assert strategy_of(pg, accs["manual"]["id"]) == ("Manual (legacy)", "manual", 150000)
    assert strategy_of(pg, accs["scalper"]["id"]) == ("Scalper", "manual", 100000)
    assert strategy_of(pg, accs["algo"]["id"]) == ("OI Breakout Algo", "algo", 100000)
    with pg._cursor() as cur:
        cur.execute("SELECT username, display_name, password_hash, active FROM th_users")
        assert cur.fetchall() == [("naveen", "Naveen", None, True)]  # password set later with create_user.py
        for t in mig.NOT_NULL:
            cur.execute(f"SELECT count(*) FROM {t} WHERE strategy_id IS NULL")
            assert cur.fetchone()[0] == 0, t
            cur.execute("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' "
                        "AND table_name=%s AND column_name='strategy_id'", (t,))
            assert cur.fetchone()[0] == "NO", t
        cur.execute("SELECT DISTINCT s.name FROM algo_events e JOIN th_strategies s ON s.id=e.strategy_id")
        assert cur.fetchall() == [("OI Breakout Algo",)]
    # the old P&L reports show the same numbers
    assert {k: store.day_summary(a["id"], DAY, DAY2) for k, a in accs.items()} == calendars
    legacy = next(s for s in result["strategies"] if s[1] == "Manual (legacy)")
    assert legacy[4] == [round(650.0 - 487.5, 2), round(4 * 34.09, 2), 4]  # both manual periods added up
    assert "Backup written: backup.sql" in out and "(+3)" in out


def test_second_run_changes_nothing(db):
    _, store = db
    seed(store)
    run()
    before, after, result, out = run()
    assert before == after and result["made"] == [] and all(v == 0 for v in result["filled"].values())
    assert "none (already migrated)" in out


def test_backup_runs_first_and_a_failed_backup_stops_everything(db):
    pg, store = db
    seed(store)
    seen = []

    def backup():
        with pg._cursor() as cur:
            cur.execute("SELECT count(*) FROM th_strategies")
            seen.append(cur.fetchone()[0])
        return "b.sql"
    run(backup=backup)
    assert seen == [0]  # nothing migrated yet when the backup ran

    def broken():
        raise SystemExit("pg_dump failed")
    with pytest.raises(SystemExit, match="pg_dump failed"):
        run(backup=broken)


def test_dry_run_and_unknown_account_change_nothing(db):
    pg, store = db
    seed(store)
    with pg._cursor() as cur:
        before = mig.counts(cur)
    _, _, _, out = run(argv=["--dry-run"])
    assert "rolled back" in out
    with pg._cursor() as cur:
        assert mig.counts(cur) == before
        cur.execute("SELECT count(*) FROM pt_accounts WHERE strategy_id IS NOT NULL")
        assert cur.fetchone()[0] == 0
    store.create_account(100000, T(DAY, "09:00"), "Mystery")
    with pytest.raises(SystemExit, match="Unknown account names"):
        run()
    with pg._cursor() as cur:
        cur.execute("SELECT count(*) FROM th_strategies")
        assert cur.fetchone()[0] == 0


def test_algo_strategy_and_account_are_made_even_without_algo_data(db):
    pg, store = db
    seed(store, algo=False)
    _, after, result, _ = run()
    assert "OI Breakout Algo" in result["made"]
    algo = store.active_account("Algo")
    assert algo and strategy_of(pg, algo["id"])[:2] == ("OI Breakout Algo", "algo")


def test_writes_after_the_migration_carry_the_strategy(db):
    pg, store = db
    accs = seed(store)
    run()
    fill(store, accs["scalper"]["id"], DAY2, 9, 115, 10.0, 11.0, T(DAY2, "12:00"))
    store.algo_add_event({"ts": T(DAY2, "10:30"), "trade_date": DAY2, "index": "NIFTY", "variant": "B",
                          "type": "exit", "setup": "", "message": "exit", "details": {}})
    with pg._cursor() as cur:
        cur.execute("SELECT DISTINCT s.name FROM pt_orders o JOIN th_strategies s ON s.id=o.strategy_id "
                    "WHERE o.account_id=%s", (accs["scalper"]["id"],))
        assert cur.fetchall() == [("Scalper",)]
        cur.execute("SELECT count(*) FROM algo_events WHERE strategy_id IS NULL")
        assert cur.fetchone()[0] == 0
