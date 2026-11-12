"""The Algos hub API (algos_api.py) over the Trending OI Algo's adapter (algo_adapters.ToiAdapter). Paper only."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

import algo_adapters
import algos_api
from test_toi_algo_service import DAY, OPTS, at, candle, entry, env, events  # noqa: F401  (env is a fixture)


def client(svc, user=None):
    from test_algo_service import signed_in
    app = signed_in(FastAPI(), user)
    algos_api.register(app, {"trending-oi": algo_adapters.ToiAdapter(svc)})
    return TestClient(app)


def test_tiles_from_days_and_trade_pnls():
    days = [{"date": "2026-11-10", "net": 1200.0, "charges": 80.0, "trades": 2},
            {"date": "2026-11-11", "net": -500.0, "charges": 40.0, "trades": 1}]
    t = algos_api.tiles(days, [1500.0, -200.0, -500.0])
    assert (t["net"], t["charges"], t["days"], t["trades"], t["wins"], t["losses"]) == (700.0, 120.0, 2, 3, 1, 2)
    assert t["winRate"] == 33.3 and t["avgWin"] == 1500.0 and t["avgLoss"] == -350.0
    assert t["bestDay"] == {"date": "2026-11-10", "net": 1200.0} and t["worstDay"]["date"] == "2026-11-11"
    no_pnls = algos_api.tiles([{**days[0], "wins": 2, "losses": 0}, {**days[1], "wins": 0, "losses": 1}], [])
    assert (no_pnls["trades"], no_pnls["wins"], no_pnls["losses"], no_pnls["winRate"]) == (3, 2, 1, 66.7)
    empty = algos_api.tiles([], [])
    assert empty["winRate"] is None and empty["bestDay"] is None and empty["net"] == 0


def test_parse_day_accepts_iso_and_dd_mm_yyyy():
    assert algos_api.parse_day("", "2026-11-12") == "2026-11-12"
    assert algos_api.parse_day("05-11-2026", "x") == "2026-11-05"
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        algos_api.parse_day("12/11/2026", "x")


def test_list_and_status_summary(env):
    svc, paper, clock, *_ = env
    entry(svc, paper, clock)
    c = client(svc)
    (row,) = c.get("/api/algos").json()["rows"]
    assert row["slug"] == "trending-oi" and row["name"] == "Trending OI Algo" and row["category"] == "intraday"
    assert row["state"] == "running" and row["open"].startswith("CE 23,200 × 2 lots · stop index below")
    assert row["lastEvent"]["text"].startswith("Entry filled")
    assert c.get("/api/algos/trending-oi/status").json()["todayPnl"] == row["todayPnl"]


def test_only_the_owner_sees_an_algo(env):
    from auth import User
    svc, *_ = env
    c = client(svc, User(2, "wife", "Wife"))
    assert c.get("/api/algos").json()["rows"] == []
    for path in ("status", "events", "trades", "reports", "settings", "rules"):
        assert c.get(f"/api/algos/trending-oi/{path}").status_code == 404, path
    assert c.post("/api/algos/trending-oi/stop-exit-all").status_code == 404
    assert c.put("/api/algos/trending-oi/settings", json={"maxTrades": 1}).status_code == 404
    assert client(svc).get("/api/algos/nope/status").status_code == 404


def test_events_newest_first_filtered_and_paged(env):
    svc, paper, clock, _store, toi, _ = env
    entry(svc, paper, clock)
    c = client(svc)
    all_ = c.get(f"/api/algos/trending-oi/events?date={DAY}&size=500").json()
    assert all_["total"] == len(events(toi)) and all_["rows"][0]["message"].startswith("Entry filled")
    assert {"entry", "info", "levels"} <= set(all_["types"]) and all_["variants"] == []
    ts = [r["ts"] for r in all_["rows"]]
    assert ts == sorted(ts, reverse=True)
    only = c.get(f"/api/algos/trending-oi/events?date={DAY}&type=entry,skip").json()
    assert only["rows"] and {r["type"] for r in only["rows"]} <= {"entry", "skip"}
    p2 = c.get(f"/api/algos/trending-oi/events?date={DAY}&size=3&page=2").json()
    assert p2["rows"] == all_["rows"][3:6] and p2["page"] == 2
    assert c.get("/api/algos/trending-oi/events?date=2026/11/12").status_code == 400


def test_trades_reports_and_kill_switch(env):
    svc, paper, clock, *_ = env
    entry(svc, paper, clock)
    c = client(svc)
    (t,) = c.get(f"/api/algos/trending-oi/trades?date={DAY}").json()["rows"]
    assert (t["side"], t["instrument"], t["lots"], t["pnl"]) == ("CE", "NIFTY 23,200 CE", 2, None) and t["note"].endswith("open")
    assert c.post("/api/algos/trending-oi/stop").json()["state"] == "stopped"
    assert c.post("/api/algos/trending-oi/resume").json()["state"] == "running"
    after = c.post("/api/algos/trending-oi/stop-exit-all").json()
    assert after["open"] is None and after["state"] == "stopped"
    (t,) = c.get(f"/api/algos/trending-oi/trades?date={DAY}").json()["rows"]
    assert t["pnl"] is not None and t["exitAt"]
    svc.write_summary(at("15:35"))
    rep = c.get(f"/api/algos/trending-oi/reports?from=2026-11-01&to={DAY}").json()
    assert len(rep["days"]) == 1 and rep["days"][0]["date"] == DAY and rep["tiles"]["trades"] == 1
    assert rep["holidays"] == ["2026-11-10"]  # NSE holiday in the range
    assert c.get(f"/api/algos/trending-oi/reports?from={DAY}&to=2026-11-01").status_code == 400


def test_settings_view_validation_and_history(env):
    svc, _paper, _clock, _store, toi, _ = env
    c = client(svc)
    v = c.get("/api/algos/trending-oi/settings").json()
    assert v["editable"] is True and v["history"] == []
    f = {x["key"]: x for x in v["fields"]}
    assert f["entryLots"]["kind"] == "int" and f["entryFrom"]["kind"] == "time" and f["strikeFallback"]["kind"] == "list"
    assert f["supertrendMult"]["kind"] == "number" and f["candleMin"]["value"] == 5 and f["candleMin"]["default"] == 3
    import trending_oi_algo_config as cfg
    assert {x["key"] for x in v["fields"]} == set(cfg.DEFAULTS) - {k for k in cfg.DEFAULTS if k not in f}
    assert c.put("/api/algos/trending-oi/settings", json={"entryLots": 2.5}).status_code == 400
    assert c.put("/api/algos/trending-oi/settings", json={"entryFrom": "9:45"}).status_code == 400
    assert c.put("/api/algos/trending-oi/settings", json={"candleMin": 4}).status_code == 400
    assert c.put("/api/algos/trending-oi/settings", json={"nope": 1}).status_code == 400
    assert not events(toi, "settings")  # nothing saved by a rejected change
    r = c.put("/api/algos/trending-oi/settings", json={"maxTrades": 1}).json()
    (h,) = r["history"]
    assert (h["key"], h["old"], h["new"], h["user"]) == ("maxTrades", 2, 1, "naveen") and h["ts"]
    assert {x["key"]: x for x in r["fields"]}["maxTrades"]["value"] == 1


def test_every_setting_is_on_the_page():
    import trending_oi_algo_config as cfg
    keys = [k for _, k, _ in algo_adapters.TOI_FIELDS]
    assert len(keys) == len(set(keys)) and set(keys) <= set(cfg.DEFAULTS)
    missing = set(cfg.DEFAULTS) - set(keys)
    assert not missing, missing


def test_rules_markdown(env):
    svc, *_ = env
    r = client(svc).get("/api/algos/trending-oi/rules").json()
    assert r["doc"] == "docs/strategies/trending-oi-algo.md" and r["markdown"].startswith("#")
