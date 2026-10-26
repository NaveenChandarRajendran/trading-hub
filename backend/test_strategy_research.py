"""strategy_research.py / bt_variants.py helpers on synthetic data: fills (long and short), trailing exits, expiry-day
tagging, the search filter. The rules of the live strategies are tested elsewhere."""
from datetime import date

import numpy as np

import bt_variants
import strategy_research as sr


def path(px=100.0):
    a = np.full((375, 4), px, dtype=np.float32)
    return a


def test_long_stop_target_signal_and_time():
    p = path()
    p[20] = (100, 101, 89, 95)  # low through the 90 stop
    assert sr.simulate(p, 10, 0.10, 0.20) == (100.0, 90.0, 20, "Stop")
    p = path()
    p[30] = (125, 126, 124, 125)  # opens above the 120 target
    assert sr.simulate(p, 10, 0.10, 0.20)[1:] == (125.0, 30, "Target")
    p = path()
    p[40] = (110, 110, 110, 110)
    assert sr.simulate(p, 10, 0.10, None, exits=[40]) == (100.0, 110.0, 40, "Signal")
    assert sr.simulate(path(), 10, 0.10, 0.20)[2:] == (sr.TIME_EXIT, "Time")


def test_short_is_mirrored():
    p = path()
    p[20] = (100, 131, 99, 120)  # high through the 130 stop of a short
    assert sr.simulate(p, 10, 0.30, 0.30, short=True) == (100.0, 130.0, 20, "Stop")
    p = path()
    p[20] = (100, 100, 69, 70)
    assert sr.simulate(p, 10, 0.30, 0.30, short=True)[1:] == (70.0, 20, "Target")


def test_search_filter_needs_every_search_year_positive():
    good = {"trades": 100, "net": 30000, "profitFactor": 1.3, "maxDrawdown": 10000, "years": {2022: 1, 2023: 1, 2024: 1}}
    assert sr.score(good) == 3.0
    assert sr.score({**good, "years": {2022: 1, 2023: -1, 2024: 1}}) is None
    assert sr.score({**good, "trades": 10}) is None
    assert sr.score({**good, "profitFactor": 1.05}) is None


def test_expiry_tags_from_the_straddle_roll():
    days = {}
    prem = {date(2026, 10, 19): (20, 150), date(2026, 10, 20): (120, 110), date(2026, 10, 21): (100, 100)}
    for d, (close_, open_) in prem.items():
        atm = np.full(375, 25000.0)
        a = path(close_)
        a[0] = (open_, open_, open_, open_)
        days[d] = {"atm": {"CE": atm, "PE": atm}, "opt": {"CE": {25000.0: a}, "PE": {25000.0: a}}}
    # 19 Oct closes at 20+20, 20 Oct opens at 120+120: the series rolled, so 19 Oct was expiry
    days[date(2026, 10, 19)]["opt"]["CE"][25000.0][-1] = (20, 20, 20, 20)
    tags = sr.expiry_days(days)
    assert tags.get(date(2026, 10, 19)) == "expiry"
    assert date(2026, 10, 20) not in tags


def test_variant_day_filters_and_wider_stop():
    assert bt_variants.keep("Skip expiry day", "eve") and not bt_variants.keep("Skip expiry day", "expiry")
    assert not bt_variants.keep("Skip expiry day + day before", "eve") and bt_variants.keep("Skip expiry day + day before", "")
    rule = bt_variants.day_rule_for("Wider stop on expiry day + day before", {date(2026, 10, 26): "eve"})
    assert rule(date(2026, 10, 26), 0.10, 0.20) == (0.20, 0.20)
    assert rule(date(2026, 10, 23), 0.10, 0.20) == (0.10, 0.20)
    assert bt_variants.pair_name((0.15, 0.20)) == "-15/+20"
