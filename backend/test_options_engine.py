"""options_engine.py (ADR 0010): baskets all-or-nothing at market, signed positions across days, margin and funds,
exits, expiry settlement with STT on in-the-money longs, restore. Naveen's 3 Nov iron condor A from Dhan is the
reference: S 21950 PE @19.20, S 23800 CE @4.40, B 21700 PE @8.85, B 24050 CE @2.85, 1 lot (65)."""
from datetime import datetime

import pytest

from options_engine import BUY, SELL, Book, LegOrder, OptionsEngine, OrderError, OptPosition
from paper_charges import order_charges
from store import IST

LOT = 65
EXP = "2026-11-03"
IDS = {"SP": 101, "SC": 102, "BP": 103, "BC": 104}
PRICES = {"SP": 19.2, "SC": 4.4, "BP": 8.85, "BC": 2.85}
STRIKE = {"SP": 21950, "SC": 23800, "BP": 21700, "BC": 24050}


def at(hm, day="2026-10-28"):
    return datetime.fromisoformat(f"{day}T{hm}:00").replace(tzinfo=IST)


def leg(k, side=None, lots=1):
    side = side or (SELL if k[0] == "S" else BUY)
    return LegOrder(IDS[k], side, lots, LOT, "NIFTY", EXP, STRIKE[k], "PE" if k.endswith("P") else "CE")


def market(e, prices=PRICES, depth=5000):
    for k, p in prices.items():
        e.on_tick(IDS[k], Book(p, [(p, depth)], [(p, depth)]))  # bid = ask: fills at these prices


def condor(capital=200_000, margin=48_000.0, now="10:00"):
    e = OptionsEngine(capital)
    market(e)
    fills = e.place_basket([leg("SP"), leg("SC"), leg("BP"), leg("BC")], at(now), margin_after=margin)
    return e, fills


def charges_of(*pairs):
    return sum(order_charges(side, value).total for side, value in pairs)


# ---------- entry ----------
def test_iron_condor_entry_fills_every_leg_and_blocks_margin():
    e, fills = condor()
    assert [(f.side, f.qty, f.price, f.kind) for f in fills] == [
        (SELL, LOT, 19.2, "open"), (SELL, LOT, 4.4, "open"), (BUY, LOT, 8.85, "open"), (BUY, LOT, 2.85, "open")]
    assert len({f.basket_id for f in fills}) == 1
    assert {p.security_id: p.qty for p in e.open_positions()} == {101: -65, 102: -65, 103: 65, 104: 65}
    f = e.funds()
    charges = charges_of((SELL, 19.2 * 65), (SELL, 4.4 * 65), (BUY, 8.85 * 65), (BUY, 2.85 * 65))
    assert f["premiumOpen"] == pytest.approx(773.5)  # net credit 11.90 a unit
    assert f["charges"] == pytest.approx(charges, abs=0.02)
    assert f["cash"] == pytest.approx(200_000 + 773.5 - charges, abs=0.02)
    assert f["blockedMargin"] == 48_000.0
    assert f["available"] == pytest.approx(f["cash"] - 48_000, abs=0.02)


def test_all_or_nothing_and_refusals_change_nothing():
    e = OptionsEngine(200_000)
    market(e, {k: v for k, v in PRICES.items() if k != "BC"})  # the 24050 CE has no market
    with pytest.raises(OrderError, match="nothing was placed"):
        e.place_basket([leg("SP"), leg("SC"), leg("BP"), leg("BC")], at("10:00"), margin_after=48_000)
    assert (e.fills, e.open_positions(), e.blocked_margin) == ([], [], 0.0)
    market(e)
    with pytest.raises(OrderError, match="Margin unavailable"):  # Dhan didn't answer: refused, no estimate
        e.place_basket([leg("SP")], at("10:00"), margin_after=None)
    with pytest.raises(OrderError, match="Market closed"):
        e.place_basket([leg("SP")], at("15:16"), margin_after=48_000)
    with pytest.raises(OrderError, match="Market closed"):
        e.place_basket([leg("SP")], at("10:00", day="2026-11-01"), margin_after=48_000)  # a Sunday
    small = OptionsEngine(20_000)
    market(small)
    with pytest.raises(OrderError, match="Insufficient funds"):
        small.place_basket([leg("SP"), leg("SC")], at("10:00"), margin_after=48_000)
    assert small.fills == [] and small.blocked_margin == 0.0


def test_margin_is_at_least_the_long_premium():
    e = OptionsEngine(200_000)
    market(e)
    e.place_basket([leg("BP", lots=10)], at("10:00"), margin_after=0.0)  # Dhan said 0 for a pure buy
    assert e.blocked_margin == pytest.approx(10 * 65 * 8.85)


# ---------- exits ----------
def test_exit_one_leg_then_all():
    e, _ = condor()
    market(e, {**PRICES, "SP": 12.0})  # the short put fell from 19.20 to 12
    fills = e.exit(at("11:00"), margin_after=None, security_id=101)
    assert [(f.side, f.qty, f.price, f.kind, f.realized) for f in fills] == [(BUY, 65, 12.0, "close", round(65 * 7.2, 2))]
    assert e.blocked_margin == 48_000.0  # no new figure: the margin stays, never less
    e.exit(at("11:05"), margin_after=30_000.0, security_id=102)
    assert e.blocked_margin == 30_000.0
    e.exit(at("11:10"))
    assert e.open_positions() == [] and e.blocked_margin == 0.0
    with pytest.raises(OrderError, match="No open position"):
        e.exit(at("11:11"))


def test_a_sell_larger_than_a_long_flips_it_short():
    p = OptPosition(1, 65, "NIFTY", EXP, 23000, "CE", qty=65, avg=100.0)
    assert p.apply(SELL, 130, 110.0) == 650.0  # 65 closed at +10
    assert (p.qty, p.avg) == (-65, 110.0)
    assert p.apply(BUY, 65, 100.0) == 650.0  # the short bought back 10 lower
    assert (p.qty, p.avg) == (0, 0.0)


# ---------- expiry ----------
def test_settles_worthless_inside_the_wings_keeping_the_credit():
    e, entry = condor()
    fills = e.settle(EXP, 22900.0, at("15:30", day=EXP))
    assert [(f.price, f.kind, f.charges.total) for f in fills] == [(0.0, "settle", 0.0)] * 4
    assert sum(f.realized for f in fills) == pytest.approx(773.5)  # the whole credit
    assert e.open_positions() == [] and e.blocked_margin == 0.0


def test_settles_at_max_loss_below_the_put_wing_with_stt_on_the_long_put_only():
    e, _ = condor()
    fills = {f.security_id: f for f in e.settle(EXP, 21500.0, at("15:30", day=EXP))}
    assert (fills[101].side, fills[101].price, fills[101].charges.stt) == (BUY, 450.0, 0.0)  # short put: bought back
    assert (fills[103].side, fills[103].price) == (SELL, 200.0)  # long put: intrinsic 200
    assert fills[103].charges.stt == pytest.approx(round(200 * 65 * 0.00125, 2))  # STT on exercise, ITM long
    assert fills[103].charges.brokerage == 0.0
    assert sum(f.realized for f in fills.values()) == pytest.approx(-15_476.5)  # Dhan's max loss
    assert e.settle(EXP, 21500.0, at("15:30", day=EXP)) == []  # nothing left


def test_only_the_given_expiry_settles():
    e, _ = condor()
    e.on_tick(201, Book(30.0, [(30.0, 1000)], [(30.0, 1000)]))  # the 10 Nov put
    e.place_basket([LegOrder(201, SELL, 1, LOT, "NIFTY", "2026-11-10", 21950, "PE")], at("10:30"), margin_after=60_000)
    e.settle(EXP, 22900.0, at("15:30", day=EXP))
    assert [(p.security_id, p.expiry) for p in e.open_positions()] == [(201, "2026-11-10")]
    assert e.blocked_margin == 60_000  # still open: the margin stays


# ---------- overnight, restore, records ----------
def test_restore_rebuilds_positions_funds_and_ids_across_days():
    e, _ = condor()
    market(e, {**PRICES, "SP": 12.0})
    e.exit(at("10:00", day="2026-10-29"), security_id=101)  # the next day
    stored = [f.to_dict() for f in e.fills]
    r = OptionsEngine(200_000)
    r.restore(stored, blocked_margin=e.blocked_margin)
    assert {p.security_id: (p.qty, round(p.avg, 4)) for p in r.open_positions()} == \
        {p.security_id: (p.qty, round(p.avg, 4)) for p in e.open_positions()}
    assert r.funds() == e.funds()
    market(r)
    nxt = r.place_basket([leg("SP")], at("11:00", day="2026-10-29"), margin_after=48_000)
    assert nxt[0].id == "OF20261029-0002" and nxt[0].basket_id == "OB20261029-0002"  # numbering carries on


def test_day_rows_book_each_days_realized_for_the_reports():
    e, _ = condor()
    market(e, {**PRICES, "SP": 12.0})
    e.exit(at("10:00", day="2026-10-29"), security_id=101)
    assert sorted(r["security_id"] for r in e.day_rows("2026-10-28")) == [101, 102, 103, 104]
    assert all(r["realized"] == 0.0 for r in e.day_rows("2026-10-28"))  # opening day: nothing booked yet
    assert e.day_rows("2026-10-29") == [{"security_id": 101, "lot_size": 65, "buy_qty": 65, "sell_qty": 0, "avg_buy": 12.0,
                                         "avg_sell": 0.0, "realized": round(65 * 7.2, 2)}]
