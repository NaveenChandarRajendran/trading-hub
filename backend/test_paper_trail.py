"""paper_engine.py partial exits (exit_partial) and the trailing stop (set_trail). Rules (Naveen, 28-Oct-2026):
25 / 50 / 75 / 100 % of the open lots, rounded down, at least 1 lot; trail in option points (default 10, step 1),
optional start after a profit, only ever up, continues after a manual move at the new gap."""
import pytest

from paper_engine import CANCELLED, FILLED, PENDING, Order, OrderError, PaperEngine, partial_lots
from test_paper_engine import LOT, SID, at, book, bought, engine


def tick(e, ltp, hm="09:40"):
    return e.on_tick(SID, book(ltp, bids=[(ltp - 0.05, 5000)], asks=[(ltp, 5000)]), at(hm))


def stop_of(e):
    return e.protection(SID)[1]


# ---------- partial exit ----------
@pytest.mark.parametrize("open_lots, expected", [
    (1, {25: 1, 50: 1, 75: 1, 100: 1}),
    (2, {25: 1, 50: 1, 75: 1, 100: 2}),
    (3, {25: 1, 50: 1, 75: 2, 100: 3}),
    (4, {25: 1, 50: 2, 75: 3, 100: 4}),
    (8, {25: 2, 50: 4, 75: 6, 100: 8}),
    (10, {25: 2, 50: 5, 75: 7, 100: 10}),
])
def test_partial_lots_round_down_at_least_one(open_lots, expected):
    assert {pct: partial_lots(open_lots, pct) for pct in (25, 50, 75, 100)} == expected


def test_partial_exit_sells_that_share_and_the_legs_follow_the_rest():
    e = engine(capital=500_000)
    bought(e, lots=4)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    events = e.exit_partial(SID, 50, at("09:32"))
    sold = [ev.data for ev in events if ev.kind == "order" and ev.data["reason"] == "Partial exit 50%"]
    assert sold and sold[-1]["status"] == FILLED and sold[-1]["lots"] == 2
    assert e.positions[SID].open_qty == 2 * LOT
    t, s = e.protection(SID)
    assert (t.qty, s.qty, t.status, s.status) == (2 * LOT, 2 * LOT, PENDING, PENDING)


def test_a_partial_exit_of_everything_is_a_full_exit():
    e = engine()
    bought(e, lots=1)
    e.set_protection(SID, at("09:31"), stop=90.0)
    e.exit_partial(SID, 25, at("09:32"))  # 25 % of 1 lot = 1 lot = all of it
    assert e.positions[SID].open_qty == 0 and e.protection(SID) == (None, None)


def test_partial_exit_refusals():
    e = engine()
    with pytest.raises(OrderError, match="No open position"):
        e.exit_partial(SID, 50, at("09:32"))
    bought(e, lots=2)
    with pytest.raises(OrderError, match="25, 50, 75, 100"):
        e.exit_partial(SID, 30, at("09:32"))


# ---------- trailing stop ----------
def test_trail_places_the_stop_and_follows_new_highs_by_the_step_only_up():
    e = engine()
    bought(e)
    e.set_trail(SID, at("09:31"), 10)  # no stop yet: one at LTP 100 - 10
    s = stop_of(e)
    assert (s.trigger_price, s.trail_distance, s.trail_step, s.trail_high) == (90.0, 10, 1.0, 100)
    tick(e, 105)
    assert stop_of(e).trigger_price == 95.0
    tick(e, 105.5)
    assert stop_of(e).trigger_price == 95.0  # 95.50 is less than one step above 95
    tick(e, 106)
    assert stop_of(e).trigger_price == 96.0
    tick(e, 103)
    assert stop_of(e).trigger_price == 96.0  # never down
    tick(e, 95.9)  # hit: sold
    assert s.status == FILLED and e.positions[SID].open_qty == 0


def test_trail_rounds_down_to_the_tick_and_keeps_a_higher_stop():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), stop=95.0)
    e.set_trail(SID, at("09:31"), 10)  # 100 - 10 = 90 is below the stop: the stop stays
    assert stop_of(e).trigger_price == 95.0
    tick(e, 106.37)
    assert stop_of(e).trigger_price == 96.35  # 96.37 rounded down


def test_start_after_a_profit_keeps_the_stop_until_then():
    e = engine()
    bought(e)
    with pytest.raises(OrderError, match="Set a stop first"):
        e.set_trail(SID, at("09:31"), 5, after=10)
    e.set_protection(SID, at("09:31"), stop=90.0)
    e.set_trail(SID, at("09:31"), 5, after=10)
    tick(e, 108)
    assert stop_of(e).trigger_price == 90.0  # profit 8 < 10
    tick(e, 111)
    assert stop_of(e).trigger_price == 106.0


def test_a_manual_move_keeps_trailing_at_the_new_gap():
    e = engine()
    bought(e)
    e.set_trail(SID, at("09:31"), 10)
    e.set_protection(SID, at("09:32"), stop=95.0)  # dragged up to 5 below LTP 100
    assert (stop_of(e).trail_distance, stop_of(e).trigger_price) == (5.0, 95.0)
    tick(e, 103)
    assert stop_of(e).trigger_price == 98.0


def test_trail_off_and_cancelling_the_stop_end_it():
    e = engine()
    bought(e)
    e.set_trail(SID, at("09:31"), 10)
    e.set_trail(SID, at("09:32"), None)
    assert stop_of(e).trail_distance is None and stop_of(e).trigger_price == 90.0
    tick(e, 110)
    assert stop_of(e).trigger_price == 90.0  # off: no longer moves
    e.set_trail(SID, at("09:41"), 10)
    e.set_protection(SID, at("09:42"), stop=None)
    assert stop_of(e) is None
    tick(e, 120, "09:43")
    assert stop_of(e) is None  # nothing comes back


def test_trail_refusals():
    e = engine()
    bought(e)
    for bad, msg in ((0, "above 0"), (2.03, "multiple of 0.05"), (150, "more than the price")):
        with pytest.raises(OrderError, match=msg):
            e.set_trail(SID, at("09:31"), bad)
    with pytest.raises(OrderError, match="step"):
        e.set_trail(SID, at("09:31"), 10, step=0)
    assert stop_of(e) is None


def test_trail_survives_a_restart():
    e = engine()
    bought(e)
    e.set_trail(SID, at("09:31"), 10)
    tick(e, 104)
    r = PaperEngine(100_000)
    r.restore([o.to_dict() for o in e.orders.values()], [t.to_dict() for t in e.trades])
    tick(r, 104.5)  # the high since the last move counts again from here
    assert stop_of(r).trail_distance == 10 and stop_of(r).trigger_price == 94.0
    tick(r, 106)
    assert stop_of(r).trigger_price == 96.0
    assert Order.from_dict(stop_of(r).to_dict()).trail_step == 1.0


def test_partial_exit_keeps_the_trail_on_the_smaller_stop():
    e = engine(capital=500_000)
    bought(e, lots=4)
    e.set_trail(SID, at("09:31"), 10)
    e.exit_partial(SID, 75, at("09:32"))
    s = stop_of(e)
    assert (s.qty, s.trail_distance, s.status) == (LOT, 10, PENDING)
    tick(e, 112)
    assert stop_of(e).trigger_price == 102.0
    assert e.orders[s.id].status != CANCELLED
