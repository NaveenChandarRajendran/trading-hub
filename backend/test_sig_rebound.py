"""Rebound Call (docs/strategies/rebound-call.md): the rule on hand-built states, the state builder on synthetic
candles, the backtest's own 12-Feb-2025 signal replayed from real Dhan candles, and the trade on its own book."""
import json
import os
import time
from datetime import datetime, timedelta

from autopaper import RB, RBK, AutoTrader
from sig_indicators import IST
from sig_rebound import build_state_rebound, closed_bars, rebound_rule
from sig_rules import FAIL, NOT_CHECKED, PASS
from test_autopaper import CFG, Clock, FakeAccount

HERE = os.path.dirname(os.path.abspath(__file__))


def state(**over):
    # EMA 200 50,000, ATR 100 -> deep fall needs close <= 49,591; open 49,900, 10-day range 1,000 -> down today needs
    # close <= 49,790; VWAP 49,600 -> bounce needs close >= 49,562
    s = {"symbol": "BANKNIFTY", "hm": (10, 35), "signalTime": "10:30", "marketOpen": True, "positions": {},
         "bar": {"close": 49580.0}, "ind": {"ema200": 50000.0, "atr": 100.0, "dayOpen": 49900.0, "vwap": 49600.0, "avgRange": 1000.0}}
    s.update(over)
    return s


def states(r):
    return {c["id"]: c["state"] for c in r["checks"]}


def test_call_needs_all_three():
    r = rebound_rule(state())
    assert r["go"] and r["side"] == "CE" and (r["score"], r["total"]) == (3, 3) and r["rule"] == "reboundCall"
    r = rebound_rule(state(bar={"close": 49600.0}))  # not 4.09 ATR below EMA 200
    assert not r["go"] and states(r)["deepFall"] == FAIL and r["score"] == 2
    r = rebound_rule(state(ind={**state()["ind"], "dayOpen": 49650.0}))  # only 70 below the open: needs 110
    assert not r["go"] and states(r)["downToday"] == FAIL
    r = rebound_rule(state(bar={"close": 49550.0}))  # still too far under VWAP
    assert not r["go"] and states(r)["bounce"] == FAIL


def test_not_enough_history_is_not_checked():
    r = rebound_rule(state(ind={**state()["ind"], "avgRange": None, "ema200": None}))
    assert not r["go"] and states(r)["downToday"] == NOT_CHECKED and states(r)["deepFall"] == NOT_CHECKED


def test_window_one_signal_a_day_and_own_position():
    assert rebound_rule(state(hm=(9, 20)))["go"]
    assert not rebound_rule(state(hm=(14, 35)))["go"]
    r = rebound_rule(state(tradedToday=True))
    assert not r["go"] and r["grade"] == "A" and "one a day" in r["blocked"][0]
    assert not rebound_rule(state(positions={"reboundCall": True}))["go"]
    assert rebound_rule(state(positions={"dharaniV2": True}))["go"]  # another rule's trade does not block it


def test_closed_bars_are_five_minutes_aligned_to_0915():
    t0 = int(datetime(2026, 10, 26, 9, 15, tzinfo=IST).timestamp())
    one = [{"time": t0 + 60 * k, "open": 1, "high": 2 + k, "low": 1, "close": 1.5 + k} for k in range(11)]
    bars, complete = closed_bars(one, datetime(2026, 10, 26, 9, 25, 35, tzinfo=IST))
    assert [b["time"] for b in bars] == [t0, t0 + 300] and complete
    assert bars[0]["high"] == 6 and bars[1]["close"] == 10.5


class Src:
    def __init__(self, candles):
        self.rows = candles

    def market_open(self):
        return True

    def positions(self, symbol):
        return {}

    def candles_v2(self, symbol, max_age=None, n=4):
        assert n == 12
        return [], self.rows, [], ""


def synthetic(days=12, today_minutes=30):
    rows = []
    d = datetime(2026, 10, 8, 9, 15, tzinfo=IST)
    for k in range(days):
        day = d + timedelta(days=k)
        t = int(day.timestamp())
        for m in range(375 if k < days - 1 else today_minutes):
            p = 50000 + 100 * k + m / 10
            rows.append({"time": t + 60 * m, "open": p, "high": p + 5 + k, "low": p - 5, "close": p + 1})
    return rows, d + timedelta(days=days - 1)


def test_build_state_daily_range_vwap_and_open():
    rows, today = synthetic()
    st, problems = build_state_rebound("BANKNIFTY", today.replace(hour=9, minute=45, second=35), Src(rows))
    assert not problems and st["signalTime"] == "09:40" and st["hm"] == (9, 45) and st["complete"]
    ind = st["ind"]
    # session k: high = 50,000 + 100k + 37.4 + 5 + k, low = 50,000 + 100k - 5 -> range 47.4 + k; the 10 before today: k = 1..10
    assert abs(ind["avgRange"] - (47.4 + 5.5)) < 1e-6
    assert ind["dayOpen"] == 50000 + 100 * 11
    assert ind["ema200"] is not None and ind["atr"] is not None
    rows6, today6 = synthetic(days=6)
    st, problems = build_state_rebound("BANKNIFTY", today6.replace(hour=9, minute=45, second=35), Src(rows6))
    assert st["ind"]["avgRange"] is None  # fewer than 10 earlier sessions
    assert states(rebound_rule(st))["downToday"] == NOT_CHECKED


def test_backtest_signal_of_12_feb_2025_replays_live():
    """The backtest bought the BANKNIFTY ATM call at 10:35 on 12-Feb-2025 (signal candle 10:30-10:35). The live code,
    fed the same Dhan 1-minute candles, must say GO on that candle and not on the one before."""
    fx = json.load(open(os.path.join(HERE, "fixtures", "rebound_banknifty_2025-02-12.json"), encoding="utf-8"))
    rows = [{"time": t, "open": o, "high": h, "low": lo, "close": c} for t, o, h, lo, c in fx["candles"]]
    day = datetime(2025, 2, 12, tzinfo=IST)
    st, _ = build_state_rebound("BANKNIFTY", day.replace(hour=10, minute=35, second=35), Src(rows))
    r = rebound_rule(st)
    assert st["signalTime"] == "10:30" and r["go"], r["checks"]
    st, _ = build_state_rebound("BANKNIFTY", day.replace(hour=10, minute=30, second=35), Src(rows))
    r = rebound_rule(st)
    assert not r["go"] and states(r)["bounce"] == FAIL and states(r)["deepFall"] == PASS


class FakeReboundBook(FakeAccount):
    key = RBK

    def funds(self):
        return {"available": 100000.0}


def trader(tmp_path, enabled=True):
    acc = FakeReboundBook()
    cfg = {**CFG, "logDir": str(tmp_path), "limits": {"maxTradesPerDay": 6, "maxLossPerDay": 10000},
           RB: {"enabled": enabled, "lots": 1, "stopPct": 25, "targetPct": 50}}
    t = AutoTrader(cfg, [acc], clock=Clock(), alert=lambda k, m: None, state_path=os.path.join(str(tmp_path), "state.json"))
    t.set_auto(True)
    return t, acc


def test_trade_goes_to_the_rebound_book_with_its_own_stop_and_target(tmp_path):
    t, acc = trader(tmp_path)
    r = rebound_rule(state())
    assert t.on_signal(r, {"spot": 49580.0}) == "Entry sent"
    for _ in range(100):
        if not t._busy:
            break
        time.sleep(0.05)
    tr = t.state["trades"][0]
    assert (tr["account"], tr["slot"], tr["side"]) == ("rebound", "reboundCall", "CE")
    assert tr["stop"] == 75.0 and tr["target"] == 150.0  # fill 100: -25 % / +50 %
    assert t.positions("BANKNIFTY")["reboundCall"]
    assert t.status()["accounts"]["rebound"]["name"] == "Rebound Call book"


def test_switch_off(tmp_path):
    t, acc = trader(tmp_path, enabled=False)
    assert t.on_signal(rebound_rule(state()), {"spot": 49580.0}) == "Rebound Call is off (config reboundCall.enabled)"
    assert acc.sent == []
