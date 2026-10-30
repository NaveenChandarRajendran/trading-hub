"""Selling book (sell_rules.py + sell_desk.py): the three option SELLING rules on fake prices. PAPER ONLY."""
from datetime import datetime, timedelta

import os
import pytest

import sell_rules as R
from paper_engine import Book
from sell_desk import SellDesk
from sig_indicators import IST

TUE = datetime(2026, 11, 3, tzinfo=IST)  # a NIFTY expiry Tuesday
WED = datetime(2026, 11, 4, tzinfo=IST)


def at(day, h, m, s=0):
    return day.replace(hour=h, minute=m, second=s)


# ---------------------------------------------------------------- rules
def test_bb_width_and_calm():
    assert R.bb_width([100.0] * 19) is None
    assert R.bb_width([100.0] * 20) == 0
    w = R.bb_width([100.0, 102.0] * 10)  # SD 1, mean 101 -> 4 / 101 x 100
    assert round(w, 4) == round(400 / 101, 4)
    assert R.calm_check(1.34, 1.34) and not R.calm_check(1.35, 1.34) and not R.calm_check(None, 1.34)


def test_hourly_closes_buckets_from_0915():
    day = at(WED, 9, 15)
    mins = [{"time": int((day + timedelta(minutes=i)).timestamp()), "close": 100 + i} for i in range(130)]
    # 09:15-10:14 -> last close 159; 10:15-11:14 -> 219; 11:15-11:24 -> 229 (bucket so far)
    assert R.hourly_closes(mins) == [159, 219, 229]
    assert R.hourly_closes(list(reversed(mins))) == [159, 219, 229]


def test_strangle_expiry_and_strikes():
    exps = ["2026-11-03", "2026-11-10", "2026-11-24", "2026-12-29", "2027-03-30"]
    assert R.strangle_expiry(exps, WED.date()) == "2026-12-29"  # 55 days
    assert R.strangle_expiry(exps[:3], WED.date()) is None
    assert R.strangle_strikes(22698.85) == (23800, 21600)
    assert R.strangle_strikes(22698.85, 3) == (23400, 22000)
    assert R.roll_due(100, 30) and not R.roll_due(100, 30.05) and not R.roll_due(100, None)
    assert R.leg_stop(100.03, 50) == 150.05 and R.leg_stop(80, 50) == 120.0
    assert R.is_expiry_day(["2026-11-03"], TUE.date()) and not R.is_expiry_day(["2026-11-10"], WED.date())


def test_config_merges_one_level():
    c = R.config({"sellCalmCall": {"maxWidth": 1.5}, "lots": 2})
    assert c["sellCalmCall"] == {**R.DEFAULTS["sellCalmCall"], "maxWidth": 1.5} and c["lots"] == 2
    assert c["sellStraddle"]["stopPct"] == 50


# ---------------------------------------------------------------- desk
class FakePaper:
    def __init__(self, now, expiries):
        self.now, self.holidays, self.expiries = now, set(), expiries
        self.watched = []

    def clock(self):
        return self.now

    def watch(self, ids, group="auto"):
        self.watched = list(ids)

    def option_expiries(self, symbol):
        return self.expiries

    def instrument_chain(self, symbol, expiry):
        out = []
        for k in range(20000, 26001, 50):
            row = {"strike": float(k), "ce": None, "pe": None}
            for opt in ("CE", "PE"):
                sid = int(f"{1 if opt == 'CE' else 2}{expiry[5:7]}{expiry[8:10]}{k}")
                row[opt.lower()] = {"securityId": sid, "symbol": "NIFTY", "expiry": expiry, "strike": float(k),
                                    "optionType": opt, "lotSize": 65, "name": f"NIFTY {expiry} {k} {opt}"}
            out.append(row)
        return out


class FakeCandles:
    def __init__(self, one_min):
        self.one_min = one_min

    def get(self, symbol, max_age=None):
        return None, (), self.one_min, None, "", ""

    def get_with_futures(self, symbol, max_age=None, n=4):
        return (), self.one_min, [], ""


def minutes(day, closes_by_hour, spot):
    """1-minute candles: earlier sessions' hourly closes (7 a day) + today's 09:15-10:14 at `spot`."""
    out = []
    for i, c in enumerate(closes_by_hour):
        d = day - timedelta(days=1 + i // 7)
        t = at(d, 9, 15) + timedelta(minutes=60 * (i % 7) + (14 if i % 7 == 6 else 59))
        out.append({"time": int(t.timestamp()), "close": c})
    out.sort(key=lambda m: m["time"])
    for i in range(60):
        out.append({"time": int((at(day, 9, 15) + timedelta(minutes=i)).timestamp()), "close": spot})
    return out


def sid(opt, expiry, k):
    return int(f"{1 if opt == 'CE' else 2}{expiry[5:7]}{expiry[8:10]}{k}")


def bk(ltp, spread=0.5):
    return Book(ltp, bids=[(ltp - spread / 2, 1000)], asks=[(ltp + spread / 2, 1000)])


@pytest.fixture
def make(tmp_path):
    n = [0]

    def _make(now, expiries, one_min, cfg=None):
        n[0] += 1  # each desk its own state folder
        paper = FakePaper(now, expiries)
        events = []
        desk = SellDesk(cfg or {"sellStrangle": {"enabled": False}}, paper, FakeCandles(one_min),
                        on_event=lambda t, e: events.append((t, e)), data_dir=str(tmp_path / f"d{n[0]}"), start=False)
        return desk, paper, events
    return _make


def test_expiry_straddle_sells_both_legs_and_trails_to_cost(make):
    exp = "2026-11-03"
    one_min = minutes(TUE, [22700.0] * 21, 22712.0)
    desk, paper, ev = make(at(TUE, 9, 20, 1), [exp, "2026-11-10"], one_min)
    ce, pe = sid("CE", exp, 22700), sid("PE", exp, 22700)
    desk.step(paper.now)  # 09:20: wants prices first
    assert set(paper.watched) == {ce, pe} and not desk.open_legs()
    desk.on_tick(ce, bk(80.5), paper.now)
    desk.on_tick(pe, bk(70.5), paper.now)
    desk.step(paper.now)
    legs = {lg["side"]: lg for lg in desk.open_legs(R.STRADDLE)}
    assert legs["CE"]["entryPrice"] == 80.25 and legs["CE"]["stop"] == 120.40 and legs["PE"]["stop"] == 105.40
    assert [e for _, e in ev] == ["entry", "entry"] and ev[0][0]["short"] and ev[0][0]["account"] == "selling"
    desk.step(at(TUE, 9, 25))  # once a day
    assert len(desk.open_legs()) == 2
    desk.on_tick(ce, bk(121.0), at(TUE, 11, 0))  # CE stop hit: buy back on the asks
    c = desk.state["legs"][legs["CE"]["id"]]
    assert c["status"] == "closed" and c["exitPrice"] == 121.25 and c["exitReason"] == "Stop"
    assert c["grossPnl"] == round((80.25 - 121.25) * 65, 2) and c["netPnl"] < c["grossPnl"]
    assert legs["PE"]["stop"] == legs["PE"]["entryPrice"]  # moved to cost
    desk.on_tick(pe, bk(40.0), at(TUE, 15, 0))
    desk.step(at(TUE, 15, 14))  # time exit
    p = desk.state["legs"][legs["PE"]["id"]]
    assert p["exitReason"] == "Time exit 15:14" and p["exitPrice"] == 40.25
    assert ev[-1][1] == "exit Time exit 15:14" and ev[-1][0]["netPnl"] > 0
    s = desk.status()
    assert s["open"] == [] and s["realized"] == round(c["netPnl"] + p["netPnl"], 2) and s["capital"] == 300000


def test_timed_expiry_straddles_wide_stop_no_trail(make):
    exp = "2026-11-03"
    off = {k: {"enabled": False} for k in (R.STRADDLE, R.CALM, R.STRANGLE, R.S1126, R.S1224)}
    desk, paper, ev = make(at(TUE, 9, 40, 1), [exp, "2026-11-10"], minutes(TUE, [22700.0] * 21, 22712.0), off)
    ce, pe = sid("CE", exp, 22700), sid("PE", exp, 22700)
    desk.step(paper.now)
    desk.on_tick(ce, bk(80.5), paper.now)
    desk.on_tick(pe, bk(70.5), paper.now)
    desk.step(paper.now)
    legs = {lg["side"]: lg for lg in desk.open_legs(R.S940)}
    assert legs["CE"]["stop"] == R.leg_stop(80.25, 80) and legs["PE"]["stop"] == R.leg_stop(70.25, 80)
    assert not desk.open_legs(R.STRADDLE)
    desk.on_tick(ce, bk(145.0), at(TUE, 11, 0))  # CE stop: PE keeps its own stop (no move to cost)
    assert desk.state["legs"][legs["CE"]["id"]]["exitReason"] == "Stop"
    assert desk.state["legs"][legs["PE"]["id"]]["stop"] == R.leg_stop(70.25, 80)
    desk.on_tick(pe, bk(40.0), at(TUE, 15, 0))
    desk.step(at(TUE, 15, 14))
    assert desk.state["legs"][legs["PE"]["id"]]["exitReason"] == "Time exit 15:14"
    assert R.DEFAULTS[R.S1126]["entry"] == "11:26" and R.DEFAULTS[R.S1224]["stopPct"] == 70


def test_no_straddle_on_other_days(make):
    desk, paper, ev = make(at(WED, 9, 21), ["2026-11-10"], minutes(WED, [22700.0] * 21, 22700.0))
    desk.step(paper.now)
    assert not desk.open_legs() and "Not a NIFTY expiry day" in desk.state["notes"][R.STRADDLE]


def test_calm_call_sell_only_on_narrow_bands(make):
    exp = "2026-11-10"
    calm = minutes(WED, [22700.0 + (i % 2) * 20 for i in range(21)], 22705.0)  # width ~0.18 %
    desk, paper, ev = make(at(WED, 10, 15, 2), [exp], calm, {"sellStraddle": {"enabled": False},
                                                            "sellStrangle": {"enabled": False}})
    k = sid("CE", exp, 22700)
    desk.on_tick(k, bk(100.0), paper.now)
    desk.step(paper.now)
    (lg,) = desk.open_legs(R.CALM)
    assert lg["strike"] == 22700 and lg["stop"] == 149.65 and "Calm" in desk.state["notes"][R.CALM]
    wide = minutes(WED, [22000.0 + (i % 2) * 900 for i in range(21)], 22705.0)
    desk2, paper2, _ = make(at(WED, 10, 15, 2), [exp], wide, {"sellStraddle": {"enabled": False},
                                                              "sellStrangle": {"enabled": False}})
    desk2.step(paper2.now)
    assert not desk2.open_legs() and desk2.state["notes"][R.CALM].startswith("Not calm")


def test_entry_gives_up_after_ten_minutes_without_prices(make):
    desk, paper, _ = make(at(TUE, 9, 20), ["2026-11-03"], minutes(TUE, [22700.0] * 21, 22700.0),
                          {"sellStrangle": {"enabled": False}, "sellCalmCall": {"enabled": False}})
    desk.step(at(TUE, 9, 20))
    assert not desk.state["done"].get(R.STRADDLE)
    desk.step(at(TUE, 9, 30, 1))
    assert desk.state["done"][R.STRADDLE] and desk.state["notes"][R.STRADDLE].startswith("Skipped today")


def test_strangle_rolls_and_stops_at_max_loss_and_carries_days(make, tmp_path):
    exp = "2026-12-29"
    one_min = minutes(WED, [22700.0] * 21, 22700.0)
    cfg = {"sellStraddle": {"enabled": False}, "sellCalmCall": {"enabled": False}}
    desk, paper, ev = make(at(WED, 10, 0, 1), ["2026-11-10", exp], one_min, cfg)
    ce, pe = sid("CE", exp, 23800), sid("PE", exp, 21600)
    desk.on_tick(ce, bk(200.0), paper.now)
    desk.on_tick(pe, bk(250.0), paper.now)
    desk.step(paper.now)
    assert {lg["strike"] for lg in desk.open_legs(R.STRANGLE)} == {23800, 21600}
    assert all(lg["stop"] is None for lg in desk.open_legs())  # no per-leg stop on the strangle
    # 15:05: the call has kept 70 % -> roll to a new 3 % call; the put stays
    desk.on_tick(ce, bk(59.0), at(WED, 15, 0))
    new_ce = sid("CE", exp, 23800)  # spot unchanged -> same strike again
    desk.step(at(WED, 15, 5, 1))
    closed = [lg for lg in desk.state["legs"].values() if lg["status"] == "closed"]
    assert [lg["exitReason"] for lg in closed] == ["Roll"]
    assert len(desk.open_legs(R.STRANGLE)) == 2 and desk.state["cycle"]["booked"] == closed[0]["netPnl"]
    assert new_ce in paper.watched
    # survives a restart and shows on the next day's journal as open
    desk2 = SellDesk(cfg, paper, FakeCandles(one_min), on_event=lambda t, e: ev.append((t, e)), data_dir=str(tmp_path / "d1"),
                     start=False)
    desk2.step(at(WED + timedelta(days=1), 9, 16))
    assert [e for _, e in ev[-2:]] == ["carry", "carry"]
    # a big rally: the strangle loses more than Rs 60k -> everything bought back at the next 15:05 check
    for lg in desk2.open_legs():
        desk2.on_tick(lg["securityId"], bk(1500.0 if lg["side"] == "CE" else 5.0), at(WED + timedelta(days=1), 15, 0))
    desk2.step(at(WED + timedelta(days=1), 15, 5, 1))
    assert not desk2.open_legs() and desk2.state["cycle"] is None
    assert any(lg.get("exitReason", "").startswith("Max loss") for lg in desk2.state["legs"].values())


def test_strangle_closes_on_its_expiry_day(make):
    exp = "2026-11-03"
    desk, paper, _ = make(at(TUE, 15, 14), [exp], minutes(TUE, [22700.0] * 21, 22700.0))
    desk.state["legs"]["x"] = {"id": "x", "rule": R.STRANGLE, "symbol": "NIFTY", "side": "PE", "securityId": 5,
                               "name": "NIFTY PE", "strike": 22000, "expiry": exp, "lotSize": 65, "qty": 65,
                               "entryDay": "2026-09-01", "entryTime": "10:00:01", "entryPrice": 300.0,
                               "entryCharges": 40.0, "stop": None, "status": "open"}
    desk.state["day"] = "2026-11-03"
    desk.on_tick(5, bk(1.0), paper.now)
    desk.step(paper.now)
    assert desk.state["legs"]["x"]["exitReason"] == "Expiry day 15:14"


def test_after_the_close_or_a_restart_the_page_shows_the_last_price(make, tmp_path):
    # owner 29-Oct-2026: open strangle legs showed "–" once the feed stopped
    exp = "2026-12-29"
    one_min = minutes(WED, [22700.0] * 21, 22700.0)
    cfg = {"sellStraddle": {"enabled": False}, "sellCalmCall": {"enabled": False}}
    desk, paper, _ev = make(at(WED, 10, 0, 1), ["2026-11-10", exp], one_min, cfg)
    ce, pe = sid("CE", exp, 23800), sid("PE", exp, 21600)
    desk.on_tick(ce, bk(200.0), paper.now)
    desk.on_tick(pe, bk(250.0), paper.now)
    desk.step(paper.now)
    desk.on_tick(ce, bk(180.0), at(WED, 15, 29, 50))
    desk.on_tick(pe, bk(240.0), at(WED, 15, 29, 50))
    live = {lg["side"]: lg for lg in desk.status()["open"]}
    assert live["CE"]["ltp"] == 180.0 and live["CE"]["priceAt"] is None  # live feed: no time shown
    desk._save()
    again = SellDesk(cfg, paper, FakeCandles(one_min), data_dir=os.path.dirname(os.path.dirname(os.path.dirname(desk.path))), start=False)
    shown = {lg["side"]: lg for lg in again.status()["open"]}
    assert shown["CE"]["ltp"] == 180.0 and shown["CE"]["priceAt"].startswith("2026-11-04T15:29")
    assert shown["CE"]["pnl"] == round((shown["CE"]["entryPrice"] - 180.0) * 65, 2)
    assert again.cycle_pnl() is None and again.status()["cycle"]["pnl"] is not None  # the Rs 60k check never uses old prices
