"""Auto paper trader with a fake account and a fake clock: entries, safety gates, target / stop / time exits, limits,
and the trade log row. No network, no real orders (there are none anywhere: paper only)."""
import csv
import os
import time
from datetime import datetime

from autopaper import TH, AutoTrader, ceil_tick, floor_tick
from sig_indicators import IST


class Clock:
    def __init__(self, hm="10:05"):
        self.set(hm)

    def set(self, hm):
        h, m = map(int, hm.split(":"))
        self.now = datetime(2026, 10, 23, h, m, tzinfo=IST)

    def __call__(self):
        return self.now


class FakeAccount:
    key, rule = TH, "tradingHub"

    def __init__(self):
        self.ltp_value = 100.0
        self.orders = {}
        self.qty = 0
        self.sent = []
        self.fail_buy = False
        self.paper = self  # update_watch / _enter call paper.watch

    def watch(self, ids):
        self.watched = ids

    def available(self):
        return True, ""

    def expiries(self, symbol):
        return ["2026-10-23", "2026-10-27"]

    def instrument(self, symbol, expiry, spot, side):
        return {"id": 1, "name": f"{symbol} {expiry} {round(spot, -2):.0f} {side}", "strike": round(spot, -2), "expiry": expiry,
                "optionType": side, "lotSize": 30}

    def neighbours(self, symbol, expiry, spot):
        return [1, 2]

    def ready(self, inst):
        return True

    def ltp(self, inst):
        return self.ltp_value

    def buy(self, inst, lots):
        if self.fail_buy:
            raise RuntimeError("HTTP 500")
        self.sent.append(("BUY", inst["expiry"]))
        self.qty = lots * 30
        self.orders["E1"] = {"status": "FILLED", "avgPrice": 100.0}
        return "E1", 100.0, self.qty

    def stop(self, inst, lots, qty, trigger):
        self.sent.append(("SL-M", trigger))
        self.orders["S1"] = {"status": "OPEN", "avgPrice": None}
        return "S1"

    def order(self, oid):
        return self.orders.get(oid)

    def cancel(self, oid):
        self.sent.append(("CANCEL", oid))
        self.orders[oid]["status"] = "CANCELLED"

    def sell(self, inst, lots, qty):
        self.sent.append(("SELL", self.ltp_value))
        self.qty = 0
        return "X1", self.ltp_value

    def position_qty(self, inst):
        return self.qty

    def last_sell_price(self, inst):
        return self.ltp_value

    def charges(self, trade):
        return 40.0


CFG = {"limits": {"maxTradesPerDay": 2, "maxLossPerDay": 1000}, "tradingHub": {"lots": 1, "stopPct": 15, "targetPct": 20},
       "rollOnExpiryDay": True, "timeExit": "15:14"}

GO = {"rule": "tradingHub", "name": "TRADING HUB RULE", "symbol": "BANKNIFTY", "side": "PE", "go": True, "grade": "A",
      "checks": [{"id": "supertrend", "state": "pass"}, {"id": "delta", "state": "notChecked"}], "tags": ["delta not checked"], "at": "10:00"}
STATE = {"spot": 54111.55, "ind": {"rsi": [39.0]}, "i": 0, "vix": 13.42, "pcr": 0.79, "toi": [{"strengthPct": -102}]}


def make(tmp_path, clock=None):
    acc = FakeAccount()
    alerts = []
    cfg = {**CFG, "logDir": str(tmp_path)}
    t = AutoTrader(cfg, [acc], clock=clock or Clock(), alert=lambda k, m: alerts.append((k, m)),
                   state_path=os.path.join(str(tmp_path), "state.json"))
    return t, acc, alerts


def wait_idle(t):
    for _ in range(100):
        if not t._busy:
            return
        time.sleep(0.05)


def test_off_by_default_and_nothing_sent(tmp_path):
    t, acc, _ = make(tmp_path)
    assert t.on_signal(GO, STATE) == "Auto is OFF"
    assert acc.sent == []


def test_entry_places_stop_and_rolls_expiry_on_expiry_day(tmp_path):
    t, acc, _ = make(tmp_path)
    t.set_auto(True)
    assert t.on_signal(GO, STATE) == "Entry sent"
    wait_idle(t)
    assert acc.sent[0] == ("BUY", "2026-10-27")  # 23-Oct is an expiry in the list: the next one is used
    assert acc.sent[1] == ("SL-M", 85.0)  # 100 x 0.85
    tr = t.state["trades"][0]
    assert tr["target"] == 120.0 and tr["deltaStatus"] == "not checked" and tr["grade"] == "A"
    assert t.on_signal(GO, STATE) == "Position already open on this index"


def test_target_cancels_stop_then_sells(tmp_path):
    t, acc, _ = make(tmp_path)
    t.set_auto(True)
    t.on_signal(GO, STATE)
    wait_idle(t)
    acc.ltp_value = 121.0
    t.tick()
    wait_idle(t)
    tr = t.state["trades"][0]
    assert tr["status"] == "closed" and tr["exitReason"] == "Target" and tr["high"] == 121.0
    assert ("CANCEL", "S1") in acc.sent and acc.sent[-1] == ("SELL", 121.0)
    assert tr["grossPnl"] == 630.0 and tr["netPnl"] == 590.0  # (121 - 100) x 30 - 40
    rows = list(csv.DictReader(open(os.path.join(str(tmp_path), "trade_log.csv"))))
    assert rows[0]["exit_reason"] == "Target" and rows[0]["delta_status"] == "not checked" and "supertrend=true" in rows[0]["checks"]


def test_stop_fill_is_recorded(tmp_path):
    t, acc, _ = make(tmp_path)
    t.set_auto(True)
    t.on_signal(GO, STATE)
    wait_idle(t)
    acc.ltp_value = 84.0
    acc.orders["S1"] = {"status": "FILLED", "avgPrice": 84.5}
    t.tick()
    tr = t.state["trades"][0]
    assert tr["exitReason"] == "Stop" and tr["exitPrice"] == 84.5 and tr["low"] == 84.0


def test_time_exit(tmp_path):
    clock = Clock()
    t, acc, _ = make(tmp_path, clock)
    t.set_auto(True)
    t.on_signal(GO, STATE)
    wait_idle(t)
    clock.set("15:14")
    t.tick()
    wait_idle(t)
    assert t.state["trades"][0]["exitReason"] == "Time"


def test_daily_trade_limit_alerts_once(tmp_path):
    t, acc, alerts = make(tmp_path)
    t.set_auto(True)
    for _ in range(2):
        t.on_signal(GO, STATE)
        wait_idle(t)
        acc.ltp_value = 121.0
        t.tick()
        wait_idle(t)
        acc.ltp_value = 100.0
    assert "Daily limit reached" in t.on_signal(GO, STATE)
    assert t.on_signal(GO, STATE).startswith("Daily limit")
    assert [k for k, _ in alerts] == ["limit"]


def test_failed_entry_halts_the_account(tmp_path):
    t, acc, alerts = make(tmp_path)
    t.set_auto(True)
    acc.fail_buy = True
    t.on_signal(GO, STATE)
    wait_idle(t)
    assert alerts and t.block_reason(TH, "NIFTY").startswith("Entry failed")


def test_ticks():
    assert floor_tick(85.0399) == 85.0 and ceil_tick(120.01) == 120.05 and floor_tick(84.15) == 84.15


def test_shadow_after_target_exit_records_the_high_and_fills_the_trade_log(tmp_path):
    clock = Clock()
    t, acc, _ = make(tmp_path, clock)
    t.set_auto(True)
    t.on_signal(GO, STATE)
    wait_idle(t)
    acc.ltp_value = 121.0
    t.tick()  # target exit at 121
    wait_idle(t)
    clock.set("11:00")
    acc.ltp_value = 140.0
    t.tick()  # after the exit the premium keeps rising: recorded, no order
    sent = list(acc.sent)
    t.on_candle("BANKNIFTY", {"spot": 54000.0, "i": 0, "ind": {"st_dir": [1]}})
    clock.set("15:16")
    acc.ltp_value = 130.0
    t.tick()
    assert acc.sent == sent  # shadow logging never sends an order
    clock.set("15:31")
    t.tick()
    t.finish_day()
    rows = list(csv.DictReader(open(os.path.join(str(tmp_path), "trade_log.csv"))))
    assert len(rows) == 1
    r = rows[0]
    assert r["highest_premium_after_exit"] == "140.0" and r["time_of_high_after_exit"] == "11:00"
    assert r["premium_at_1515"] == "130.0" and r["trend_still_held_at_1515"] == "Y"  # put, SuperTrend still red
    assert r["missed_profit_pct_of_entry"] == "19.0"  # (140 - 121) / 100


def test_skipped_setup_would_have_worked(tmp_path):
    clock = Clock()
    t, acc, _ = make(tmp_path, clock)
    acc.instrument_chain = lambda s, e: []
    skip = {**GO, "go": False, "grade": None, "at": "10:00"}
    t.add_skip(skip, STATE, "RSI 14", "Must-have missed")
    t.add_skip(skip, STATE, "RSI 14", "Must-have missed")  # same setup within 30 min: one row
    assert len([s for s in t.state["shadows"] if s["kind"] == "skip"]) == 1
    acc.ltp_value = 100.0
    t.tick()  # reference premium 100: stop 85, target 120
    clock.set("10:40")
    acc.ltp_value = 121.0
    t.tick()
    clock.set("15:31")
    t.tick()
    t.finish_day()
    rows = list(csv.DictReader(open(os.path.join(str(tmp_path), "shadow_skips.csv"))))
    assert rows[0]["would_it_have_worked"] == "Y" and rows[0]["skip_verdict"] == "Wrong" and rows[0]["target_time"] == "10:40"
    assert t.shadow_summary() == {"skipped": 1, "wouldHaveWorked": 1}


class FakeMegaBull(FakeAccount):
    key, rule = "megabull", "megabull"

    def instrument(self, symbol, expiry, spot, side):
        inst = super().instrument(symbol, expiry, spot, side)
        return {**inst, "id": 1 if side == "CE" else 2}


def test_dharani_v2_has_its_own_slot_but_never_buys_the_option_v1_holds(tmp_path):
    acc, alerts = FakeMegaBull(), []
    cfg = {**CFG, "logDir": str(tmp_path), "megabull": {"lots": 1, "stopPct": 10, "targetPct": 20},
           "limits": {"maxTradesPerDay": 6, "maxLossPerDay": 10000}}
    t = AutoTrader(cfg, [acc], clock=Clock(), alert=lambda k, m: alerts.append((k, m)),
                   state_path=os.path.join(str(tmp_path), "state.json"))
    t.set_auto(True)
    v1 = {**GO, "rule": "megabull", "name": "MEGABULL RULE", "setup": "Dharani v1", "symbol": "NIFTY", "side": "PE"}
    v2 = {**GO, "rule": "dharaniV2", "name": "DHARANI v2 RULE", "setup": "Dharani v2", "symbol": "NIFTY", "side": "PE"}
    assert t.on_signal(v1, STATE) == "Entry sent"
    wait_idle(t)
    assert t.positions("NIFTY") == {"megabull": True, "dharaniV2": False}
    assert t.on_signal(v2, STATE) == "Entry sent"  # its own slot is free ...
    wait_idle(t)
    assert len(t.state["trades"]) == 1  # ... but the same PE option is already held by v1: skipped
    assert any("already held by another rule" in m for _, m in alerts)
    assert t.on_signal({**v2, "side": "CE"}, STATE) == "Entry sent"  # the call is a different option
    wait_idle(t)
    assert [tr["slot"] for tr in t.state["trades"]] == ["megabull", "dharaniV2"]
    assert t.positions("NIFTY") == {"megabull": True, "dharaniV2": True}
    assert t.on_signal({**v2, "side": "CE"}, STATE) == "Position already open on this index"


def test_dharani_v2_entry_has_no_target_picks_strike_by_premium_and_exits_on_supertrend(tmp_path):
    acc, alerts = FakeMegaBull(), []
    cfg = {**CFG, "logDir": str(tmp_path), "megabull": {"lots": 1, "stopPct": 10, "targetPct": 20},
           "limits": {"maxTradesPerDay": 6, "maxLossPerDay": 10000}}
    t = AutoTrader(cfg, [acc], clock=Clock(), alert=lambda k, m: alerts.append((k, m)),
                   state_path=os.path.join(str(tmp_path), "state.json"))

    class Chain:
        def chain(self, symbol, expiry):
            return {"rows": [{"strike": 25000, "ce": {"last_price": 410}}, {"strike": 25200, "ce": {"last_price": 262}},
                             {"strike": 25300, "ce": {"last_price": 205}}]}
    t.chain_source = Chain()
    t.set_auto(True)
    v2 = {**GO, "rule": "dharaniV2", "name": "DHARANI v2 RULE", "setup": "Dharani v2", "symbol": "NIFTY", "side": "CE",
          "noTarget": True, "premiumNear": 250}
    st = {"spot": 25012.0, "idx": {"bar": {"close": 25150}, "ind": {"st_line": 25050, "rsi": 74}}, "fut": None}
    assert t.on_signal(v2, st) == "Entry sent"
    wait_idle(t)
    tr = t.state["trades"][0]
    assert tr["instrument"]["strike"] == 25200  # premium 262 is nearest 250
    assert tr["target"] is None and tr["stop"] == 90.0 and tr["rsi"] == 74 and tr["slot"] == "dharaniV2"
    acc.ltp_value = 500.0
    t._last_poll = {}
    t.tick()
    assert tr["status"] == "open"  # no fixed target to hit
    st["idx"]["bar"]["close"] = 25040  # closed below the SuperTrend line
    t.on_candle_v2("NIFTY", st)
    for _ in range(100):
        if tr["status"] == "closed":
            break
        time.sleep(0.05)
    assert tr["status"] == "closed" and tr["exitReason"] == "Signal"
