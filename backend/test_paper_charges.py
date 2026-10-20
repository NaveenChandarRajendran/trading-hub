"""Charges for paper trades.

NOT YET VERIFIED against Dhan's brokerage calculator (https://dhan.co/brokerage-calculator/): the expected values
below are worked by hand from the rates in paper_charges.py. Before relying on P&L, enter these trades in Dhan's
calculator (NSE, F&O options, intraday) and replace the hand values with Dhan's, noting the date checked.
"""
import pytest

from paper_charges import order_charges, r2


def test_buy_7500_premium():
    # BUY 75 @ 100 = Rs 7,500 premium
    c = order_charges("BUY", 7500)
    assert c.brokerage == 20.00
    assert c.stt == 0.00                 # STT only on the sell side
    assert c.transaction == 2.63         # 7,500 x 0.03503% = 2.627
    assert c.sebi == 0.01                # 7,500 x 10 / 1 crore = 0.0075
    assert c.stamp == 0.23               # 7,500 x 0.003% = 0.225 -> half up
    assert c.gst == 4.08                 # 18% x (20 + 2.63 + 0.01) = 4.0752
    assert c.total == 26.95


def test_sell_9000_premium():
    # SELL 75 @ 120 = Rs 9,000 premium
    c = order_charges("SELL", 9000)
    assert c.stt == 13.50                # 9,000 x 0.15%
    assert c.transaction == 3.15         # 9,000 x 0.03503% = 3.1527
    assert c.sebi == 0.01
    assert c.stamp == 0.00               # stamp duty only on the buy side
    assert c.gst == 4.17                 # 18% x (20 + 3.15 + 0.01) = 4.1688
    assert c.total == 40.83


def test_large_sell_1_lakh_premium():
    # SELL 300 @ 333.35 = Rs 1,00,005 premium
    c = order_charges("SELL", 100005)
    assert c.stt == 150.01               # 150.0075
    assert c.transaction == 35.03        # 35.0318
    assert c.sebi == 0.10                # 0.100005
    assert c.gst == 9.92                 # 18% x 55.13 = 9.9234
    assert c.total == 215.06


def test_brokerage_is_flat_per_order():
    assert order_charges("BUY", 50).brokerage == 20.00


def test_bad_input():
    with pytest.raises(ValueError):
        order_charges("SHORT", 100)
    with pytest.raises(ValueError):
        order_charges("BUY", -1)


def test_r2_rounds_half_up():
    assert r2(0.225) == 0.23
    assert r2(2.675) == 2.68             # round(2.675, 2) would give 2.67
    assert r2(-1.005) == -1.01
