"""last_trades.py on Dhan's raw data for SENSEX 5 Nov 2026 CE, captured 29-Oct after the close: the option chain sends
the previous close as last_price for legs with no trade today; the quote API has the real last traded price."""
from datetime import datetime

from chain_cache import Entry
from dhan_client import DhanError, parse_last_trades
from last_trades import LastTrades, correct_rows

# option chain (REST) legs as Dhan sent them
C76900 = {"average_price": 0, "implied_volatility": 20.3145, "last_price": 120, "oi": 80, "previous_close_price": 120,
          "previous_oi": 80, "previous_volume": 20, "security_id": 1134183, "top_ask_price": 0, "top_bid_price": 0, "volume": 0}
C77000 = {"average_price": 15.42, "implied_volatility": 13.7164, "last_price": 18.3, "oi": 237540, "previous_close_price": 14.15,
          "previous_oi": 114600, "previous_volume": 352760, "security_id": 1134390, "top_ask_price": 0, "top_bid_price": 0,
          "volume": 757700}
C77200 = {"average_price": 0, "implied_volatility": 37.6027, "last_price": 548.5, "oi": 0, "previous_close_price": 548.5,
          "previous_oi": 0, "previous_volume": 0, "security_id": 1134419, "top_ask_price": 0, "top_bid_price": 0, "volume": 0}
ROWS = [{"strike": 76900.0, "ce": C76900, "pe": None}, {"strike": 77000.0, "ce": C77000, "pe": None},
        {"strike": 77200.0, "ce": C77200, "pe": None}]
# /marketfeed/quote for the same IDs (trimmed to the fields used)
QUOTE = {"status": "success", "data": {"BSE_FNO": {
    "1134183": {"last_price": 4.75, "last_trade_time": "29/10/2026 00:00:00", "volume": 0, "oi": 80, "ohlc": {"close": 4.75}},
    "1134419": {"last_price": 0, "volume": 0, "oi": 0}}}}


def test_quote_parsing():
    assert parse_last_trades(QUOTE, "BSE_FNO") == {1134183: {"ltp": 4.75, "time": "29/10/2026 00:00:00"},
                                                   1134419: {"ltp": 0.0, "time": None}}


def test_no_trade_today_takes_the_real_last_trade_never_the_previous_close():
    fixed = correct_rows(ROWS, parse_last_trades(QUOTE, "BSE_FNO"))
    a, b, c = (r["ce"] for r in fixed)
    assert (a["last_price"], a["chain_last_price"], a["traded_today"], a["last_trade_time"]) == (4.75, 120, False, "29/10/2026 00:00:00")
    assert (b["last_price"], b["traded_today"]) == (18.3, True) and "chain_last_price" not in b  # traded: Dhan's chain is right
    assert (c["last_price"], c["chain_last_price"], c["traded_today"]) == (0.0, 548.5, False)  # never traded: no price
    assert ROWS[0]["ce"]["last_price"] == 120  # the cached chain (the Trending OI tracker's) is not changed


def test_quote_failure_shows_no_price():
    a = correct_rows(ROWS, None)[0]["ce"]
    assert (a["last_price"], a["last_price_unknown"]) == (0.0, True)


class Client:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def last_trades(self, segment, ids):
        self.calls.append((segment, ids))
        if self.fail:
            raise DhanError("Dhan HTTP 429")
        return parse_last_trades(QUOTE, "BSE_FNO")


def test_one_quote_call_per_fresh_chain_on_the_index_segment():
    c, t0 = Client(), datetime(2026, 10, 29, 15, 0)
    lt = LastTrades(c)
    e = Entry({}, t0)
    assert lt.rows("SENSEX", "2026-11-05", e, ROWS)[0]["ce"]["last_price"] == 4.75
    lt.rows("SENSEX", "2026-11-05", e, ROWS)  # same chain: reused
    assert c.calls == [("BSE_FNO", [1134183, 1134419])]  # only the legs with no trade today
    lt.rows("SENSEX", "2026-11-05", Entry({}, datetime(2026, 10, 29, 15, 0, 10)), ROWS)  # chain fetched again
    assert len(c.calls) == 2
    lt.rows("NIFTY", "2026-11-03", e, ROWS)
    assert c.calls[-1][0] == "NSE_FNO"


def test_a_failed_quote_call_is_tried_again():
    c = Client(fail=True)
    lt = LastTrades(c)
    e = Entry({}, datetime(2026, 10, 29, 15, 0))
    assert lt.rows("SENSEX", "2026-11-05", e, ROWS)[0]["ce"]["last_price_unknown"] is True
    lt.rows("SENSEX", "2026-11-05", e, ROWS)
    assert len(c.calls) == 2
