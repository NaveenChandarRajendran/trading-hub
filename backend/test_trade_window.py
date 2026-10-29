"""Trade Window backend (on the Power Scalper routes): an order with SL / target in points attached as OCO on fill,
market protection %, cancel all, and the day MTM limit (mtm_limit.py: cancel + sell everything, no new buys that day,
kept across a restart, off again the next day, other strategies untouched). Same fakes as test_scalper.py."""
import pytest

from mtm_limit import breach, parse_limit
from paper_api import PaperService
from test_paper_api import CE, FakeInstruments, at, full
from test_scalper import MANUAL, env, order, tick  # noqa: F401 - env is the fixture


def buy(c, **more):
    return c.post("/api/scalper/orders", json={"securityId": CE, "side": "BUY", "lots": 1, **more})


# ---------- order with SL / target, market protection ----------
def test_sl_and_target_in_points_are_attached_on_fill(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30", ltp=100.0, bid=99.95, ask=100.05)
    r = buy(c, sl=20, target=40.02).json()
    assert r["order"]["status"] == "FILLED" and r["order"]["avg_price"] == 100.05
    assert r["attached"]["error"] == ""
    pos = r["attached"]["position"]
    assert (pos["stop"], pos["target"]) == (80.05, 140.05)  # 140.07 snapped to the 0.05 grid
    pos = c.get("/api/scalper/positions").json()["rows"][0]
    assert (pos["stop"], pos["target"]) == (80.05, 140.05)
    only_sl = buy(c, sl=10).json()  # an add: the stop moves for the whole quantity, the target stays
    assert (only_sl["attached"]["position"]["stop"], only_sl["attached"]["position"]["target"]) == (90.05, 140.05)
    assert buy(c).json()["attached"] is None
    assert buy(c, sl=0).status_code == 400 and buy(c, target=-5).status_code == 400


def test_market_protection_refuses_a_fill_too_far_from_ltp(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30", ltp=100.0, bid=99.0, ask=112.0)  # a wide spread: the ask is 12 % above LTP
    r = buy(c, protection=10)
    assert r.status_code == 409 and "Market protection 10%" in r.json()["detail"]
    assert c.get("/api/scalper/orders").json()["rows"] == []  # nothing placed
    assert buy(c, protection=15).json()["order"]["avg_price"] == 112.0


def test_cancel_all_cancels_targets_and_stops_and_keeps_the_position(env):
    c, paper, _, clock, *_ = env
    tick(paper, clock, "09:30")
    buy(c, sl=10, target=20)
    r = c.post("/api/scalper/cancel-all")
    assert r.status_code == 200
    assert {o["status"] for o in r.json()["orders"] if o["side"] == "SELL"} == {"CANCELLED"}
    pos = c.get("/api/scalper/positions").json()["rows"][0]
    assert (pos["open_qty"], pos["stop"], pos["target"]) == (65, None, None)


# ---------- day MTM limit ----------
def test_limit_rules():
    assert parse_limit(5000, None) == {"profit": 5000.0, "loss": None}
    with pytest.raises(ValueError):
        parse_limit(0, 100)
    assert breach(4999, {"profit": 5000, "loss": 2000}) is None
    assert breach(5000, {"profit": 5000, "loss": 2000}) == "profit"
    assert breach(-2000, {"profit": 5000, "loss": 2000}) == "loss"
    assert breach(-9999, {"profit": 5000, "loss": None}) is None and breach(1, None) is None


def test_loss_limit_sells_everything_and_blocks_buys_for_the_day(env):
    c, paper, _, clock, _, store = env
    r = c.put("/api/scalper/mtm-limit", json={"profit": 5000, "loss": 500})
    assert r.status_code == 200 and r.json()["mtm"] == {"profit": 5000.0, "loss": 500.0, "hit": None, "message": ""}
    assert c.put("/api/scalper/mtm-limit", json={"loss": -1}).status_code == 400
    tick(paper, clock, "09:30")
    buy(c, sl=50)
    tick(paper, clock, "09:31", ltp=95.0, bid=95.0, ask=95.05)  # -325 and charges: inside the limit
    paper.tick_timer(clock.now)
    assert c.get("/api/scalper/positions").json()["rows"][0]["open_qty"] == 65
    tick(paper, clock, "09:32", ltp=92.0, bid=92.0, ask=92.05)  # -520 and charges: beyond -500
    paper.tick_timer(clock.now)
    pos = c.get("/api/scalper/positions").json()["rows"][0]
    assert (pos["open_qty"], pos["stop"]) == (0, None)  # sold at market, the stop cancelled
    mtm = c.get("/api/scalper/account").json()["funds"]["mtm"]
    assert mtm["hit"]["kind"] == "loss" and mtm["hit"]["at"] == "09:32:00" and "new buys are off" in mtm["message"]
    r = buy(c)
    assert r.status_code == 409 and "Loss MTM limit reached at 09:32:00" in r.json()["detail"]
    c.put("/api/scalper/mtm-limit", json={"loss": 5000})  # a new limit doesn't reopen today
    assert buy(c).status_code == 409
    other = c.post(f"/api/scalper/orders?strategy={MANUAL}", json={"securityId": CE, "side": "BUY", "lots": 1})
    assert other.json()["order"]["status"] == "FILLED"  # another strategy is untouched
    restarted = PaperService(store, paper.feed, FakeInstruments(), clock=clock)  # after a restart: still blocked
    book = next(b for b in restarted.books.values() if b.strategy_id == 2)
    assert restarted.funds(book)["mtm"]["hit"]["kind"] == "loss"
    clock.now = at("09:30", "2026-10-22")  # the next day: buys are back, the limit stays set
    paper.on_packet(full(CE, 100.0, 99.95, 100.0))
    r = buy(c).json()
    assert r["order"]["status"] == "FILLED" and r["funds"]["mtm"]["hit"] is None and r["funds"]["mtm"]["loss"] == 5000.0


def test_profit_limit_books_the_profit(env):
    c, paper, _, clock, *_ = env
    c.put("/api/scalper/mtm-limit", json={"profit": 600})
    tick(paper, clock, "09:30")
    buy(c)
    tick(paper, clock, "09:35", ltp=111.0, bid=111.0, ask=111.05)  # +715 before charges
    paper.tick_timer(clock.now)
    f = c.get("/api/scalper/account").json()["funds"]
    assert f["mtm"]["hit"]["kind"] == "profit" and f["realized"] == pytest.approx(65 * 11)
    assert c.get("/api/scalper/positions").json()["rows"][0]["open_qty"] == 0
