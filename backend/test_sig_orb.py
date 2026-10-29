"""Box Pullback (docs/strategies/box-pullback.md): the walk over today's 1-minute candles, the state builder, the rule
gates, and the trade on its own book with index stop / target exits."""
import os
import time
from datetime import datetime

from autopaper import OB, OBK, AutoTrader
from sig_indicators import IST
from sig_orb import build_state_orb, evaluate, orb_exit, orb_rule
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
    assert ev["phase"] == "pullback" and ev["side"] == "CE" and ev["breakAt"] == (9, 35)
    assert ev["stop"] == 22750 and ev["target"] == 22900  # 2 x (22,800 - 22,750) above the box high
    ev = evaluate(rows)
    assert ev["phase"] == "signal" and ev["touchAt"] == (9, 40)
    assert evaluate(day_up(pullback=False))["phase"] == "pullback"


def test_put_side_and_no_pullback_by_1330():
    rows = [bar(m, 45350, 45400 if m == 3 else 45360, 45200 if m == 7 else 45340, 45350) for m in range(15)]  # box 45,200-45,400
    rows += [bar(15 + k, 45190 - 5 * k, 45200 - 5 * k, 45170 - 5 * k, 45180 - 5 * k) for k in range(5)]  # close 45,160
    rows += [bar(20 + k, 45150, 45180, 45100, 45140) for k in range(240)]  # never back to 45,200, past 13:30
    ev = evaluate(rows)
    assert ev["side"] == "PE" and ev["stop"] == 45300 and ev["target"] == 45000 and ev["phase"] == "none"
    st = {"symbol": "BANKNIFTY", "hm": (13, 40), "marketOpen": True, "positions": {}, "orb": ev, "signalTime": "13:39"}
    r = orb_rule(st)
    assert not r["go"] and "No trade today" in r["blocked"][-1]


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
    assert r["go"] and r["side"] == "CE" and r["indexStop"] == 22750 and r["indexTarget"] == 22900 and r["noTarget"]
    assert not orb_rule({**st, "tradedToday": True})["go"]
    assert not orb_rule({**st, "positions": {OB: True}})["go"]
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=40, second=30), Src(day_up()))  # 09:40 not closed yet
    assert not orb_rule(st)["go"]


def test_exit_levels():
    t = {"side": "CE", "indexStop": 22750, "indexTarget": 22900}
    assert orb_exit(t, {"high": 22800, "low": 22760}) is None
    assert orb_exit(t, {"high": 22800, "low": 22750}).startswith("Index stop")
    assert orb_exit(t, {"high": 22900, "low": 22800}).startswith("Index target")
    p = {"side": "PE", "indexStop": 45350, "indexTarget": 45100}
    assert orb_exit(p, {"high": 45350, "low": 45200}).startswith("Index stop")
    assert orb_exit(p, {"high": 45300, "low": 45100}).startswith("Index target")


class FakeOrbBook(FakeAccount):
    key = OBK

    def funds(self):
        return {"available": 100000.0}


def trader(tmp_path, enabled=True):
    acc = FakeOrbBook()
    cfg = {**CFG, "logDir": str(tmp_path), "limits": {"maxTradesPerDay": 6, "maxLossPerDay": 10000},
           OB: {"enabled": enabled, "lots": 1, "stopPct": 50, "targetPct": 0}}
    t = AutoTrader(cfg, [acc], clock=Clock(), alert=lambda k, m: None, state_path=os.path.join(str(tmp_path), "state.json"))
    t.set_auto(True)
    return t, acc


def wait(t):
    for _ in range(100):
        if not t._busy and not any(x.get("exiting") and x["status"] == "open" for x in t.state["trades"]):
            break
        time.sleep(0.05)


def test_trade_on_its_own_book_exits_on_the_index(tmp_path):
    t, acc = trader(tmp_path)
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=41, second=5), Src(day_up()))
    assert t.on_signal(orb_rule(st), st) == "Entry sent"
    wait(t)
    tr = t.state["trades"][0]
    assert (tr["account"], tr["slot"], tr["side"]) == ("orb", "orbPullback", "CE")
    assert tr["stop"] == 50.0 and tr["target"] is None  # fill 100: 50 % safety stop on the premium only
    assert (tr["indexStop"], tr["indexTarget"]) == (22750, 22900)
    assert t.status()["accounts"]["orb"]["name"] == "Box Pullback book"
    t.on_minute_orb("NIFTY", {"high": 22840, "low": 22790})
    assert tr["status"] == "open"
    t.on_minute_orb("NIFTY", {"high": 22905, "low": 22850})
    wait(t)
    assert tr["status"] == "closed" and tr["exitReason"] == "Target"


def test_switch_off(tmp_path):
    t, acc = trader(tmp_path, enabled=False)
    st, _ = build_state_orb("NIFTY", DAY.replace(hour=9, minute=41, second=5), Src(day_up()))
    assert t.on_signal(orb_rule(st), st) == "Box Pullback is off (config orbPullback.enabled)"
    assert acc.sent == []
