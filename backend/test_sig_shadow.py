"""sig_service.skipped_setup: which rule results go to the shadow log (owner's brief 7b, and the expiry-day gates
added 26-Oct-2026)."""
from sig_rules import EXPIRY_GATES, PASS
from sig_service import skipped_setup


def trend(go=False, grade="A", blocked=(), rsi=PASS):
    checks = [{"id": "supertrend", "label": "SuperTrend (10, 2)", "state": PASS, "must": True},
              {"id": "trendingOi", "label": "Trending OI", "state": PASS, "must": True},
              {"id": "delta", "label": "Cumulative delta agrees", "state": "notChecked", "must": True, "exempt": True},
              {"id": "rsi", "label": "RSI 14", "state": rsi, "must": False}]
    return {"rule": "tradingHub", "go": go, "grade": grade, "checks": checks, "blocked": list(blocked)}


def test_a_setup_blocked_only_by_the_expiry_gates_is_shadowed():
    for phase, label in EXPIRY_GATES.items():
        assert skipped_setup(trend(blocked=[label])) == ("-", label), phase


def test_other_gates_and_taken_trades_are_not_shadowed():
    assert skipped_setup(trend(go=True)) is None
    assert skipped_setup(trend(blocked=["No new entries after 14:30"])) is None
    assert skipped_setup(trend(blocked=["Expiry day (Trend Rules does not trade it)", "Market closed"])) is None


def test_a_missed_check_is_still_shadowed():
    filters, why = skipped_setup(trend(grade=None, rsi="fail"))
    assert filters == "RSI 14" and "other checks off" in why
