"""ORB Algo rules (orb_logic.py, docs/strategies/orb.md) on synthetic NIFTY 1-minute candles."""
from datetime import datetime

import orb_config as cfg
import orb_logic as L
from store import IST

DAY = "2026-11-13"
S = cfg.merged()
CTX = {"live": True, "stale": False, "dayPnl": 0.0, "capital": cfg.CAPITAL}


def t(hm):
    h, m = map(int, hm.split(":"))
    return int(datetime.fromisoformat(f"{DAY}T{h:02d}:{m:02d}:00").replace(tzinfo=IST).timestamp())


def cd(hm, close, high=None, low=None, open_=None):
    return {"time": t(hm), "open": close if open_ is None else open_, "high": max(close, high or close),
            "low": min(close, low or close), "close": close}


def hm(i):
    m = 9 * 60 + 15 + i
    return f"{m // 60:02d}:{m % 60:02d}"


def morning(or30=(24040, 23960), or60=(24050, 23900)):
    """09:15-10:14 flat at 24,000 with: 5m OR 23,990-24,010 (the 09:15 candle), the 30m OR from the 09:30 candle, the
    60m OR from the 10:00 candle. Sizes of the open 24,000: 5m 0.083%, 30m 0.333%, 60m 0.625% by default."""
    out = []
    for i in range(60):
        h = hm(i)
        if h == "09:15":
            out.append(cd(h, 24000, 24010, 23990))
        elif h == "09:30":
            out.append(cd(h, 24000, *or30))
        elif h == "10:00":
            out.append(cd(h, 24000, *or60))
        else:
            out.append(cd(h, 24000))
    return out


def run(candles, s=S, ctx=CTX, state=None):
    state = state or L.new_state(DAY)
    outs = []
    for c in candles:
        for o in L.on_minute(state, c, s, ctx):
            outs.append(o)
            if o["type"] == "action" and o["do"] == "enter":
                L.on_filled(state, o["setup"], 24000.0, 1, 100.0)
    return state, outs


def actions(outs, do=None):
    return [o for o in outs if o["type"] == "action" and (do is None or o["do"] == do)]


def test_opening_ranges_5_30_60_and_size_pct():
    st, outs = run(morning())
    ors = st["ors"]
    assert (ors["5"]["high"], ors["5"]["low"], ors["5"]["sizePct"]) == (24010, 23990, 0.083)
    assert (ors["30"]["high"], ors["30"]["low"], ors["30"]["sizePct"]) == (24040, 23960, 0.333)
    assert (ors["60"]["high"], ors["60"]["low"], ors["60"]["sizePct"]) == (24050, 23900, 0.625)
    assert all(o["done"] for o in ors.values()) and st["dayOpen"] == 24000
    # the 5m OR locks with the 09:19 candle, not before
    st5, _ = run(morning()[:4])
    assert not st5["ors"]["5"]["done"]
    st5, _ = run(morning()[:5])
    assert st5["ors"]["5"]["done"] and not st5["ors"]["30"]["done"]
    assert [o["message"] for o in outs if o.get("kind") == "or"][0].startswith("5m OR locked: high 24,010, low 23,990")


def test_or_size_filter_both_ways():
    st, _ = run(morning())  # 60m 0.625% > 0.5 passes; 30m 0.333% <= 0.5 passes
    assert st["setups"]["b60"]["status"] == "armed" and st["setups"]["r30"]["status"] == "armed"
    st, _ = run(morning(or60=(24060, 23940)))  # 60m exactly 0.5% (not more): out
    assert st["ors"]["60"]["sizePct"] == 0.5
    assert st["setups"]["b60"]["status"] == "filtered" and "0.50% <= 0.5%" in st["setups"]["b60"]["reason"]
    assert st["setups"]["r30"]["status"] == "armed"
    st, _ = run(morning(or30=(24100, 23950)))  # 30m 0.625%: out (the 60m OR contains it: 0.625%, passes)
    assert st["setups"]["r30"]["status"] == "filtered" and "0.62% > 0.5%" in st["setups"]["r30"]["reason"]
    assert st["setups"]["b60"]["status"] == "armed" and st["setups"]["v5"]["status"] == "armed"  # v5: no size filter


def test_60m_breakout_long_close_based_stop_one_trade():
    st, outs = run(morning() + [cd("10:20", 24060), cd("10:30", 23950, low=23890), cd("10:40", 23890)])
    e = actions(outs, "enter")[0]
    assert (e["setup"], e["side"], e["dir"], e["stop"], e["spot"]) == ("b60", "CE", "long", 23900, 24060)
    # 10:30 wicked below 23,900 but closed above: no stop; 10:40 closed below: stop
    ex = [a for a in actions(outs, "exit") if a["setup"] == "b60"]
    assert len(ex) == 1 and ex[0]["spot"] == 23890 and "10:40 candle closed 23,890 below 23,900" in ex[0]["reason"]
    now = datetime.fromtimestamp(t("10:41"), IST)
    L.on_exited(st, "b60", 23890, 80.0, -1300.0, 40.0, now, ex[0]["reason"])
    tr = st["closed"][0]
    assert (tr["entrySpot"], tr["exitSpot"], tr["points"], tr["setup"]) == (24060, 23890, -170.0, "b60")
    # a later breakout: the setup already traded today
    _, outs2 = run([cd("11:00", 24080)], state=st)
    assert not [a for a in actions(outs2, "enter") if a["setup"] == "b60"]


def test_60m_breakout_short_and_the_1200_limit():
    _, outs = run(morning() + [cd("10:20", 23890)])
    e = [a for a in actions(outs, "enter") if a["setup"] == "b60"][0]
    assert (e["side"], e["dir"], e["stop"]) == ("PE", "short", 24050)
    flat = [cd(hm(i), 24000) for i in range(60, 165)]  # 10:15-11:59
    _, outs = run(morning() + flat[:-1] + [cd("11:59", 24060)])
    assert [a for a in actions(outs, "enter") if a["setup"] == "b60"]  # starts 11:59: before 12:00
    st, outs = run(morning() + flat + [cd("12:00", 24060)])
    assert not [a for a in actions(outs, "enter") if a["setup"] == "b60"]
    assert st["setups"]["b60"]["status"] == "done" and st["setups"]["b60"]["reason"] == "no breakout before 12:00"


def test_30m_retest_same_side_within_60_minutes():
    # 24,045: above the 30m high 24,040, under the 60m high 24,050 (no 60m breakout)
    st, outs = run(morning() + [cd("10:20", 24045), cd("10:25", 24030), cd("10:40", 24045)])
    e = [a for a in actions(outs, "enter") if a["setup"] == "r30"]
    assert len(e) == 1 and (e[0]["side"], e[0]["stop"], e[0]["spot"]) == ("CE", 23960, 24045)
    assert "20 min after the 10:20 breakout" in st["setups"]["r30"]["reason"]
    # the other side after coming back inside is not a retest
    _, outs = run(morning() + [cd("10:20", 24045), cd("10:25", 24030), cd("10:30", 23950)])
    assert not [a for a in actions(outs, "enter") if a["setup"] == "r30"]
    # no retest without a close back inside first
    _, outs = run(morning() + [cd("10:20", 24045), cd("10:21", 24046)])
    assert not [a for a in actions(outs, "enter") if a["setup"] == "r30"]


def test_30m_retest_60_minute_window():
    base = morning() + [cd("10:20", 24045), cd("10:25", 24030)]
    _, outs = run(base + [cd("11:20", 24045)])  # exactly 60 min: allowed
    assert [a for a in actions(outs, "enter") if a["setup"] == "r30"]
    st, outs = run(base + [cd("11:21", 24045)])  # 61 min: too late
    assert not [a for a in actions(outs, "enter") if a["setup"] == "r30"]
    assert st["setups"]["r30"]["status"] == "done" and "no retest within 60 min of the 10:20 breakout" in st["setups"]["r30"]["reason"]


def test_5m_reversal_enters_the_other_way_with_the_first_side_as_stop():
    c = morning()
    c[10] = cd("09:25", 24020)   # first breakout above the 5m high 24,010
    c[11] = cd("09:26", 24000)   # back inside
    c[12] = cd("09:27", 23980)   # beyond the other side -> short
    st, outs = run(c[:13])
    e = [a for a in actions(outs, "enter") if a["setup"] == "v5"]
    assert len(e) == 1 and (e[0]["side"], e[0]["dir"], e[0]["stop"]) == ("PE", "short", 24010)
    _, outs = run([cd("09:28", 24005), cd("09:29", 24015)], state=st)  # stop: a close above 24,010
    assert [a for a in actions(outs, "exit") if a["setup"] == "v5"][0]["spot"] == 24015


def test_5m_reversal_before_1200():
    c = [cd(hm(i), 24000, *((24010, 23990) if i == 0 else ())) for i in range(165)]  # flat to 11:59
    c[100] = cd(hm(100), 24020)  # 10:55 first breakout
    c[101] = cd(hm(101), 24000)  # back inside
    st, outs = run(c + [cd("12:00", 23980)])
    assert not [a for a in actions(outs, "enter") if a["setup"] == "v5"]
    assert st["setups"]["v5"]["reason"] == "no reversal before 12:00"


def test_setup_switch_day_loss_kill_switch_and_catch_up():
    off = {**S, "b60On": False}
    st, outs = run(morning() + [cd("10:20", 24060)], s=off)
    assert st["setups"]["b60"]["status"] == "off" and not [a for a in actions(outs, "enter") if a["setup"] == "b60"]
    st, outs = run(morning() + [cd("10:20", 24060)], ctx={**CTX, "dayPnl": -10000.0})
    assert not actions(outs, "enter") and "day loss" in st["setups"]["b60"]["reason"]
    st, outs = run(morning() + [cd("10:20", 24060)], ctx={**CTX, "dayPnl": -9999.0})
    assert actions(outs, "enter")
    st0 = L.new_state(DAY)
    st0["halted"] = True
    st, outs = run(morning() + [cd("10:20", 24060)], state=st0)
    assert not actions(outs, "enter") and "kill switch" in st["setups"]["b60"]["reason"]
    st, outs = run(morning() + [cd("10:20", 24060)], ctx={**CTX, "live": False})
    assert not actions(outs, "enter") and st["setups"]["b60"]["reason"].endswith("(caught up from history, not traded)")
    assert st["setups"]["b60"]["status"] == "done"


def test_a_candle_is_never_evaluated_twice():
    st, _ = run(morning() + [cd("10:20", 24060)])
    _, outs = run([cd("10:20", 24060)], state=st)
    assert outs == []


def test_1525_exit_and_spot_points_in_a_replay():
    day = morning() + [cd("10:20", 24060)] + [cd(hm(i), 24100) for i in range(66, 370)]  # to 15:24
    trades = L.replay_day(day + [cd("15:25", 24300), cd("15:26", 24300)], S)
    b60 = [x for x in trades if x["setup"] == "b60"][0]
    assert (b60["exitAt"], b60["exitSpot"], b60["points"], b60["exitReason"]) == ("15:25", 24100, 40.0, "15:25 exit")
    assert L.points({"dir": "short", "entrySpot": 24000}, 23950) == 50.0


def test_square_off_exits_every_open_trade():
    st, _ = run(morning() + [cd("10:20", 24060)])
    outs = L.square_off(st, 24100, datetime.fromtimestamp(t("15:25"), IST), S)
    assert [(a["setup"], a["reason"], a["spot"]) for a in actions(outs)] == [("b60", "15:25 exit", 24100)]  # r30 / v5 only armed


def test_replay_summary_per_setup():
    import orb_replay as R
    day = morning() + [cd("10:20", 24060)] + [cd(hm(i), 24100) for i in range(66, 370)]
    days = R.by_day(day)
    trades = R.replay(days)
    res = R.summarize(trades)
    assert res["b60"] == {"trades": 1, "wins": 1, "losses": 0, "points": 40.0, "winRate": 100.0, "perTrade": 40.0}
    assert res["v5"]["trades"] == 0 and res["v5"]["winRate"] is None
    text, _ = R.report(days, trades)
    assert "| 60m Breakout | 1 | 100.0% | +40.00 | +40.00 | 648 | +7,021 | +10.83 |" in text and "Shorter than" in text
