"""Backtest engine on synthetic data: candles, fills (stop / target / signal / time / gaps), costs, and a full run that
must not crash. The rules themselves are tested in test_sig_rules.py and test_dharani_v2.py."""
import math
from datetime import date, datetime

import backtest as bt
from sig_indicators import IST

DAY = date(2026, 10, 26)


def ts(hm, d=DAY):
    h, m = map(int, hm.split(":"))
    return int(datetime(d.year, d.month, d.day, h, m, tzinfo=IST).timestamp())


class Prices:
    """Fixed strike 25000; premium path given per minute (o, h, l, c)."""

    def __init__(self, path, strike=25000.0):
        self.path, self.strike = path, strike

    def at(self, day, side, minute_ts):
        v = self.path.get(minute_ts)
        return {self.strike: (*v, 0)} if v else {}


def flat(start, n, px):
    return {start + 60 * k: (px, px, px, px) for k in range(n)}


def test_bars_are_aligned_to_0915():
    m = {"t": [ts("09:15") + 60 * k for k in range(7)], "o": [1] * 7, "h": list(range(2, 9)), "l": [1] * 7, "c": list(range(10, 17)), "v": [0] * 7}
    b = bt.bars_from_minutes(m, 3)
    assert [x["time"] for x in b] == [ts("09:15"), ts("09:18"), ts("09:21")]
    assert b[0]["high"] == 4 and b[0]["close"] == 12 and b[0]["volume"] == 3  # no index volume: 1 per minute


def test_stop_target_time_and_gaps():
    book = bt.Book("NIFTY", Prices({}))
    e = ts("10:00")
    path = flat(e, 10, 100.0)
    path[e + 120] = (100, 101, 89, 95)  # low through the 90 stop
    book.prices = Prices(path)
    r = bt.run_trade(book, DAY, "CE", 25000.0, e, 100.0, 65, 0.10, 0.20, None, 0.0, ts("15:29"))
    assert r["reason"] == "Stop" and r["exit"] == 90.0 and r["gross"] == -650.0
    path = flat(e, 10, 100.0)
    path[e + 180] = (125, 126, 124, 125)  # opens above the 120 target
    book.prices = Prices(path)
    r = bt.run_trade(book, DAY, "CE", 25000.0, e, 100.0, 65, 0.10, 0.20, None, 0.0, ts("15:29"))
    assert r["reason"] == "Target (gap)" and r["exit"] == 125
    book.prices = Prices(flat(e, 400, 100.0))
    r = bt.run_trade(book, DAY, "CE", 25000.0, e, 100.0, 65, 0.10, 0.20, None, 0.0, ts("15:29"))
    assert r["reason"] == "Time" and r["exit_ts"] == ts("15:14")


def test_signal_exit_and_costs():
    e = ts("10:00")
    path = flat(e, 30, 100.0)
    path[e + 360] = (110, 110, 110, 110)
    book = bt.Book("NIFTY", Prices(path))
    r = bt.run_trade(book, DAY, "CE", 25000.0, e, 100.0, 65, 0.10, None, lambda t: "ST" if t == e + 360 else None, 0.005, ts("15:29"))
    assert r["reason"] == "ST" and r["exit"] == 110 and r["gross"] == 650.0
    assert r["slippage"] == round((100 * 65 + 110 * 65) * 0.005, 2) and r["charges"] > 40  # two Rs 20 orders + taxes
    assert r["net"] == round(650 - r["charges"] - r["slippage"], 2)


def test_full_run_on_a_synthetic_trend_does_not_crash():
    t, o, h, l, c = [], [], [], [], []
    for d in (date(2026, 10, 22), date(2026, 10, 23), DAY):
        for k in range(375):
            p = 25000 + 400 * math.sin(k / 40) + (k * 0.8 if d == DAY else 0)
            t.append(ts("09:15", d) + 60 * k); o.append(p); h.append(p + 3); l.append(p - 3); c.append(p + 1)
    m = {"t": t, "o": o, "h": h, "l": l, "c": c, "v": [0] * len(t)}

    class Any:
        def at(self, day, side, minute_ts):
            return {25000.0: (250.0, 255.0, 245.0, 250.0, 0)}
    book = bt.Book("NIFTY", Any())
    trades = bt.megabull_trades("NIFTY", m, {x: 13.0 for x in t}, book) + bt.dharani_trades("NIFTY", m, bt.Book("NIFTY", Any()))
    s = bt.summary(trades)
    assert all(v["trades"] >= 1 for v in s.values()) or not trades


def test_download_caches_and_option_prices_rebuild_a_fixed_strike(tmp_path, monkeypatch=None):
    import bt_data
    old = bt_data.ROOT
    bt_data.ROOT = str(tmp_path)
    try:
        class Client:
            def __init__(self):
                self.calls = []

            def _post(self, path, body, gap=0):
                self.calls.append((path, body))
                if path == "/charts/intraday":
                    return {"timestamp": [ts("09:15")], "open": [1], "high": [1], "low": [1], "close": [1], "volume": [0]}
                off = 0 if body["strike"] == "ATM" else int(body["strike"][3:])
                return {"data": {"ce" if body["drvOptionType"] == "CALL" else "pe": {
                    "timestamp": [ts("09:15"), ts("09:16")], "open": [100 - off, 99 - off], "high": [101, 100], "low": [99, 98],
                    "close": [100, 99], "strike": [25000 + 50 * off, 25050 + 50 * off]}}}
        c = Client()
        old_start = bt_data.START
        bt_data.START = date(2026, 9, 1)
        n, skipped = bt_data.download(c, date(2026, 10, 10), symbols=("NIFTY",))
        assert n == 2 + 3 * 22 and skipped == 0  # NIFTY + VIX index windows; 3 half-months x (11 call + 11 put offsets)
        n2, skipped2 = bt_data.download(c, date(2026, 10, 10), symbols=("NIFTY",))
        assert n2 == 2 + 22 and skipped2 == 2 * 22  # only the windows reaching today are fetched again
        p = bt_data.OptionPrices("NIFTY")
        rows = p.at(date(2026, 10, 1), "CE", ts("09:16"))  # the fake series carry DAY's timestamps
        assert rows[25050.0][4] == 0 and rows[25100.0][4] == 1  # the ATM series moved to 25,050; ATM+1 sits at 25,100
        bt_data.START = old_start
    finally:
        bt_data.ROOT = old
