"""paper_engine.py: fill rules, funds, session rules and the 15:15 square-off.
Wednesday 21-Oct-2026 is a trading day (20-Oct is a holiday in holidays.py). Lot size 75 is only test data."""
from datetime import datetime

import pytest

from paper_charges import order_charges
from paper_engine import (BUY, CANCELLED, FILLED, LIMIT, MARKET, PENDING, REJECTED, SELL, SL, SLM, TRIGGERED, Book,
                          OrderError, PaperEngine, walk_depth)
from store import IST

SID, LOT = 52175, 75


def at(hm, day="2026-10-21"):
    return datetime.fromisoformat(f"{day}T{hm}:00").replace(tzinfo=IST)


def book(ltp, bids=(), asks=()):
    return Book(ltp, list(bids), list(asks))


def engine(capital=100_000, b=None):
    e = PaperEngine(capital)
    e.on_tick(SID, b or book(100, bids=[(99.9, 500)], asks=[(100, 500)]), at("09:20"))
    return e


def bought(e, lots=1, now="09:30"):
    """Opens a long at 100."""
    o, _ = e.place_order(SID, BUY, lots, LOT, MARKET, at(now))
    assert o.status == FILLED and o.avg_price == 100
    return o


# ---------- depth walk ----------
def test_walk_depth_vwap():
    # 50 @ 100 + 50 @ 100.5 + 50 @ 101 = 15,075 -> 100.50
    assert walk_depth([(100, 50), (100.5, 50), (101, 100)], 150) == (100.5, 15075.0, False)


def test_walk_depth_capped_at_worst_level():
    # 100 visible: 50 @ 100 + 50 @ 100.5, remaining 50 at the worst level 100.5 -> 15,050 / 150
    avg, value, capped = walk_depth([(100, 50), (100.5, 50)], 150)
    assert (value, capped) == (15050.0, True)
    assert avg == pytest.approx(100.3333, abs=1e-4)


def test_walk_depth_skips_empty_levels():
    assert walk_depth([(0, 0), (101, 0), (102, 10)], 5) == (102, 510.0, False)
    assert walk_depth([], 5) is None


def test_market_buy_walks_asks():
    e = engine(b=book(100, bids=[(99.5, 100)], asks=[(100.5, 50), (100, 50), (101, 100)]))  # unsorted on purpose
    o, events = e.place_order(SID, BUY, 2, LOT, MARKET, at("09:30"))
    # 50 @ 100 + 50 @ 100.5 + 50 @ 101
    assert (o.status, o.avg_price, o.slippage_capped) == (FILLED, 100.5, False)
    assert [ev.kind for ev in events] == ["order", "order", "trade", "position"]


def test_market_buy_flags_slippage_cap():
    e = engine(b=book(100, bids=[(99.5, 100)], asks=[(100, 50), (100.5, 50)]))
    o, _ = e.place_order(SID, BUY, 2, LOT, MARKET, at("09:30"))
    assert o.status == FILLED and o.slippage_capped


def test_market_sell_walks_bids():
    e = engine()
    bought(e, lots=2)
    e.on_tick(SID, book(110, bids=[(110, 100), (109.5, 100)], asks=[(110.5, 100)]), at("10:00"))
    o, _ = e.place_order(SID, SELL, 2, LOT, MARKET, at("10:00"))
    # 100 @ 110 + 50 @ 109.5 = 16,475 / 150
    assert o.status == FILLED and o.avg_price == pytest.approx(109.8333, abs=1e-4)


def test_market_buy_with_no_sellers_rejected():
    e = engine(b=book(100, bids=[(99.5, 100)], asks=[]))
    o, _ = e.place_order(SID, BUY, 1, LOT, MARKET, at("09:30"))
    assert o.status == REJECTED and "sellers" in o.reason


# ---------- limit ----------
def test_limit_buy_not_filled_on_ltp_touch():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=99)
    assert o.status == PENDING
    e.on_tick(SID, book(99, bids=[(98.95, 100)], asks=[(99.5, 100)]), at("09:31"))  # LTP = limit, ask above
    assert o.status == PENDING


def test_limit_buy_fills_at_best_ask_when_ask_at_or_below_limit():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=99)
    e.on_tick(SID, book(98.9, bids=[(98.8, 100)], asks=[(98.9, 10)]), at("09:31"))
    # price improvement: 98.90, and the whole 75 at best ask (no partial fills; only 10 shown)
    assert (o.status, o.avg_price) == (FILLED, 98.9)
    assert e.positions[SID].open_qty == 75


def test_marketable_limit_fills_immediately():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=101)
    assert (o.status, o.avg_price) == (FILLED, 100)


def test_limit_sell_fills_when_bid_at_or_above_limit():
    e = engine()
    bought(e)
    o, _ = e.place_order(SID, SELL, 1, LOT, LIMIT, at("09:40"), price=110)
    e.on_tick(SID, book(110, bids=[(109.95, 100)], asks=[(110.05, 100)]), at("09:41"))
    assert o.status == PENDING
    e.on_tick(SID, book(110.2, bids=[(110.1, 100)], asks=[(110.3, 100)]), at("09:42"))
    assert (o.status, o.avg_price) == (FILLED, 110.1)


# ---------- stops ----------
def test_slm_sell_triggers_on_ltp_and_fills_at_market():
    e = engine()
    bought(e)
    o, _ = e.place_order(SID, SELL, 1, LOT, SLM, at("09:40"), trigger_price=90)
    e.on_tick(SID, book(90.05, bids=[(90, 100)], asks=[(90.1, 100)]), at("09:41"))
    assert o.status == PENDING
    e.on_tick(SID, book(89.95, bids=[(89.5, 50), (89, 100)], asks=[(90, 100)]), at("09:42"))
    # 50 @ 89.5 + 25 @ 89 = 6,700 / 75
    assert o.status == FILLED and o.avg_price == pytest.approx(89.3333, abs=1e-4)


def test_sl_sell_triggers_then_rests_as_limit():
    e = engine()
    bought(e)
    o, _ = e.place_order(SID, SELL, 1, LOT, SL, at("09:40"), price=89, trigger_price=90)
    e.on_tick(SID, book(89.9, bids=[(88.5, 100)], asks=[(89.9, 100)]), at("09:41"))
    assert o.status == TRIGGERED  # triggered, but best bid 88.50 < limit 89
    e.on_tick(SID, book(89.3, bids=[(89.2, 100)], asks=[(89.4, 100)]), at("09:42"))
    assert (o.status, o.avg_price) == (FILLED, 89.2)


def test_slm_buy_mirrors():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, SLM, at("09:30"), trigger_price=110)
    e.on_tick(SID, book(109.95, bids=[(109.9, 100)], asks=[(110, 100)]), at("09:31"))
    assert o.status == PENDING
    e.on_tick(SID, book(110, bids=[(109.95, 100)], asks=[(110.1, 100)]), at("09:32"))
    assert (o.status, o.avg_price) == (FILLED, 110.1)


def test_stop_trigger_on_wrong_side_of_ltp_rejected():
    e = engine()
    bought(e)
    o, _ = e.place_order(SID, SELL, 1, LOT, SLM, at("09:40"), trigger_price=100)  # LTP is 100
    assert o.status == REJECTED and "below LTP" in o.reason


# ---------- modify / cancel ----------
def test_modify_price_to_marketable_fills():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=95)
    e.modify_order(o.id, at("09:31"), price=100)
    assert (o.status, o.avg_price) == (FILLED, 100)


def test_modify_lots_reblocks_funds():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=95)
    e.modify_order(o.id, at("09:31"), lots=2)
    assert o.qty == 150
    assert o.blocked == 14250 + order_charges(BUY, 14250).total
    assert e.funds()["used"] == o.blocked


def test_modify_rejected_leaves_order_unchanged():
    e = engine(capital=10_000)
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=95)
    with pytest.raises(OrderError, match="Insufficient funds"):
        e.modify_order(o.id, at("09:31"), lots=5)
    assert (o.lots, o.status) == (1, PENDING)


def test_cancel_releases_block():
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=95)
    assert e.funds()["used"] > 0
    e.cancel_order(o.id, at("09:31"))
    assert o.status == CANCELLED and e.funds()["available"] == 100_000


def test_cannot_modify_or_cancel_filled_order():
    e = engine()
    o = bought(e)
    with pytest.raises(OrderError):
        e.modify_order(o.id, at("09:31"), price=101)
    with pytest.raises(OrderError):
        e.cancel_order(o.id, at("09:31"))


def test_triggered_sl_trigger_cannot_change():
    e = engine()
    bought(e)
    o, _ = e.place_order(SID, SELL, 1, LOT, SL, at("09:40"), price=89, trigger_price=90)
    e.on_tick(SID, book(89.9, bids=[(88.5, 100)], asks=[(89.9, 100)]), at("09:41"))
    with pytest.raises(OrderError, match="only the limit price"):
        e.modify_order(o.id, at("09:42"), trigger_price=88)
    e.modify_order(o.id, at("09:42"), price=88.5)  # limit can change -> marketable -> fills
    assert (o.status, o.avg_price) == (FILLED, 88.5)


# ---------- buy-only and funds ----------
def test_sell_without_position_rejected():
    o, _ = engine().place_order(SID, SELL, 1, LOT, MARKET, at("09:30"))
    assert o.status == REJECTED and "short selling" in o.reason


def test_sell_exceeding_open_qty_rejected():
    e = engine()
    bought(e)
    o, _ = e.place_order(SID, SELL, 2, LOT, MARKET, at("09:40"))
    assert o.status == REJECTED


def test_pending_sell_counts_against_open_qty():
    e = engine()
    bought(e)
    first, _ = e.place_order(SID, SELL, 1, LOT, LIMIT, at("09:40"), price=120)
    second, _ = e.place_order(SID, SELL, 1, LOT, SLM, at("09:41"), trigger_price=90)
    assert first.status == PENDING and second.status == REJECTED


def test_insufficient_funds_rejected():
    e = engine(capital=7_000)  # 75 x 100 = 7,500 premium
    o, _ = e.place_order(SID, BUY, 1, LOT, MARKET, at("09:30"))
    assert o.status == REJECTED and "Insufficient funds" in o.reason
    assert e.funds()["available"] == 7_000


def test_buy_blocks_premium_plus_charges():
    e = engine()
    e.place_order(SID, BUY, 1, LOT, LIMIT, at("09:30"), price=95)
    # 75 x 95 = 7,125 + charges on it
    assert e.funds()["used"] == 7125 + order_charges(BUY, 7125).total


def test_round_trip_pnl_and_funds():
    e = engine()
    bought(e)  # 75 @ 100 = 7,500
    e.on_tick(SID, book(120, bids=[(120, 500)], asks=[(120.05, 500)]), at("10:00"))
    assert e.unrealized() == 1500.0
    e.place_order(SID, SELL, 1, LOT, MARKET, at("10:00"))  # 75 @ 120 = 9,000
    f = e.funds()
    # charges 26.95 (buy) + 40.83 (sell), see test_paper_charges.py
    assert f == {"capital": 100000.0, "realized": 1500.0, "charges": 67.78, "used": 0.0, "available": 101432.22}
    assert e.positions[SID].open_qty == 0 and e.unrealized() == 0


def test_realized_uses_average_prices():
    e = engine()
    bought(e)  # 75 @ 100
    e.on_tick(SID, book(110, bids=[(109.9, 500)], asks=[(110, 500)]), at("09:40"))
    e.place_order(SID, BUY, 1, LOT, MARKET, at("09:40"))  # 75 @ 110 -> avg 105
    e.place_order(SID, SELL, 1, LOT, MARKET, at("09:41"))  # 75 @ 109.9
    p = e.positions[SID]
    assert (p.avg_buy, p.open_qty, p.realized) == (105, 75, 367.5)  # 75 x (109.9 - 105)
    assert e.funds()["used"] == 7875  # 75 open x avg 105


# ---------- session ----------
@pytest.mark.parametrize("now", [at("09:14"), at("15:15"), at("15:29"), at("10:00", day="2026-10-20"),
                                 at("10:00", day="2026-10-24")])
def test_orders_rejected_outside_session(now):
    e = engine()
    o, _ = e.place_order(SID, BUY, 1, LOT, MARKET, now)
    assert o.status == REJECTED and "Market closed" in o.reason


def test_auto_square_off_at_1515():
    e = engine()
    bought(e, lots=2)
    sl, _ = e.place_order(SID, SELL, 1, LOT, SLM, at("10:00"), trigger_price=90)
    buy, _ = e.place_order(SID, BUY, 1, LOT, LIMIT, at("10:01"), price=95)
    e.on_tick(SID, book(105, bids=[(105, 500)], asks=[(105.05, 500)]), at("15:14"))
    assert e.positions[SID].open_qty == 150

    events = e.on_time(at("15:15"))
    assert sl.status == CANCELLED and buy.status == CANCELLED
    assert e.positions[SID].open_qty == 0
    assert e.trades[-1].price == 105 and e.trades[-1].qty == 150
    assert e.funds()["used"] == 0
    assert any(ev.kind == "trade" for ev in events)
    assert e.on_time(at("15:16")) == []  # once per day
    o, _ = e.place_order(SID, BUY, 1, LOT, MARKET, at("15:16"))
    assert o.status == REJECTED


def test_square_off_runs_on_late_tick_and_without_bids():
    e = engine()
    bought(e)
    events = e.on_tick(SID, book(101, bids=[], asks=[(101.5, 10)]), at("15:20"))
    t = e.trades[-1]
    assert t.side == SELL and t.price == 101  # no bids visible: filled at LTP and flagged
    assert e.orders[t.order_id].slippage_capped
    assert e.positions[SID].open_qty == 0 and events


def test_no_square_off_on_holiday():
    e = engine()
    assert e.on_time(at("15:20", day="2026-10-20")) == []


# ---------- exits ----------
def test_exit_position_cancels_pending_sells():
    e = engine()
    bought(e)
    target, _ = e.place_order(SID, SELL, 1, LOT, LIMIT, at("09:40"), price=130)
    e.exit_position(SID, at("09:45"))
    assert target.status == CANCELLED
    assert e.positions[SID].open_qty == 0 and e.trades[-1].price == 99.9


def test_exit_all_and_exit_without_position():
    e = engine()
    bought(e)
    e.on_tick(7, book(50, bids=[(49.9, 500)], asks=[(50, 500)]), at("09:31"))
    e.place_order(7, BUY, 1, LOT, MARKET, at("09:32"))
    e.exit_all(at("09:40"))
    assert all(p.open_qty == 0 for p in e.positions.values())
    with pytest.raises(OrderError):
        e.exit_position(SID, at("09:41"))


# ---------- bad input ----------
@pytest.mark.parametrize("kwargs, msg", [
    ({"lots": 0}, "lots"),
    ({"order_type": LIMIT}, "price is required"),
    ({"order_type": LIMIT, "price": 100.02}, "multiple of 0.05"),
    ({"order_type": SLM}, "triggerPrice is required"),
    ({"order_type": SL, "side": SELL, "price": 91, "trigger_price": 90}, "can't be above"),
    ({"order_type": SL, "side": BUY, "price": 89, "trigger_price": 90}, "can't be below"),
    ({"order_type": "BRACKET"}, "orderType"),
    ({"side": "SHORT"}, "side"),
])
def test_bad_input_raises(kwargs, msg):
    args = {"security_id": SID, "side": BUY, "lots": 1, "lot_size": LOT, "order_type": MARKET, "now": at("09:30")}
    args.update(kwargs)
    with pytest.raises(ValueError, match=msg):
        engine().place_order(**args)
