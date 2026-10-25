"""A strategy book is its own Rs 1 lakh paper account: fills on the live order book it is fed, keeps its own orders
and trades on disk, and never touches the main paper account."""
from datetime import datetime

from holidays import NSE_HOLIDAYS
from paper_engine import Book
from store import IST
from strategy_books import StrategyBook


class Service:
    holidays = NSE_HOLIDAYS

    def __init__(self):
        self.now = datetime(2026, 10, 26, 10, 0, tzinfo=IST)
        self.watched = {}

    def clock(self):
        return self.now

    def _instrument(self, sid):
        return {"lotSize": 65, "name": f"NIFTY {sid}", "symbol": "NIFTY"}

    def _with_instrument(self, d):
        return {**d, "name": f"NIFTY {d['security_id']}"}

    def watch(self, ids, group="auto"):
        self.watched[group] = ids


def test_book_fills_on_its_own_and_survives_a_restart(tmp_path):
    svc = Service()
    b = StrategyBook("dharani", svc, data_dir=str(tmp_path))
    assert b.funds()["openingBalance"] == 100000
    b.on_tick(111, Book(250.0, [(249.9, 1000)], [(250.1, 1000)]), svc.now)
    assert b.has_book(111) and b.ltp(111) == 250.0
    o = b.place_order(111, "BUY", 1, "MARKET")
    assert o["status"] == "FILLED" and b.open_qty(111) == 65
    stop = b.place_order(111, "SELL", 1, "SL-M", trigger_price=225.0)
    assert stop["status"] == "PENDING"
    b.watch([111])
    assert svc.watched == {"book-dharani": [111]}
    # a restart reads the same day back from data/books/dharani/paper.json
    b2 = StrategyBook("dharani", svc, data_dir=str(tmp_path))
    assert b2.open_qty(111) == 65 and len(b2.orders()) == 2 and len(b2.trades()) == 1
    # the stop triggers when the price falls through it
    b2.on_tick(111, Book(224.0, [(223.9, 1000)], [(224.1, 1000)]), svc.now)
    assert b2.open_qty(111) == 0 and b2.funds()["realized"] < 0
