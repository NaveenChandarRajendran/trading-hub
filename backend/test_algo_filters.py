"""The algo's Python ports must give the same numbers as the frontend functions they copy.
fixtures/algo_golden.json was written by those TypeScript functions (analyzeOptionChain on the 21-Oct Dhan chains,
buildRows + summarize + selectPrevClose on the real constituent lists, indicators.ts rsi on the StockCharts closes)."""
import json
import os
from datetime import datetime

import pytest

from algo_filters import components_verdict, load_constituents, oi_change_verdict, rsi
from store import IST

HERE = os.path.dirname(__file__)
GOLDEN = json.load(open(os.path.join(HERE, "fixtures", "algo_golden.json"), encoding="utf-8"))
FIX = os.path.join(HERE, "..", "frontend", "src", "shared", "dhan", "__fixtures__")


def chain(symbol):
    body = json.load(open(os.path.join(FIX, f"{symbol.lower()}-2026-10-21.json"), encoding="utf-8"))
    return body["meta"], {str(r["strike"]): {"ce": r["ce"], "pe": r["pe"]} for r in body["rows"]}


@pytest.mark.parametrize("g", GOLDEN["oi"], ids=lambda g: g["symbol"])
def test_oi_change_verdict_matches_typescript(g):
    meta, oc = chain(g["symbol"])
    v = oi_change_verdict(g["symbol"], meta["spot"], oc, meta["lotSize"])
    assert v["verdict"] == g["verdict"]
    assert v["average"] == pytest.approx(g["average"], abs=1e-6) and v["points"] == pytest.approx(g["points"], abs=1e-6)


def test_oi_change_verdict_ignores_lot_size_and_key_type():
    meta, oc = chain("NIFTY")
    a = oi_change_verdict("NIFTY", meta["spot"], oc, meta["lotSize"])
    b = oi_change_verdict("NIFTY", meta["spot"], {float(k): v for k, v in oc.items()}, 1)
    assert a["average"] == pytest.approx(b["average"], abs=1e-9)


@pytest.mark.parametrize("g", GOLDEN["comps"], ids=lambda g: g["symbol"])
def test_components_verdict_matches_typescript(g):
    now = datetime(2026, 10, 23, 10, 0, tzinfo=IST)
    v = components_verdict(load_constituents()[g["symbol"]], g["quotes"], g["history"], now)
    assert v["indexMove"] == pytest.approx(g["indexMove"], abs=1e-9) and v["priced"] == g["priced"]
    band = 0.05
    assert v["verdict"] == ("Bullish" if g["indexMove"] > band else "Bearish" if g["indexMove"] < -band else "Neutral")


def test_components_no_verdict_while_a_previous_close_is_missing():
    g = GOLDEN["comps"][0]
    history = dict(g["history"])
    history.pop(next(iter(history)))
    v = components_verdict(load_constituents()["NIFTY"], g["quotes"], history, datetime(2026, 10, 23, 10, 0, tzinfo=IST))
    assert v["verdict"] is None and v["priced"] == g["priced"] - 1


def test_rsi_matches_typescript_and_the_hand_worked_values():
    r = rsi(GOLDEN["rsi"]["closes"])
    assert r[:14] == [None] * 14
    assert r[14:] == pytest.approx(GOLDEN["rsi"]["values"][14:], abs=1e-9)
    assert round(r[14], 2) == 70.46 and round(r[15], 2) == 66.25
