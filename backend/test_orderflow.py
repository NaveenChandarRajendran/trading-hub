"""Estimated delta: quote rule against the previous best bid / ask, tick rule in between (orderflow.py)."""
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
    b.on_full(sid, 100.5, 1300, 100.0, 101.0, at("10:00", 5))  # 300 at the ask 100.5 -> buy
    b.on_full(sid, 100.0, 1500, 99.5, 100.5, at("10:00", 9))  # 200 at the bid 100.0 -> sell
    b.on_full(sid, 100.2, 1600, 99.9, 100.6, at("10:00", 20))  # 100 between bid 99.5 / ask 100.5, up from 100 -> buy
    b.on_full(sid, 100.2, 1650, 99.9, 100.6, at("10:00", 30))  # 50 between, unchanged -> not counted
    b.on_full(sid, 99.8, 1700, 99.7, 100.1, at("10:01", 2))  # 50 at/below bid 99.9 -> sell, next minute
    s = b.series(sid)
    assert [(m["buy"], m["sell"], m["delta"]) for m in s] == [(400, 200, 200), (0, 50, -50)]
    assert [m["cumulative"] for m in s] == [200, 150]


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
