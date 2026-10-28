"""Momentum 20 (momentum.py rules, momentum_book.py paper books) on made-up daily bars."""
import json
import math
from datetime import date, datetime, timedelta

import momentum as M
import momentum_book as MB
from store import IST


def days(n, end="2026-10-30"):
    out, d = [], date.fromisoformat(end)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out[::-1]


def series(cal, drift, wobble=0.01, start=100.0, volume=1000):
    """Steady trend with a small zig-zag (so volatility is not zero)."""
    out, p = [], start
    for i, d in enumerate(cal):
        p *= math.exp(drift + (wobble if i % 2 else -wobble))
        out.append({"d": d, "o": p, "c": p, "a": p, "v": volume})
    return out


CAL = days(320)


def test_rank_prefers_steady_risers_and_drops_weak_ones():
    prices = {"UP2.NS": series(CAL, 0.002), "UP1.NS": series(CAL, 0.001), "FLAT.NS": series(CAL, 0.0),
              "DOWN.NS": series(CAL, -0.001), "JUMPY.NS": series(CAL, 0.002, wobble=0.04)}
    ranked = M.rank(prices, CAL)
    names = [s for s, _ in ranked]
    assert names[:2] == ["UP2.NS", "UP1.NS"]
    assert "DOWN.NS" not in names  # below its own 200-day average
    assert names.index("JUMPY.NS") > names.index("UP2.NS")  # same rise, more jumpy = lower score


def test_rank_skips_cheap_thin_and_suspect_stocks():
    cheap = series(CAL, 0.002, start=5)
    bad = series(CAL, 0.002)
    for b in bad[200:]:
        b.update(c=b["c"] * 3, a=b["a"] * 3, o=b["o"] * 3)  # an unadjusted 3x jump: suspect data
    new = series(CAL[-100:], 0.003)
    names = [s for s, _ in M.rank({"OK.NS": series(CAL, 0.002), "CHEAP.NS": cheap, "BAD.NS": bad, "NEW.NS": new}, CAL)]
    assert names == ["OK.NS"]


def test_universe_is_the_most_traded(monkeypatch):
    monkeypatch.setattr(M, "UNIVERSE", 1)
    prices = {"BIG.NS": series(CAL, 0.001, volume=10_000), "SMALL.NS": series(CAL, 0.003, volume=10)}
    assert [s for s, _ in M.rank(prices, CAL)] == ["BIG.NS"]


def test_target_keeps_top40_and_switch_goes_to_cash():
    ranked = [(f"S{i}", 100 - i) for i in range(60)]
    held = ["S5", "S35", "S50"]
    tgt = M.target(ranked, held, use_switch=False, regime=False)
    assert tgt[:2] == ["S5", "S35"] and "S50" not in tgt and len(tgt) == 20
    assert M.target(ranked, held, use_switch=True, regime=False) == []
    assert M.target(ranked, held, use_switch=True, regime=True) == tgt


def test_regime():
    assert M.regime_ok([100.0] * 199 + [101.0])
    assert not M.regime_ok([100.0] * 199 + [99.0])


def test_parse_chart():
    ts = int(datetime(2026, 10, 29, 9, 15, tzinfo=IST).timestamp())
    js = {"chart": {"result": [{"timestamp": [ts, ts + 86400], "indicators": {
        "quote": [{"open": [10, 11], "close": [10.5, None], "volume": [5, 6]}], "adjclose": [{"adjclose": [10.4, None]}]}}]}}
    assert MB.parse_chart(js) == [{"d": "2026-10-29", "o": 10, "c": 10.5, "a": 10.4, "v": 5}]
    assert MB.parse_chart({"chart": {"result": None}}) == []


def test_equity_list_falls_back_to_shipped_copy(tmp_path):
    def fail(url):
        raise OSError("offline")
    syms = MB.equity_symbols(str(tmp_path / "EQUITY_L.csv"), get=fail)
    assert "RELIANCE.NS" in syms and len(syms) > 1500


class FakePrices:
    def __init__(self, data, now):
        self.data, self.now = data, now

    def bars(self, sym, start):
        e = self.now["t"].date().isoformat()
        return [b for b in self.data.get(sym, []) if start.isoformat() <= b["d"] <= e]

    def many(self, syms, start):
        return {s: b for s in syms if (b := self.bars(s, start))}


def make_desk(tmp_path, nifty_drift):
    cal = days(330, end="2026-11-06")
    data = {f"S{i:02d}.NS": series(cal, 0.0005 + 0.0001 * i) for i in range(25)}
    data["^NSEI"] = series(cal, nifty_drift, wobble=0.001)
    now = {"t": None}
    texts = []
    desk = MB.MomentumDesk({"start": "2026-10-28", "capital": 500000, "minStocks": 5}, on_text=texts.append,
                           data_dir=str(tmp_path), prices=FakePrices(data, now), clock=lambda: now["t"], start=False,
                           symbols=lambda: sorted(k for k in data if k.endswith(".NS")))
    return desk, now, texts, data


def at(d, hm):
    y, m, dd = map(int, d.split("-"))
    return datetime(y, m, dd, *hm, tzinfo=IST)


def test_month_end_signal_then_fill_at_next_open(tmp_path):
    desk, now, texts, data = make_desk(tmp_path, 0.001)
    now["t"] = at("2026-10-30", (12, 0))
    desk.step()
    assert desk.state["signals"] == {}  # month-end check waits for the close
    now["t"] = at("2026-10-30", (16, 0))
    desk.step()
    sig = desk.state["signals"]["2026-10-30"]
    assert sig["regimeOk"] and sig["ranked"][0][0] == "S24.NS"
    assert "BUY at next open" in texts[-1] and "S24" in texts[-1]
    now["t"] = at("2026-11-02", (10, 0))
    desk.step()  # fills at the 2 Nov open
    for b in desk.state["books"].values():
        assert len(b["holdings"]) == 20 and b["applied"] == "2026-10-30"
        assert 0 <= b["cash"] < 1
        assert abs(sum(h["money"] for h in b["holdings"].values()) - 500000) < 1
    assert texts[-1].startswith("✅ MOMENTUM 20")
    now["t"] = at("2026-11-06", (16, 0))
    desk.step()
    st = desk.status()
    assert st["lastDay"] == "2026-11-06"
    for b in st["books"]:
        assert b["value"] > 495000 and len(b["values"]) == 8  # 28 Oct - 6 Nov valued
    saved = json.load(open(tmp_path / "books" / "momentum" / "state.json", encoding="utf-8"))
    assert saved["lastDay"] == "2026-11-06"


def test_switch_book_stays_in_cash_when_nifty_is_weak(tmp_path):
    desk, now, texts, data = make_desk(tmp_path, -0.001)
    now["t"] = at("2026-11-02", (16, 0))
    desk.step()  # catch-up: 30 Oct signal and 2 Nov fill in one go
    books = desk.state["books"]
    assert books["momSwitch"]["holdings"] == {} and books["momSwitch"]["cash"] == 500000
    assert len(books["momAll"]["holdings"]) == 20
    assert "BELOW (switch OFF, cash)" in texts[0]


def test_sale_returns_growth_minus_charges(tmp_path):
    desk, now, texts, data = make_desk(tmp_path, 0.001)
    now["t"] = at("2026-11-02", (16, 0))
    desk.step()
    b = desk.state["books"]["momAll"]
    sym = next(iter(b["holdings"]))
    sig = {"date": "2026-11-02", "regimeOk": True, "ranked": []}  # nothing ranked: sell everything
    now["t"] = at("2026-11-03", (16, 0))
    bars = desk._bars_since(set(b["holdings"]), "2026-11-03")
    expect = 0.0
    for s, h in b["holdings"].items():
        g = desk._adj_open(desk._bar(bars, s, "2026-11-03")) / desk._adj_open(desk._bar(bars, s, "2026-11-02"))
        gross = h["spend"] / (1 + M.SLIP) * g * (1 - M.SLIP)
        expect += gross - M.sell_charges(gross)
    desk._apply("momAll", sig, "2026-11-03", bars)
    sell = next(t for t in b["trades"] if t["side"] == "SELL" and t["sym"] == sym)
    assert b["holdings"] == {} and sell["charges"] > 15.93
    assert abs(b["cash"] - expect) < 0.01
    assert b["cash"] < 500000 * 1.03 * (1 - 0.004)  # round trip costs about 0.4 % + Rs 16 per stock


def test_next_check_is_the_last_trading_day_of_the_month(tmp_path):
    desk, now, texts, data = make_desk(tmp_path, 0.001)
    now["t"] = at("2026-11-02", (10, 0))
    assert desk.next_check() == "2026-11-30"
