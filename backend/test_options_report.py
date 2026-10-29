"""options_report.py: trades by index + expiry, booked vs unbooked, charges counted once, months by expiry month."""
import pytest

from options_report import months, report, trades

CH = {"total": 20.0}


def fill(i, time, expiry, sid, side, qty, price, kind="open", realized=0.0, charges=CH, strike=24000.0, ot="PE"):
    return {"id": f"OF{i:04d}", "order_id": "OB1", "security_id": sid, "side": side, "qty": qty, "price": price,
            "value": round(qty * price, 2), "charges": charges, "time": time, "kind": kind, "realized": realized,
            "symbol": "NIFTY", "expiry": expiry, "strike": strike, "optionType": ot, "lotSize": 65}


# A condor settled OTM (Oct), one exited early at a loss (Nov), one still open (Nov)
SETTLED = [fill(1, "2026-10-21T10:00:00+05:30", "2026-10-27", 1, "SELL", 65, 19.2),
           fill(2, "2026-10-21T10:00:00+05:30", "2026-10-27", 2, "BUY", 65, 8.85),
           fill(3, "2026-10-27T15:30:00+05:30", "2026-10-27", 1, "BUY", 65, 0.0, "settle", 1248.0, {"total": 0.0}),
           fill(4, "2026-10-27T15:30:00+05:30", "2026-10-27", 2, "SELL", 65, 0.0, "settle", -575.25, {"total": 0.0})]
EXITED = [fill(5, "2026-10-28T10:00:00+05:30", "2026-11-03", 3, "SELL", 65, 40.0),
          fill(6, "2026-10-29T11:00:00+05:30", "2026-11-03", 3, "BUY", 65, 60.0, "close", -1300.0)]
OPEN = [fill(7, "2026-11-04T10:00:00+05:30", "2026-11-10", 4, "SELL", 65, 30.0)]
OPEN_LEGS = [{"security_id": 4, "symbol": "NIFTY", "expiry": "2026-11-10", "unrealized": 325.0}]
ALL = SETTLED + EXITED + OPEN


def test_one_trade_per_index_and_expiry_with_status():
    rows = {r["expiry"]: r for r in trades(ALL, OPEN_LEGS)}
    assert [r["expiry"] for r in trades(ALL, OPEN_LEGS)] == ["2026-11-10", "2026-11-03", "2026-10-27"]
    s = rows["2026-10-27"]
    assert (s["status"], s["legs"], s["credit"]) == ("settled", 2, pytest.approx(672.75))
    assert s["booked"] == pytest.approx(1248.0 - 575.25 - 40.0) and s["net"] == s["booked"] and s["unbooked"] == 0.0
    assert s["closedAt"] == "2026-10-27T15:30:00+05:30" and len(s["fills"]) == 4
    e = rows["2026-11-03"]
    assert (e["status"], e["booked"], e["charges"]) == ("closed", -1340.0, 40.0)
    o = rows["2026-11-10"]
    assert (o["status"], o["closedAt"], o["booked"], o["unbooked"], o["net"]) == ("open", None, -20.0, 325.0, 305.0)


def test_months_by_expiry_and_summary_adds_up():
    r = report(ALL, OPEN_LEGS, 200000)
    oct_, nov = sorted(r["months"], key=lambda m: m["month"])
    assert (oct_["month"], oct_["trades"], oct_["wins"], oct_["winPct"], oct_["net"]) == ("2026-10", 1, 1, 100.0, 632.75)
    assert (nov["trades"], nov["open"], nov["wins"], nov["losses"], nov["net"]) == (1, 1, 0, 1, pytest.approx(-1035.0))
    assert (nov["best"], nov["worst"], nov["returnPct"]) == (-1340.0, -1340.0, -0.52)
    s = r["summary"]
    assert s["booked"] == pytest.approx(632.75 - 1340.0 - 20.0) and s["unbooked"] == 325.0
    assert s["total"] == pytest.approx(sum(m["net"] for m in r["months"]))
    assert s["charges"] == 100.0  # 5 charged fills x 20, each once
    assert (s["trades"], s["open"], s["wins"], s["winPct"]) == (2, 1, 1, 50.0)


def test_nothing_traded_yet():
    assert report([], [], 200000)["summary"] == {
        "capital": 200000.0, "booked": 0.0, "unbooked": 0.0, "total": 0.0, "charges": 0.0, "returnPct": 0.0,
        "trades": 0, "open": 0, "wins": 0, "winPct": None}
    assert months([], 200000) == []
