"""The app's own order / trade history: auto-trader steps become orders, trades keep their latest state, days stay
readable later; Excel rows and manual fills join the same list."""
import json
import os
import tempfile
from datetime import datetime

import journal as jr
from sig_indicators import IST

NOW = datetime(2026, 10, 26, 10, 5, 35, tzinfo=IST)


def trade(**over):
    t = {"id": "fourPillar-BANKNIFTY-100535", "account": "megabull", "slot": "fourPillar", "symbol": "BANKNIFTY",
         "setup": "4 Pillar Rules", "grade": "A", "side": "CE", "qty": 30, "instrument": {"name": "BANKNIFTY 27 OCT 56500 CALL"},
         "entryOrderId": "MB1", "entryTime": "10:05:35", "entryPrice": 339.5, "stop": 305.55, "target": 407.4,
         "stopOrderId": None, "status": "open"}
    t.update(over)
    return t


def test_megabull_steps_become_an_order_book_kept_by_day():
    j = jr.Journal(tempfile.mkdtemp())
    t = trade()
    j.record(t, "entry", NOW)
    t["stopOrderId"] = "MB2"
    j.record(t, "stop placed", NOW)
    t.update(status="closed", exitReason="Target", exitTime="10:41:02", exitPrice=407.4, exitOrderId="MB3",
             grossPnl=2037.0, charges=37.69, netPnl=1999.31)
    j.record(t, "exit Target", NOW)
    o = j.orders("2026-10-26")
    assert [(x["side"], x["type"], x["status"]) for x in o] == [("BUY", "MARKET", "FILLED"), ("SELL", "SL-M", "CANCELLED"),
                                                                ("SELL", "MARKET", "FILLED")]
    assert o[0]["strategy"] == "4 Pillar Rules" and o[0]["account"] == "MegaBull"
    tr = j.trades("2026-10-01", "2026-10-31")
    assert len(tr) == 1 and tr[0]["netPnl"] == 1999.31 and tr[0]["status"] == "closed"
    assert "2026-10-26" in j.days()


def test_stop_fill_updates_the_stop_order_and_manual_is_not_recorded():
    j = jr.Journal(tempfile.mkdtemp())
    t = trade(id="d1", account="dharani", slot="dharaniV2", symbol="NIFTY", side="PE", qty=65, stopOrderId="S1")
    j.record(t, "entry", NOW)
    j.record(t, "stop placed", NOW)
    t.update(status="closed", exitReason="Stop", exitTime="11:00:00", exitPrice=223.0)
    j.record(t, "exit Stop", NOW)
    o = j.orders("2026-10-26")
    assert [(x["side"], x["status"], x["price"]) for x in o] == [("BUY", "FILLED", 339.5), ("SELL", "FILLED", 223.0)]
    assert o[0]["strategy"] == "Power Breakout" and o[0]["account"] == "App · Power Breakout"  # was Dharani Rules (renamed 29-Oct-2026)
    # the filled stop shows its fill time; the time it was placed is kept as placedAt
    assert (o[1]["time"], o[1]["placedAt"]) == ("11:00:00", NOW.strftime("%H:%M:%S"))
    j.record(trade(id="m1", account="manual", slot="manual"), "bracket", NOW)
    assert all(x["tradeId"] != "m1" for x in j.orders("2026-10-26"))


def test_excel_history_and_manual_round_trips():
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "journal"))
    xl = [{"id": "xl-4p-10", "day": "2026-10-01", "source": "excel", "strategy": "4 Pillar Rules", "account": "MegaBull",
           "symbol": "BANKNIFTY", "side": "CE", "instrument": "BANKNIFTY 27 Oct 55000 CE", "qty": 30, "entryTime": "10:00",
           "entryPrice": 937.6, "exitTime": "12:25", "exitPrice": 849.8, "exitReason": None, "grossPnl": -2634.0,
           "charges": 104.07, "netPnl": -2738.07, "status": "closed"}]
    json.dump(xl, open(os.path.join(d, "journal", "imported.json"), "w"))
    j = jr.Journal(d)
    assert [o["side"] for o in j.orders("2026-10-01")] == ["BUY", "SELL"] and "2026-10-01" in j.days()
    assert j.trades("2026-10-01", "2026-10-01")[0]["netPnl"] == -2738.07
    fills = [{"security_id": 7, "side": "BUY", "qty": 65, "price": 100.0, "time": "2026-10-26T10:00:00+05:30",
              "charges": {"total": 20.0}, "name": "NIFTY 27 OCT 25800 PUT", "symbol": "NIFTY", "optionType": "PE"},
             {"security_id": 7, "side": "SELL", "qty": 65, "price": 110.0, "time": "2026-10-26T10:30:00+05:30",
              "charges": {"total": 25.0}, "name": "NIFTY 27 OCT 25800 PUT", "symbol": "NIFTY", "optionType": "PE"},
             {"security_id": 8, "side": "BUY", "qty": 30, "price": 300.0, "time": "2026-10-26T11:00:00+05:30",
              "charges": {"total": 20.0}, "name": "BANKNIFTY 27 OCT 56000 CALL", "symbol": "BANKNIFTY", "optionType": "CE"}]
    trips = jr.manual_round_trips(fills, "2026-10-26")
    assert [(t["status"], t["grossPnl"], t["netPnl"], t["side"]) for t in trips] == [("closed", 650.0, 605.0, "PE"), ("open", None, None, "CE")]
    assert trips[0]["entryTime"] == "10:00:00" and trips[0]["exitTime"] == "10:30:00"


def test_rows_saved_as_dharani_read_back_as_power_breakout():
    import journal
    old = {"id": "x", "strategy": "Dharani Rules", "account": "App · Dharani"}
    assert journal.renamed(old) == {"id": "x", "strategy": "Power Breakout", "account": "App · Power Breakout"}
    assert journal.renamed({"strategy": "Manual", "account": "App · Manual"}) == {"strategy": "Manual", "account": "App · Manual"}
