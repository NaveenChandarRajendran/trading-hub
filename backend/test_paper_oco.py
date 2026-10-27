"""paper_engine.py OCO protection (set_protection): a target (LIMIT SELL) + stop (SL-M SELL) pair per position.
Rules (Naveen, 27-Oct-2026): the pair never blocks a manual partial sell; both legs follow the open quantity (a partial
sell shrinks them, buying more grows them); prices on the 0.05 grid; one leg filling cancels the other."""
import pytest

from paper_engine import (BUY, CANCELLED, FILLED, KEEP, LIMIT, MARKET, PENDING, REJECTED, SELL, SLM, OrderError,
                          PaperEngine)
from test_paper_engine import LOT, SID, at, book, bought, engine


def legs(e):
    t, s = e.protection(SID)
    return (t and (t.price, t.qty, t.status)), (s and (s.trigger_price, s.qty, s.status))


def test_target_and_stop_together_no_longer_rejected_as_exceeding_open_qty():
    """The 21-Oct bug: with an SL pending, a target on the same position was rejected (qty counted twice)."""
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), stop=90.0)
    e.set_protection(SID, at("09:31"), target=120.0)
    assert legs(e) == ((120.0, LOT, PENDING), (90.0, LOT, PENDING))
    t, s = e.protection(SID)
    assert t.oco_group == s.oco_group != "" and t.side == s.side == SELL and (t.order_type, s.order_type) == (LIMIT, SLM)


def test_target_fill_cancels_the_stop():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    _, s = e.protection(SID)
    events = e.on_tick(SID, book(120.5, bids=[(120.2, 500)], asks=[(120.5, 500)]), at("09:40"))
    assert s.status == CANCELLED and "other leg of the OCO pair" in s.reason
    assert e.positions[SID].open_qty == 0 and e.protection(SID) == (None, None)
    assert [(ev.kind, ev.data["status"]) for ev in events if ev.kind == "order"][-1] == ("order", CANCELLED)


def test_stop_fill_cancels_the_target():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    t, s = e.protection(SID)
    e.on_tick(SID, book(89.5, bids=[(89.4, 500)], asks=[(89.6, 500)]), at("09:40"))
    assert s.status == FILLED and t.status == CANCELLED and e.positions[SID].open_qty == 0


def test_manual_partial_sell_allowed_and_both_legs_shrink():
    e = engine()
    bought(e, lots=3)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    o, _ = e.place_order(SID, SELL, 1, LOT, MARKET, at("09:32"))  # (a): the pair does not block it
    assert o.status == FILLED
    assert legs(e) == ((120.0, 2 * LOT, PENDING), (90.0, 2 * LOT, PENDING))


def test_buying_more_grows_both_legs_at_the_same_prices():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    e.place_order(SID, BUY, 2, LOT, MARKET, at("09:32"))  # (b)
    assert legs(e) == ((120.0, 3 * LOT, PENDING), (90.0, 3 * LOT, PENDING))


def test_modify_and_cancel_each_leg():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    t0, s0 = e.protection(SID)
    e.set_protection(SID, at("09:32"), target=125.0)  # move the target, stop untouched
    e.set_protection(SID, at("09:33"), stop=92.5)
    t, s = e.protection(SID)
    assert (t.id, s.id) == (t0.id, s0.id) and legs(e) == ((125.0, LOT, PENDING), (92.5, LOT, PENDING))
    e.set_protection(SID, at("09:34"), target=None)  # cancel the target only
    assert e.protection(SID)[0] is None and t.status == CANCELLED and s.status == PENDING
    e.set_protection(SID, at("09:35"), target=130.0, stop=None)
    t2, s2 = e.protection(SID)
    assert t2.price == 130.0 and s2 is None and t2.oco_group == s.oco_group  # same pair id for the position


@pytest.mark.parametrize("kw, msg", [
    ({"target": 99.0}, "Target 99 must be above LTP 100"),
    ({"stop": 100.0}, "Stop 100 must be below LTP 100"),
    ({"target": 110.0, "stop": 0.0}, "must be above 0"),
    ({"target": 110.02}, "multiple of 0.05"),
])
def test_invalid_prices_change_nothing(kw, msg):
    e = engine()
    bought(e)
    with pytest.raises(OrderError, match=msg):
        e.set_protection(SID, at("09:31"), **kw)
    assert e.protection(SID) == (None, None)


def test_stop_must_stay_below_target_and_needs_an_open_position():
    e = engine()
    with pytest.raises(OrderError, match="No open position"):
        e.set_protection(SID, at("09:31"), stop=90.0)
    bought(e)
    e.set_protection(SID, at("09:31"), target=105.0)
    e.on_tick(SID, book(104, bids=[(103.9, 500)], asks=[(104, 500)]), at("09:32"))
    with pytest.raises(OrderError, match="Stop 104.5 must be below LTP 104"):
        e.set_protection(SID, at("09:33"), stop=104.5)
    assert e.protection(SID)[1] is None


def test_exit_cancels_the_pair_and_market_closed_refuses():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    t, s = e.protection(SID)
    e.exit_position(SID, at("09:40"))
    assert t.status == s.status == CANCELLED and e.positions[SID].open_qty == 0
    bought(e, now="09:45")
    with pytest.raises(OrderError, match="Market closed"):
        e.set_protection(SID, at("15:20"), target=120.0)


def test_keep_leaves_a_leg_untouched_and_restore_keeps_the_pair():
    e = engine()
    bought(e)
    e.set_protection(SID, at("09:31"), target=120.0, stop=90.0)
    assert e.set_protection(SID, at("09:32"), target=KEEP, stop=KEEP) == []
    r = PaperEngine(100_000)
    r.restore([o.to_dict() for o in e.orders.values()], [t.to_dict() for t in e.trades])
    t, s = r.protection(SID)
    assert (t.price, s.trigger_price, t.oco_group == s.oco_group) == (120.0, 90.0, True)


def test_plain_sell_orders_still_count_against_each_other():
    """Non-OCO behaviour is unchanged: two manual sells can't add up to more than the open quantity."""
    e = engine()
    bought(e)
    e.place_order(SID, SELL, 1, LOT, LIMIT, at("09:31"), price=120.0)
    o, _ = e.place_order(SID, SELL, 1, LOT, SLM, at("09:31"), trigger_price=90.0)
    assert o.status == REJECTED and "exceeds" in o.reason
