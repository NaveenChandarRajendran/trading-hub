"""Owner's 5-Nov-2026 changes: gap-day / fear-day pauses, Fear + Calendar futures book, weekly strangle, straddle VIX
skip, no new 2-month strangle, edit stop / target, manual "ride" exit, Clenow scores, Sensex watch-only. PAPER ONLY."""
import os
from datetime import date, datetime, timedelta

import pytest

import fear
import sell_rules as R
from sig_dharani_v2 import day_pauses, gap_pct
from sig_indicators import IST
from test_autopaper import CFG, FakeAccount, ManualPaper, make_manual
from test_sell_desk import FakeCandles, FakePaper, at, bk, sid


# ---------------------------------------------------------------- gap / fear pauses
def test_gap_day_blocks_entries_before_0945_in_the_gap_direction():
    st = {"dayOpen": 24250.0, "prevClose": 24000.0, "signalTime": "09:30"}  # +1.04 %
    assert round(gap_pct(st, "CE"), 2) == 1.04 and gap_pct(st, "PE") < 0
    assert day_pauses(st, "CE") == ["Gap up 1.0 %: no entry before 9:45"]
    assert day_pauses(st, "PE") == []                       # a gap up does not stop a put
    assert day_pauses({**st, "signalTime": "09:45"}, "CE") == []  # the 09:45 candle may enter
    assert day_pauses({**st, "dayOpen": 24200.0}, "CE") == []     # +0.83 %: a normal day
    assert day_pauses({"dayOpen": 23700.0, "prevClose": 24000.0, "signalTime": "09:18"}, "PE")[0].startswith("Gap down")
    assert day_pauses({"dayOpen": None, "prevClose": None, "signalTime": "09:18", "fear": True}, "CE") == \
        ["Fear day (VIX jump): no new buys"]


def test_a_paused_full_go_is_shadow_logged():
    from sig_service import skipped_setup
    r = {"rule": "dharaniV2", "go": False, "checks": [{"id": "supertrend", "state": "pass", "label": "ST"}],
         "blocked": ["Fear day (VIX jump): no new buys"], "pauses": ["Fear day (VIX jump): no new buys"], "score": 1, "total": 1}
    assert skipped_setup(r) == ("-", "Fear day (VIX jump): no new buys")


# ---------------------------------------------------------------- fear + calendar
def rows(vix, nifty, start=date(2026, 9, 1)):
    out, d = [], start
    for v, n in zip(vix, nifty):
        while d.weekday() >= 5:
            d += timedelta(days=1)
        out.append({"day": d.isoformat(), "vix": v, "nifty": n})
        d += timedelta(days=1)
    return out


def test_fear_held_replays_the_backtest():
    vix = [12.0] * 10 + [14.0, 14.0, 14.0, 14.0, 14.0, 14.0, 14.0]
    nifty = [100.0] * 10 + [95, 94, 93, 92, 91, 90, 89]   # keeps falling: out after 5 days
    held = fear.fear_held(rows(vix, nifty))
    assert held[:10] == [False] * 10
    assert held[10:16] == [True, True, True, True, True, False]  # day 10 enters, day 15 = 5 days later out
    nifty2 = [100.0] * 10 + [95, 99, 99, 99, 99, 99, 99]  # day 11 closes above its 5-day average: out
    assert fear.fear_held(rows(vix, nifty2))[10:12] == [True, False]


def test_fear_info_says_pause_today_from_earlier_closes():
    r = rows([12.0] * 10 + [14.0], [100.0] * 10 + [95])
    nxt = date.fromisoformat(r[-1]["day"]) + timedelta(days=1)
    info = fear.fear_info(r, nxt)
    assert info["on"] and info["since"] == r[-1]["day"] and info["days"] == 1
    assert not fear.fear_info(r, date.fromisoformat(r[-1]["day"]))["on"]  # the trigger day itself is not paused


def test_calendar_windows_november_2026():
    hol = {"2026-11-10", "2026-11-24", "2026-12-25"}
    nov = fear.trading_days(2026, 11, hol)
    assert nov[-4] == date(2026, 11, 25)                     # 4th-last trading day: entry at its close
    assert fear.tom_held(date(2026, 11, 25), hol) and not fear.tom_held(date(2026, 11, 23), hol)
    assert fear.tom_held(date(2026, 12, 1), hol) and fear.tom_held(date(2026, 12, 2), hol)
    assert not fear.tom_held(date(2026, 12, 3), hol)          # 3rd trading day: sold at its close
    assert fear.payday_held(date(2026, 11, 11), hol) and fear.payday_held(date(2026, 11, 13), hol)
    assert not fear.payday_held(date(2026, 11, 16), hol)
    assert not fear.payday_held(date(2026, 11, 9), hol)


def test_futures_charges():
    c = fear.futures_charges("SELL", 1_600_000)
    assert c.stt == 800.0 and c.brokerage == 20.0 and c.stamp == 0
    assert fear.futures_charges("BUY", 1_600_000).stamp == 32.0


class FutPaper:
    def __init__(self):
        self.px = {501: 24000.0, 502: 24100.0}
        self.watched = {}

        class I:
            @staticmethod
            def futures(symbol, today):
                return [f for f in [{"securityId": 501, "expiry": "2026-11-26", "lotSize": 65, "name": "NIFTY NOV FUT"},
                                    {"securityId": 502, "expiry": "2026-12-29", "lotSize": 65, "name": "NIFTY DEC FUT"}]
                        if f["expiry"] >= today]
        self.instruments = I()

    def watch(self, ids, group="auto"):
        self.watched[group] = ids

    def ltp(self, sid):
        return self.px.get(sid)


def test_futures_book_buys_on_the_month_turn_and_rolls_on_expiry(tmp_path):
    hist = fear.FearHistory(str(tmp_path))
    clock = [datetime(2026, 11, 20, 15, 21, 5, tzinfo=IST)]
    paper, events = FutPaper(), []
    book = fear.FuturesBook({}, paper, hist, get_vix=lambda: 13.0, get_nifty=lambda: 24000.0,
                            on_event=lambda t, e: events.append((t, e)), data_dir=str(tmp_path), clock=lambda: clock[0], start=False)
    book.step(clock[0])                          # 20 Nov: nothing on
    assert book.state["position"] is None and book.state["done"] == "2026-11-20"
    clock[0] = datetime(2026, 11, 23, 15, 21, 5, tzinfo=IST)  # 23 Nov: 5th-last trading day (24 Nov holiday)
    book.step(clock[0])
    assert book.state["position"] is None
    clock[0] = datetime(2026, 11, 25, 15, 21, 5, tzinfo=IST)  # 4th-last: buy
    book.step(clock[0])
    pos = book.state["position"]
    assert pos and pos["securityId"] == 501 and pos["qty"] == 65 and events[-1][1] == "entry"
    book.step(clock[0])                          # once a day
    assert len(events) == 1
    paper.px[501] = 24200.0
    s = book.status()
    assert s["open"]["pnl"] == 13000.0 and s["capital"] == 250000
    clock[0] = datetime(2026, 11, 26, 15, 21, 5, tzinfo=IST)  # the November future expires today: roll
    book.step(clock[0])
    assert book.state["closed"][-1]["exitReason"] == "Roll to next month" and book.state["position"]["securityId"] == 502
    paper.px[502] = 24100.0
    clock[0] = datetime(2026, 12, 3, 15, 21, 5, tzinfo=IST)   # 3rd trading day of December: sell
    book.step(clock[0])
    assert book.state["position"] is None and book.state["closed"][0]["grossPnl"] == 13000.0
    assert events[-1][1] == "exit Signals off" and book.state["closed"][-1]["netPnl"] < 13000.0


def test_futures_book_waits_without_prices(tmp_path):
    hist = fear.FearHistory(str(tmp_path))
    now = datetime(2026, 11, 25, 15, 21, 5, tzinfo=IST)
    book = fear.FuturesBook({}, FutPaper(), hist, get_vix=lambda: None, get_nifty=lambda: 24000.0, data_dir=str(tmp_path),
                            clock=lambda: now, start=False)
    book.step(now)
    assert book.state["done"] == "" and book.state["position"] is None


# ---------------------------------------------------------------- selling book
def test_weekly_entry_day_counts_trading_days():
    hol = {"2026-11-10"}
    assert R.weekly_entry_expiry(["2026-11-17"], date(2026, 11, 12), 3, hol) == "2026-11-17"  # Thu -> Fri, Mon, Tue
    assert R.weekly_entry_expiry(["2026-11-17"], date(2026, 11, 11), 3, hol) is None
    assert R.weekly_entry_expiry(["2026-11-09"], date(2026, 11, 4), 3, hol) == "2026-11-09"   # Wed -> Thu, Fri, Mon
    assert R.weekly_entry_expiry(["2026-11-12"], date(2026, 11, 12), 3, hol) is None          # expiry day itself
    assert R.weekly_strikes(24012.0) == (24200, 23800)


def make_desk(tmp_path, now, expiries, one_min, cfg, vix=None):
    paper = FakePaper(now, expiries)
    ev = []
    from sell_desk import SellDesk
    d = SellDesk(cfg, paper, FakeCandles(one_min), on_event=lambda t, e: ev.append((t, e)), data_dir=str(tmp_path),
                 start=False, vix=vix)
    return d, paper, ev


def mins(day, spot, upto=(9, 21)):
    out = []
    t = at(day, 9, 15)
    while (t.hour, t.minute) < upto:
        out.append({"time": int(t.timestamp()), "close": spot})
        t += timedelta(minutes=1)
    return out


def test_weekly_strangle_sells_2_lots_200_away_and_buys_back_a_doubled_leg(tmp_path):
    thu = datetime(2026, 11, 12, tzinfo=IST)
    exp = "2026-11-17"
    cfg = {"sellStrangle": {"enabled": False}, "sellCalmCall": {"enabled": False}, "sellStraddle": {"enabled": False},
           "sellStraddle940": {"enabled": False}, "sellStraddle1126": {"enabled": False}, "sellStraddle1224": {"enabled": False},
           "sellWeekly": {"enabled": True}}
    desk, paper, ev = make_desk(tmp_path, at(thu, 9, 20, 1), [exp], mins(thu, 24012.0), cfg)
    paper.holidays = {"2026-11-10"}
    desk.step(paper.now)
    ce, pe = sid("CE", exp, 24200), sid("PE", exp, 23800)
    assert set(paper.watched) == {ce, pe}
    desk.on_tick(ce, bk(60.5), paper.now)
    desk.on_tick(pe, bk(55.5), paper.now)
    desk.step(paper.now)
    legs = {lg["side"]: lg for lg in desk.open_legs(R.WEEKLY)}
    assert legs["CE"]["qty"] == 130 and legs["CE"]["stop"] == 120.5 and legs["PE"]["strike"] == 23800
    desk.on_tick(ce, bk(121.0), at(thu, 13, 0))   # doubled: that leg only
    assert not desk.open_legs(R.WEEKLY)[0]["side"] == "CE" and len(desk.open_legs(R.WEEKLY)) == 1
    desk.step(at(thu, 15, 14))                     # not expiry day: the put stays overnight
    assert len(desk.open_legs(R.WEEKLY)) == 1
    tue = datetime(2026, 11, 17, tzinfo=IST)
    paper.now = at(tue, 15, 14)
    desk.on_tick(pe, bk(5.0), paper.now)
    desk.step(paper.now)
    assert not desk.open_legs(R.WEEKLY)


def test_straddles_skip_when_vix_opens_below_12(tmp_path):
    tue = datetime(2026, 11, 3, tzinfo=IST)
    exp = "2026-11-03"
    desk, paper, ev = make_desk(tmp_path, at(tue, 9, 15, 2), [exp, "2026-11-10"], mins(tue, 22712.0),
                                {"minVixOpen": 12, "sellStrangle": {"enabled": False}, "sellCalmCall": {"enabled": False}},
                                vix=lambda: 11.6)
    desk.step(paper.now)
    desk.step(at(tue, 9, 20, 1))
    assert desk.state["notes"]["sellStraddle"].startswith("Skipped: India VIX opened at 11.60")
    assert not desk.open_legs()


def test_no_new_two_month_strangle(tmp_path):
    wed = datetime(2026, 11, 4, tzinfo=IST)
    desk, paper, ev = make_desk(tmp_path, at(wed, 10, 0, 1), ["2026-12-29"], mins(wed, 22700.0, (10, 1)),
                                {"sellStrangle": {"noNewCycle": True}, "sellCalmCall": {"enabled": False}})
    desk.step(paper.now)
    assert desk.state["notes"]["sellStrangle"].startswith("Ended") and not desk.open_legs()


def test_edit_stop_of_a_sold_leg(tmp_path):
    thu = datetime(2026, 11, 3, tzinfo=IST)
    exp = "2026-11-03"
    desk, paper, ev = make_desk(tmp_path, at(thu, 9, 20, 1), [exp, "2026-11-10"], mins(thu, 22712.0),
                                {"sellStrangle": {"enabled": False}, "sellCalmCall": {"enabled": False}})
    desk.step(paper.now)
    ce, pe = sid("CE", exp, 22700), sid("PE", exp, 22700)
    desk.on_tick(ce, bk(80.5), paper.now)
    desk.on_tick(pe, bk(70.5), paper.now)
    desk.step(paper.now)
    leg = desk.open_legs(R.STRADDLE)[0]
    assert desk.edit_stop(leg["id"], 101.02)["stop"] == 101.05
    with pytest.raises(ValueError):
        desk.edit_stop(leg["id"], 50)


# ---------------------------------------------------------------- edit stop / target, manual ride
def test_edit_moves_the_stop_order_and_changes_or_removes_the_target(tmp_path):
    t, man = make_manual(tmp_path)
    tr = t.bracket(7, stop_price=150, target_price=200)
    man.ltp_value = 170.0
    out = t.edit_trade(tr["id"], stop=160.02, target=210.01)
    assert (out["stop"], out["target"]) == (160.0, 210.05)
    assert ("CANCEL", "S1") in man.sent and man.sent[-1] == ("SL-M", 160.0)
    assert t.edit_trade(tr["id"], remove_target=True)["target"] is None
    from autopaper import AccountError
    with pytest.raises(AccountError, match="stop must be below"):
        t.edit_trade(tr["id"], stop=175)
    with pytest.raises(AccountError, match="target must be above"):
        t.edit_trade(tr["id"], target=165)


def test_manual_ride_has_no_target_and_exits_on_the_supertrend(tmp_path):
    t, man = make_manual(tmp_path)
    tr = t.bracket(7, stop_price=150, ride=True)
    assert tr["target"] is None and tr["ride"] and t.ride_symbols() == ["NIFTY"]
    st = {"idx": {"bar": {"close": 24000.0}, "ind": {"st_line": 24050.0}}}
    t.on_candle_v2("NIFTY", st)
    import time
    for _ in range(50):
        if t.state["trades"][0]["status"] == "closed":
            break
        time.sleep(0.05)
    assert t.state["trades"][0]["status"] == "closed" and t.state["trades"][0]["exitReason"] == "Signal"


# ---------------------------------------------------------------- Clenow
def test_clenow_regression_score_prefers_smooth_trends():
    import clenow
    smooth = [100 * 1.002 ** i for i in range(90)]
    noisy = [100 * 1.002 ** i * (1.03 if i % 2 else 0.97) for i in range(90)]
    a, b = clenow.regression_score(smooth), clenow.regression_score(noisy)
    assert a == pytest.approx(1.002 ** 250 - 1, rel=1e-6) and b < a
    assert clenow.target([("A.NS", 1), ("B.NS", 0.5)], regime=False) == []


def test_clenow_week_end_check_day():
    import clenow
    desk = clenow.ClenowDesk({}, data_dir="/tmp/clenow-test-unused", start=False, prices=object(), symbols=lambda: [])
    cal = ["2026-11-05", "2026-11-06", "2026-11-09"]
    assert desk._check_day("2026-11-06", cal, date(2026, 11, 9)) and not desk._check_day("2026-11-05", cal, date(2026, 11, 9))


# ---------------------------------------------------------------- Sensex watch only
class SxClient:
    def __init__(self):
        self.ce, self.pe, self.spot = 200.0, 190.0, 80020.0

    def _post(self, path, body, gap=None):
        if path.endswith("expirylist"):
            return {"data": ["2026-11-05", "2026-11-12"]}
        return {"data": {"last_price": self.spot, "oc": {"80000.000000": {"ce": {"last_price": self.ce}, "pe": {"last_price": self.pe}}}}}


def test_sensex_watch_records_straddles_without_orders(tmp_path):
    import sensex_watch as S
    c = SxClient()
    w = S.SensexWatch(c, {}, vix=lambda: 13.0, data_dir=str(tmp_path), log_dir=str(tmp_path), start=False)
    thu = datetime(2026, 11, 5, tzinfo=IST)
    w.step(at(thu, 9, 16))
    w.step(at(thu, 9, 20, 2))
    legs = w.status()["legs"]
    assert {(x["side"], x["stop"]) for x in legs} == {("CE", 300.0), ("PE", 285.0)}
    c.ce = 310.0
    w._last_check = 0
    w.step(at(thu, 9, 30))
    ce = next(x for x in w.state["legs"] if x["side"] == "CE")
    pe = next(x for x in w.state["legs"] if x["side"] == "PE" and x["entry"] == "09:20")
    assert ce["status"] == "closed" and pe["stop"] == 190.0  # the other leg's stop moved to cost
    w.step(at(thu, 15, 14))
    s = w.status()
    assert all(x["status"] == "closed" for x in s["legs"]) and s["history"][-1]["date"] == "2026-11-05"
    assert os.path.exists(os.path.join(str(tmp_path), "sensex_watch.csv"))
