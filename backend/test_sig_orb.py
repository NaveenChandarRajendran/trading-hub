"""Box Pullback (docs/strategies/box-pullback.md): the walk over today's 1-minute candles, the state builder, the rule
gates, and the trade on its own book with the premium stop -10 % / target +20 %."""
import os
import time
from datetime import datetime

from autopaper import OB, OBK, AutoTrader
from sig_indicators import IST
from sig_orb import RULE5, build_state_orb, evaluate, orb_rule
from test_autopaper import CFG, Clock, FakeAccount

DAY = datetime(2026, 10, 29, tzinfo=IST)
T0 = int(DAY.replace(hour=9, minute=15).timestamp())


def bar(m, o, h, lo, c):
    return {"time": T0 + 60 * m, "open": o, "high": h, "low": lo, "close": c}


def day_up(pullback=True):
    """Box 22,700-22,800 (09:15-09:29); 09:30-09:34 climbs and closes 22,830 (break up at 09:35); 09:35-09:39 stays above;
    09:40 dips to 22,795 (touches the box high) when `pullback`."""
    rows = [bar(m, 22750, 22800 if m == 3 else 22760, 22700 if m == 7 else 22740, 22750) for m in range(15)]
    rows += [bar(15 + k, 22790 + 8 * k, 22800 + 8 * k, 22785 + 8 * k, 22798 + 8 * k) for k in range(5)]  # last close 22,830
    rows += [bar(20 + k, 22830, 22840, 22815, 22830) for k in range(5)]
    rows.append(bar(25, 22820, 22825, 22795 if pullback else 22810, 22812))
    return rows


def test_walk_box_break_pullback():
    rows = day_up()
    assert evaluate(rows[:10])["phase"] == "box"
    ev = evaluate(rows[:18])  # 5-minute break candle still forming
    assert ev["phase"] == "break" and (ev["high"], ev["low"], ev["mid"]) == (22800, 22700, 22750)
    ev = evaluate(rows[:20])
    assert ev["phase"] == "pullback" and ev["side"] == "CE" and ev["breakAt"] == (9, 35) and ev["level"] == 22800
    ev = evaluate(rows)
    assert ev["phase"] == "signal" and ev["touchAt"] == (9, 40)
    assert evaluate(day_up(pullback=False))["phase"] == "pullback"


def test_five_minute_box_one_minute_close():
    """5/1 version: box 09:15-09:19, first 1-minute close outside it, then the pullback."""
    rows = [bar(m, 22750, 22770 if m == 2 else 22760, 22730 if m == 4 else 22740, 22750) for m in range(5)]  # box 22,730-22,770
    rows += [bar(5, 22760, 22768, 22755, 22765), bar(6, 22765, 22790, 22764, 22785)]  # 09:21 closes above 22,770
    rows += [bar(7, 22785, 22800, 22780, 22795), bar(8, 22795, 22796, 22769, 22775)]  # 09:23 touches 22,770
    ev = evaluate(rows[:7], 5, 1)
    assert ev["phase"] == "pullback" and ev["breakAt"] == (9, 22) and ev["level"] == 22770
    assert evaluate(rows, 5, 1)["touchAt"] == (9, 23)
    assert evaluate(rows)["phase"] == "box"  # the 15/5 version is still building its box
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=24, second=5), Src(rows), rule=RULE5)
    r = orb_rule(st)
    assert r["go"] and r["rule"] == "orbPullback5" and r["setup"] == "Box Pullback 5/1"
    assert [c["label"] for c in r["checks"]][:2] == ["5-min box", "1-min close outside"]


def test_put_side_and_no_pullback_by_1330():
    rows = [bar(m, 45350, 45400 if m == 3 else 45360, 45200 if m == 7 else 45340, 45350) for m in range(15)]  # box 45,200-45,400
    rows += [bar(15 + k, 45190 - 5 * k, 45200 - 5 * k, 45170 - 5 * k, 45180 - 5 * k) for k in range(5)]  # close 45,160
    rows += [bar(20 + k, 45150, 45180, 45100, 45140) for k in range(240)]  # never back to 45,200, past 13:30
    ev = evaluate(rows)
    assert ev["side"] == "PE" and ev["level"] == 45200 and ev["phase"] == "none"
    st = {"symbol": "BANKNIFTY", "hm": (13, 40), "marketOpen": True, "positions": {}, "orb": ev, "signalTime": "13:39"}
    r = orb_rule(st)
    assert not r["go"] and "No trade today" in r["blocked"][-1]
    assert r["box"] == {"high": 45400, "low": 45200}  # drawn on the chart


class Src:
    def __init__(self, rows):
        self.rows = rows

    def market_open(self):
        return True

    def positions(self, symbol):
        return {}

    def candles_v2(self, symbol, max_age=None, n=4):
        return [], self.rows, [], ""


def test_build_state_and_rule_go_once():
    st, problems = build_state_orb("NIFTY", DAY.replace(hour=9, minute=41, second=5), Src(day_up()))
    assert not problems and st["signalTime"] == "09:40" and st["spot"] == 22812
    r = orb_rule(st)
    assert r["go"] and r["side"] == "CE" and not r.get("noTarget")
    assert not orb_rule({**st, "tradedToday": True})["go"]
    assert not orb_rule({**st, "positions": {OB: True}})["go"]
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=40, second=30), Src(day_up()))  # 09:40 not closed yet
    assert not orb_rule(st)["go"]


class FakeOrbBook(FakeAccount):
    key = OBK

    def funds(self):
        return {"available": 100000.0}


def trader(tmp_path, enabled=True):
    acc = FakeOrbBook()
    cfg = {**CFG, "logDir": str(tmp_path), "limits": {"maxTradesPerDay": 6, "maxLossPerDay": 10000},
           OB: {"enabled": enabled, "lots": 1, "stopPct": 10, "targetPct": 20}}
    t = AutoTrader(cfg, [acc], clock=Clock(), alert=lambda k, m: None, state_path=os.path.join(str(tmp_path), "state.json"))
    t.set_auto(True)
    return t, acc


def wait(t):
    for _ in range(100):
        if not t._busy and not any(x.get("exiting") and x["status"] == "open" for x in t.state["trades"]):
            break
        time.sleep(0.05)


def test_trade_on_its_own_book_with_10_20(tmp_path):
    t, acc = trader(tmp_path)
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=41, second=5), Src(day_up()))
    assert t.on_signal(orb_rule(st), st) == "Entry sent"
    wait(t)
    tr = t.state["trades"][0]
    assert (tr["account"], tr["slot"], tr["side"]) == ("orb", "orbPullback", "CE")
    assert tr["stop"] == 90.0 and tr["target"] == 120.0  # fill 100: -10 % / +20 %
    assert t.status()["accounts"]["orb"]["name"] == "Box Pullback 15/5 book"


def test_switch_off(tmp_path):
    t, acc = trader(tmp_path, enabled=False)
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=41, second=5), Src(day_up()))
    assert t.on_signal(orb_rule(st), st) == "Box Pullback is off (config orbPullback.enabled)"
    assert acc.sent == []
