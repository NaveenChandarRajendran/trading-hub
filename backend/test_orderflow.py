"""Estimated delta: side of the packet's bid / ask middle; at the middle the previous quote and the tick rule (orderflow.py)."""
from datetime import datetime

from orderflow import DeltaBuilder, aggregate_flow, dext_match
from sig_indicators import IST


def at(hm, s=0):
    h, m = map(int, hm.split(":"))
    return datetime(2026, 10, 23, h, m, s, tzinfo=IST)


def test_quote_rule_tick_rule_and_cumulative():
    b = DeltaBuilder()
    sid = 1
    assert b.on_full(sid, 100.0, 1000, 99.5, 100.5, at("10:00")) is None  # first packet sets the base
    b.on_full(sid, 100.8, 1300, 100.5, 101.0, at("10:00", 5))  # 300 above the packet's mid 100.75 -> buy
    b.on_full(sid, 100.1, 1500, 100.0, 100.5, at("10:00", 9))  # 200 below its mid 100.25 -> sell
    # exactly at the mid: the previous packet's quote and the tick rule decide
    b.on_full(sid, 100.5, 1600, 100.0, 101.0, at("10:00", 20))  # 100 at the previous ask 100.5 -> buy
    b.on_full(sid, 100.3, 1650, 100.1, 100.5, at("10:00", 30))  # 50 between previous 100.0 / 101.0, down from 100.5 -> sell
    b.on_full(sid, 100.3, 1700, 100.1, 100.5, at("10:00", 40))  # 50 between, unchanged -> not counted
    b.on_full(sid, 99.8, 1750, 99.7, 100.1, at("10:01", 2))  # 50 below mid 99.9 -> sell, next minute
    s = b.series(sid)
    assert [(m["buy"], m["sell"], m["delta"]) for m in s] == [(400, 250, 150), (0, 50, -50)]
    assert [m["cumulative"] for m in s] == [150, 100]


def test_volume_reset_and_outside_session_are_ignored():
    b = DeltaBuilder()
    b.on_full(1, 100.0, 1000, 99.5, 100.5, at("10:00"))
    b.on_full(1, 100.5, 900, 100.0, 101.0, at("10:00", 5))  # lower day volume = feed reset: new base, nothing counted
    assert b.series(1) == []
    assert b.on_full(1, 100.0, 5000, 99.0, 101.0, at("15:31")) is None


def test_aggregate_and_dext_match():
    mins = [{"time": int(at("10:0%d" % k).timestamp()), "buy": 10, "sell": 4, "close": 1.0, "delta": 6, "cumulative": 6 * (k + 1)} for k in range(6)]
    five = aggregate_flow(mins, 5)
    assert [(x["buy"], x["sell"], x["delta"], x["cumulative"]) for x in five] == [(50, 20, 30, 30), (10, 4, 6, 36)]
    assert dext_match(30, 12000) and not dext_match(30, -5) and dext_match(5, None) is None


def test_an_earlier_day_is_read_back_from_its_file(tmp_path):
    from datetime import date
    from orderflow import OrderFlowService, OrderFlowStore
    fut = {"securityId": 7, "name": "NIFTY OCT FUT"}
    clock = [at("10:00")]
    svc = OrderFlowService(OrderFlowStore(str(tmp_path)), lambda s: fut if s == "NIFTY" else None, clock=lambda: clock[0])

    class Book:
        best_bid, best_ask = 99.5, 100.5
    svc.on_packet(7, {"ltp": 100.0, "volume": 1000}, Book())
    svc.on_packet(7, {"ltp": 100.5, "volume": 1300}, Book())
    svc.set_dext("NIFTY", 5, "10:00", 250)
    svc.save()
    clock[0] = datetime(2026, 10, 26, 9, 20, tzinfo=IST)  # next trading day
    f, rows = svc.series("NIFTY", 5, date(2026, 10, 23))
    assert f["name"] == "NIFTY OCT FUT" and rows[0]["buy"] == 300
    assert svc.typed("NIFTY", 5, date(2026, 10, 23)) == {"10:00": 250}
    assert svc.days() == ["2026-10-26", "2026-10-23"] or svc.days() == ["2026-10-23"]
    assert svc.series("NIFTY", 5)[1] == []  # today: nothing yet


def test_raw_packets_are_logged(tmp_path):
    from orderflow import OrderFlowService, OrderFlowStore
    svc = OrderFlowService(OrderFlowStore(str(tmp_path)), lambda s: None, clock=lambda: at("10:00"))

    class Book:
        best_bid, best_ask = 99.5, 100.5
    svc.on_packet(7, {"ltp": 100.0, "ltq": 75, "volume": 1000}, Book())
    svc.save()
    lines = (tmp_path / "orderflow_raw_2026-10-23.csv").read_text().splitlines()
    assert lines[0].startswith("time,") and lines[1].endswith(",7,100.0,75,1000,99.5,100.5")
    assert svc.days() == ["2026-10-23"]


def test_an_earlier_day_is_recomputed_from_its_raw_log(tmp_path):
    # owner 29-Oct-2026: past days use the current rule, rebuilt from data/orderflow_raw_<day>.csv
    from orderflow import OrderFlowService, OrderFlowStore
    store = OrderFlowStore(str(tmp_path))
    store.save("2026-10-22", {"minutes": {"7": [{"time": int(at("10:00").timestamp()), "buy": 0, "sell": 999, "close": 100}]},
                              "dext": {}, "futures": {"7": {"symbol": "NIFTY", "name": "NIFTY NOV FUT"}}})
    t0 = datetime(2026, 10, 22, 10, 0, 0, tzinfo=IST).timestamp()
    (tmp_path / "orderflow_raw_2026-10-22.csv").write_text(
        "time,security_id,ltp,ltq,volume,bid,ask\n"
        f"{t0:.3f},7,100.0,65,1000,99.5,100.5\n{t0 + 2:.3f},7,100.8,65,1300,100.5,101.0\n")
    svc = OrderFlowService(store, lambda s: None, clock=lambda: at("12:00"))
    f, rows = svc.series("NIFTY", 1, at("10:00").date().replace(day=22))
    assert f["securityId"] == 7 and [(r["buy"], r["sell"]) for r in rows] == [(300, 0)]  # not the saved 999 sold
