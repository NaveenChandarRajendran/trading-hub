"""The two paper stores must behave the same. Runs against PaperJsonStore always, and against PaperPgStore when
TEST_DATABASE_URL is set, e.g.
    set TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/some_throwaway_db
The Postgres run TRUNCATEs the pt_ tables, so never point it at a database holding data you want to keep."""
import os
import shutil
import tempfile
from datetime import datetime

import pytest

from paper_engine import BUY, LIMIT, MARKET, SELL, Book, PaperEngine
from paper_levels import order_snapshot
from store import IST, PaperJsonStore, PaperPgStore, PgStore

DSN = os.getenv("TEST_DATABASE_URL")
SID, LOT = 52175, 65


def at(hm, day="2026-10-21"):
    return datetime.fromisoformat(f"{day}T{hm}:00").replace(tzinfo=IST)


@pytest.fixture(params=["json", "postgres"])
def store(request):
    if request.param == "json":
        tmp = tempfile.mkdtemp()
        yield PaperJsonStore(tmp)
        shutil.rmtree(tmp, ignore_errors=True)
        return
    if not DSN:
        pytest.skip("set TEST_DATABASE_URL to run the Postgres paper store tests")
    pg = PgStore(DSN)
    with pg._cursor() as cur:
        cur.execute("TRUNCATE pt_order_levels, pt_positions, pt_trades, pt_orders, pt_accounts RESTART IDENTITY CASCADE")
    yield PaperPgStore(pg)
    pg.close()


def save_events(store, acc, day, events):
    save = {"order": store.save_order, "trade": store.save_trade, "position": store.save_position}
    for ev in events:
        save[ev.kind](acc, day, ev.data)


def trade_day(store, acc, day, buy_px, sell_px):
    """One round trip: BUY 1 lot at buy_px, SELL at sell_px, plus one pending order left open."""
    e = PaperEngine(100_000, day=at("09:20", day).date())
    e.on_tick(SID, Book(buy_px, [(buy_px - 0.05, 500)], [(buy_px, 500)]), at("09:20", day))
    save_events(store, acc, day, e.place_order(SID, BUY, 1, LOT, MARKET, at("09:30", day))[1])
    e.on_tick(SID, Book(sell_px, [(sell_px, 500)], [(sell_px + 0.05, 500)]), at("10:00", day))
    save_events(store, acc, day, e.place_order(SID, SELL, 1, LOT, MARKET, at("10:00", day))[1])
    save_events(store, acc, day, e.place_order(SID, BUY, 1, LOT, LIMIT, at("10:05", day), price=50)[1])
    return e


def test_accounts(store):
    a = store.create_account(100_000, at("09:00"))
    assert store.active_account()["id"] == a["id"] and a["archived_at"] is None
    store.set_capital(a["id"], 200_000)
    assert store.active_account()["capital"] == 200_000
    store.archive_account(a["id"], at("09:01"))
    assert store.active_account() is None
    b = store.create_account(500_000, at("09:02"))
    assert store.active_account()["id"] == b["id"] != a["id"]
    assert [x["id"] for x in store.accounts()] == [a["id"], b["id"]]


def test_orders_and_trades_round_trip_into_the_engine(store):
    acc = store.create_account(100_000, at("09:00"))["id"]
    e = trade_day(store, acc, "2026-10-21", 100, 120)
    orders, trades = store.orders(acc, "2026-10-21"), store.trades(acc, "2026-10-21")
    assert [o["status"] for o in orders] == ["FILLED", "FILLED", "PENDING"]
    assert [t["side"] for t in trades] == ["BUY", "SELL"]
    assert trades[1]["charges"]["total"] == e.trades[1].charges.total

    r = PaperEngine(100_000, day=at("09:20").date())
    r.restore(orders, trades)
    assert r.funds() == e.funds()


def test_day_summary_and_net_before(store):
    acc = store.create_account(100_000, at("09:00"))["id"]
    d1 = trade_day(store, acc, "2026-10-21", 100, 120)  # +1,300 before charges
    d2 = trade_day(store, acc, "2026-10-22", 100, 90)   # -650
    rows = store.day_summary(acc, "2026-10-01", "2026-10-31")
    assert [(r["date"], r["realized"], r["trades"]) for r in rows] == [("2026-10-21", 1300.0, 2), ("2026-10-22", -650.0, 2)]
    assert rows[0]["charges"] == d1.funds()["charges"] and rows[1]["charges"] == d2.funds()["charges"]
    assert store.net_before(acc, "2026-10-22") == round(1300 - rows[0]["charges"], 2)
    assert store.net_before(acc, "2026-10-21") == 0
    assert store.day_summary(acc, "2026-10-22", "2026-10-22")[0]["date"] == "2026-10-22"


def test_accounts_are_separate(store):
    a = store.create_account(100_000, at("09:00"))["id"]
    trade_day(store, a, "2026-10-21", 100, 120)
    store.archive_account(a, at("16:00"))
    b = store.create_account(100_000, at("16:01"))["id"]
    assert store.orders(b, "2026-10-21") == [] and store.day_summary(b, "2026-10-01", "2026-10-31") == []
    assert len(store.day_summary(a, "2026-10-01", "2026-10-31")) == 1  # archived history still readable


def test_order_levels_round_trip(store):
    acc = store.create_account(100000, at("09:00"))["id"]
    snap = {"symbol": "NIFTY", "expiry": "2026-10-27", "date": "2026-10-21", "spot": 25060.0, "at": "2026-10-21 10:15",
            "levels": {"R1": 25200.0, "R2": 25300.0, "S1": 25000.0, "S2": 24900.0}}
    row = order_snapshot("PT20261021-0001", snap, at("10:15").isoformat())
    store.save_order_levels(acc, "2026-10-21", row)
    store.save_order_levels(acc, "2026-10-21", row)  # a retried write adds nothing
    assert store.order_levels(acc, "2026-10-21") == [row]
    assert row["zone"] == {"slot": "S1", "strike": 25000.0}
    assert store.order_levels(acc, "2026-10-22") == []
