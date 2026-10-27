import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

import notify

TRADE = {"id": "st-1", "account": "megabull", "slot": "superTrend", "symbol": "NIFTY", "qty": 65,
         "instrument": {"id": 1, "name": "NIFTY 27 OCT 22800 CALL"}, "entryPrice": 95.3, "entryTime": "10:20:04",
         "stop": 85.77, "target": 114.36, "status": "open"}


class Resp:
    def __init__(self, code=200):
        self.status_code = code


def keys(tmp_path):
    p = tmp_path / "telegram.json"
    p.write_text(json.dumps({"botToken": "123:abc", "chatId": 42}), encoding="utf-8")
    return str(p)


def test_texts():
    assert notify.entry_text(TRADE) == ("🔵 ENTRY · SuperTrend Rules\nNIFTY 27 OCT 22800 CALL · 65 qty @ 95.30 · 10:20"
                                        " · stop 85.77 · target 114.36")
    closed = {**TRADE, "status": "closed", "exitPrice": 73.9, "exitTime": "10:41:30", "exitReason": "Stop loss", "netPnl": -1513}
    assert notify.exit_text(closed, -611.4) == ("🔴 EXIT · SuperTrend Rules · −₹1,513\nNIFTY 27 OCT 22800 CALL · 95.30 → 73.90"
                                                " · Stop loss · 10:41\nToday so far: −₹611")


def test_summary_lists_every_strategy():
    rows = [
        {"strategy": "SuperTrend Rules", "status": "closed", "netPnl": -1513, "instrument": "NIFTY 22800 CALL"},
        {"strategy": "Dharani Rules", "status": "closed", "netPnl": 901.6, "instrument": "BANKNIFTY 54500 PUT"},
        {"strategy": "Manual", "status": "open", "netPnl": None, "instrument": "NIFTY 22700 PUT"},
        {"strategy": "Rebound Call", "status": "closed", "netPnl": 702, "instrument": "BANKNIFTY 54600 CALL"},
    ]
    text = notify.summary_text("27 Oct", rows, ["4 Pillar Rules", "SuperTrend Rules", "Dharani Rules", "Manual"])
    assert text.splitlines() == [
        "📋 Day summary 27 Oct · +₹91", "⚪ 4 Pillar Rules: no trade", "🔴 SuperTrend Rules: −₹1,513 (1 trade, 0 won)",
        "🟢 Dharani Rules: +₹902 (1 trade, 1 won)", "🔵 Manual: still in a trade", "🟢 Rebound Call: +₹702 (1 trade, 1 won)", "⚠ Still open: NIFTY 22700 PUT",
    ]


def test_off_without_keys(tmp_path):
    sent = []
    n = notify.Notifier(keys_file=str(tmp_path / "none.json"), post=lambda u, b: sent.append(b), start=False)
    assert not n.enabled
    n.send("hello")
    assert n.q.empty()
    assert n.send_now("hello")[0] is False and sent == []


def test_sends_entry_and_exit_only(tmp_path):
    sent = []
    n = notify.Notifier(keys_file=keys(tmp_path), post=lambda u, b: (sent.append((u, b)), Resp())[1], start=False)
    n.on_order(TRADE, "entry")
    n.on_order(TRADE, "stop placed")
    n.on_order({**TRADE, "status": "closed", "exitPrice": 110, "exitReason": "Target", "netPnl": 900}, "exit target", 900)
    while not n.q.empty():
        assert n.send_now(n.q.get())[0]
    texts = [b["text"] for _, b in sent]
    assert len(texts) == 2 and texts[0].startswith("🔵 ENTRY") and texts[1].startswith("🟢 EXIT")
    assert sent[0][0] == "https://api.telegram.org/bot123:abc/sendMessage" and sent[0][1]["chat_id"] == "42"


def test_failure_is_reported_once_and_never_raises(tmp_path):
    alerts = []

    def boom(u, b):
        raise ConnectionError("offline")
    n = notify.Notifier(keys_file=keys(tmp_path), post=boom, alert=lambda k, m: alerts.append(m), start=False)
    assert n.send_now("x") == (False, "ConnectionError")
    assert n.failed == 1


def test_test_endpoint(tmp_path):
    app = FastAPI()
    notify.register(app, notify.Notifier(keys_file=keys(tmp_path), post=lambda u, b: Resp(), start=False))
    c = TestClient(app)
    assert c.get("/api/notify/status").json()["enabled"] is True
    assert c.post("/api/notify/test").json() == {"ok": True}
    app2 = FastAPI()
    notify.register(app2, notify.Notifier(keys_file=str(tmp_path / "x.json"), start=False))
    assert TestClient(app2).post("/api/notify/test").status_code == 400


def test_day_summary_goes_to_the_phone_after_the_close(tmp_path):
    from datetime import datetime

    import sig_service
    now = datetime(2026, 10, 27, 15, 31, 40, tzinfo=sig_service.IST)
    svc = sig_service.SignalService({"logDir": str(tmp_path)}, None, None, clock=lambda: now)
    sent = []
    svc.phone = type("P", (), {"send": lambda self, t: sent.append(t)})()
    svc.rows_today = lambda: [{"strategy": "Trend Rules", "status": "closed", "netPnl": -286, "instrument": "X"}]
    svc.heartbeat = now
    svc._end_of_day(now)
    svc._end_of_day(now)  # once a day
    assert len(sent) == 1 and sent[0].startswith("📋 Day summary 27 Oct · −₹286") and "🔴 Trend Rules: −₹286" in sent[0]


ORDER = ["4 Pillar Rules", "SuperTrend Rules", "Dharani Rules", "Trend Rules", "Rebound Call", "Manual"]
MARKET = [("Nifty", 22718.4, 22809.0), ("Bank Nifty", 54347.0, 54510.0)]


def test_hourly_update_matches_the_owners_sample():
    rows = [
        {"id": "d2-1", "strategy": "Dharani Rules", "status": "closed", "netPnl": 901.6, "exitReason": "Target",
         "instrument": "BANKNIFTY 54500 PUT"},
        {"id": "th-1", "strategy": "Trend Rules", "status": "open", "netPnl": None, "instrument": "NIFTY 22800 CALL"},
        {"id": "st-1", "strategy": "SuperTrend Rules", "status": "closed", "netPnl": -1513, "exitReason": "Stop loss",
         "instrument": "NIFTY 22800 CALL"},
        {"id": "manual-1", "strategy": "Manual", "status": "open", "netPnl": None, "instrument": "NIFTY 22700 PUT"},
        {"id": "manual-2", "strategy": "Manual", "status": "open", "netPnl": None, "instrument": "BANKNIFTY 54400 PUT"},
    ]
    near = {"4 Pillar Rules": {"met": 4, "total": 5, "symbol": "NIFTY", "side": "PE", "time": "10:40", "missing": ["PCR"]}}
    text = notify.hourly_text("11:15", rows, ORDER, MARKET, near, {"th-1": -286.0}, 612.0)
    assert text.splitlines() == [
        "⏰ 11:15 update · Today so far: −₹285",
        "Market: Nifty 22,718 (−0.4%) · Bank Nifty 54,347 (−0.3%)",
        "🟡 4 Pillar Rules: came close, 4 of 5 on Nifty put at 10:40 (missing: PCR)",
        "🔴 SuperTrend Rules: lost −₹1,513 (Stop loss, NIFTY 22800 CALL)",
        "🟢 Dharani Rules: won +₹902 (Target, BANKNIFTY 54500 PUT)",
        "🔵 Trend Rules: in trade NIFTY 22800 CALL, −₹286 now",
        "⚪ Rebound Call: no setup this hour",
        "👤 My trades: 2 open, +₹612 now",
    ]


def test_day_summary_shows_market_and_closest_call():
    near = {"4 Pillar Rules": {"met": 4, "total": 5, "symbol": "BANKNIFTY", "side": "CE", "time": "11:40", "missing": ["VWAP"]}}
    rows = [{"strategy": "Trend Rules", "status": "closed", "netPnl": -286, "instrument": "X"}]
    lines = notify.summary_text("27 Oct", rows, ORDER, MARKET, near).splitlines()
    assert lines[1] == "Market: Nifty 22,718 (−0.4%) · Bank Nifty 54,347 (−0.3%)"
    assert lines[2] == "⚪ 4 Pillar Rules: no trade (closest: 4 of 5 on Bank Nifty call at 11:40 (missing: VWAP))"


def test_hourly_updates_once_an_hour_from_10_15_to_14_15(tmp_path):
    from datetime import datetime

    import sig_service
    clock = {"now": datetime(2026, 10, 27, 10, 10, 35, tzinfo=sig_service.IST)}
    svc = sig_service.SignalService({"logDir": str(tmp_path)}, None, None, clock=lambda: clock["now"])
    sent = []
    svc.phone = type("P", (), {"send": lambda self, t: sent.append(t)})()
    svc.heartbeat = clock["now"]
    rule = {"rule": "fourPillar", "go": False, "side": "PE", "blocked": [], "checks": [
        {"id": "trigger", "label": "Trigger candle", "state": sig_service.PASS},
        {"id": "pcr", "label": "PCR", "state": "fail"}]}
    for hm, expect in (((10, 10), 0), ((10, 15), 1), ((10, 50), 1), ((11, 15), 2), ((14, 15), 3), ((15, 15), 3)):
        clock["now"] = clock["now"].replace(hour=hm[0], minute=hm[1])
        if hm == (10, 10):
            svc._track_near("NIFTY", {"fourPillar": rule})
        svc._hourly(clock["now"])
        assert len(sent) == expect, hm
    assert "🟡 4 Pillar Rules: came close, 1 of 2 on Nifty put at 10:10 (missing: PCR)" in sent[0]
    assert "⚪ 4 Pillar Rules: no setup this hour" in sent[1]  # the hour's near miss is reported once
    assert "4 Pillar Rules" in svc._near["all"]  # the day summary still knows it
