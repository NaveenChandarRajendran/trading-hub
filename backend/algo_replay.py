"""
algo_replay.py - runs the OI breakout rules (algo_logic.py, any variant) on a past day. PAPER / SIMULATION ONLY.

Data sources (results and inputs live in Postgres; DATABASE_URL from backend/.env.local):
  dhan  Dhan historical candles: 1-minute index candles (5-minute candles = their 09:15-aligned groups, the same
        grouping as live; the previous session warms RSI up) and 1-minute candles of the option traded, so entries,
        exits and the premium stop use real premiums. Fills are booked in a paper account per variant named
        "Replay <variant>" (paper engine, never a real order). Needs a valid Dhan token.
  db    the 5-minute candles and RSI the live algo stored that day (algo_candles) and its locked levels
        (algo_levels). Index points only (no premiums, so no premium stop and no account).
OI filters (Trending OI, OI change, Index Components) are checked only when that day's option-chain snapshots and
Trending OI history exist; otherwise the run is labelled "OI not checked" (price + RSI only).

Usage:
    python algo_replay.py --date 2026-10-23 --variants A,B,C,D --source db
    python algo_replay.py --date 2026-10-23 --variants A,B,C,D --source dhan
    python algo_replay.py --date 2026-10-27 --source db --rules before-27oct,live,stop50,range-toi20
    python algo_replay.py --date 2026-10-27 --export-scenario   (fixtures/scenarios/<date>.json, test_algo_scenarios.py)
Levels: the day's algo_levels rows, or --levels "NIFTY:R1=22800,R2=23000,...;BANKNIFTY:...".
Report: logs/replay-<date>.md and .json.
"""
import argparse
import json
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta

import algo_config as cfg
from algo_filters import rsi as rsi_series
from algo_logic import fmt, lock_levels, new_state, note_result, on_candle, on_tick, round_trip_charges
from candles import aggregate
from store import IST

LEVEL_SLOTS = ("R1", "R2", "R3", "S1", "S2", "S3")

# Rule sets for comparisons (algo_config names -> values); "live" = algo_config as it is. Replay only, never live.
RULE_SETS = {
    "before-27oct": {"RANGE_BLOCK_BROKEN": False, "RANGE_TRADES_PER_LEVEL": None},  # before the broken-level rule
    "live": {},
    "stop50": {"STOP_BUFFER": {**cfg.STOP_BUFFER, "BANKNIFTY": 50}},  # BANKNIFTY spot stop 50 points beyond the level
    "range-toi20": {"RANGE_TOI_WITH_MIN": 20.0},  # range needs Trending OI >= 20 % in its direction
    "arm-on-stop": {"ARM_ON_STOP_CANDLE": True},  # proposal: a break on the stop-out candle still arms its setup
}


@contextmanager
def rule_set(*names):
    """Runs the block with the named RULE_SETS applied to algo_config (later names win), then restores it."""
    over = {k: v for n in names for k, v in RULE_SETS[n].items()}
    old = {k: getattr(cfg, k) for k in over}
    for k, v in over.items():
        setattr(cfg, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(cfg, k, v)


def at(day, hhmm):
    return datetime.fromisoformat(f"{day}T{hhmm}:00").replace(tzinfo=IST)


def ist(epoch_s):
    return datetime.fromtimestamp(epoch_s, IST)


# ------------------------------------------------------------------ inputs
def levels_from_db(store, day):
    """{symbol: {slot: strike}} from the day's algo_levels rows."""
    return {ix: {k: float(v) for k, v in row["levels"].items()} for ix, row in store.algo_levels(day).items()}


def parse_levels(text):
    """'NIFTY:R1=22800,S1=22700;BANKNIFTY:R1=54800' -> {symbol: {slot: strike}}."""
    out = {}
    for part in filter(None, (p.strip() for p in text.split(";"))):
        sym, _, rest = part.partition(":")
        out[sym.strip().upper()] = {k.strip().upper(): float(v) for k, v in (x.split("=") for x in rest.split(","))}
    return out


def candles_from_db(store, day, symbol):
    """The live algo's 5-minute candles of one index with its RSI (algo_candles): [{time, open, high, low, close, rsi}]."""
    out = []
    for r in store.algo_candles(day, symbol):
        start = datetime.fromisoformat(r["candle_start"])
        out.append({"time": int(start.timestamp()), "open": r["open"], "high": r["high"], "low": r["low"],
                    "close": r["close"], "rsi": r["rsi"]})
    return sorted(out, key=lambda c: c["time"])


def candles_from_minutes(minutes, day):
    """1-minute candles (previous session + the day) -> the day's 5-minute candles with RSI(14) over both sessions."""
    five = aggregate(sorted(minutes, key=lambda c: c["time"]), cfg.CANDLE_MIN)
    values = rsi_series([c["close"] for c in five], cfg.RSI_PERIOD)
    return [{**c, "rsi": r} for c, r in zip(five, values) if ist(c["time"]).date().isoformat() == day]


def oi_filters_from_store(store, symbol, day, expiry=None):
    """Filter values at a candle end from the day's saved option-chain snapshots and Trending OI history, or None
    when the day has no snapshots (then the replay is "OI not checked"). Index Components: no history, not checked."""
    from algo_filters import oi_change_verdict
    from calc import build_rows, select_for_interval
    from chain_snapshots import to_oc
    exps = [expiry] if expiry else store.chain_snapshot_expiries(symbol, day)
    if not exps:
        return None
    exp = exps[0]
    snaps = store.chain_snapshots(symbol, exp, day)
    if not snaps:
        return None
    _strikes, toi_snaps = store.load(symbol, exp, day)

    def at_end(end):
        ts = end.strftime("%Y-%m-%d %H:%M")
        past = [s for s in snaps if s["ts"] <= ts]
        f = {"componentsChecked": False, "toi": None, "oiChange": None, "expiry": exp}
        if past:
            s = past[-1]
            f["oiChange"] = oi_change_verdict(symbol, s["spot"], to_oc(s))
        rows = build_rows(select_for_interval([x for x in toi_snaps if x["ts"] <= ts], cfg.TOI_INTERVAL)[0])
        if rows and rows[-1]["ts"] >= (end - timedelta(minutes=cfg.TOI_MAX_AGE_MIN)).strftime("%Y-%m-%d %H:%M"):
            f["toi"] = {"sentiment": rows[-1]["sentiment"], "strength": rows[-1]["strengthPct"], "ts": rows[-1]["ts"]}
        return f
    return at_end


def export_scenario(store, day):
    """A day as the live algo saw it: locked levels and every 5-minute candle with the RSI and filter values it was
    evaluated with (algo_levels, algo_candles). Saved as fixtures/scenarios/<day>.json for test_algo_scenarios.py."""
    out = {"day": day, "indices": {}}
    for sym, lv in levels_from_db(store, day).items():
        rows = []
        for r in store.algo_candles(day, sym):
            rows.append({"start": datetime.fromisoformat(r["candle_start"]).strftime("%H:%M"),
                         **{k: r[k] for k in ("open", "high", "low", "close", "rsi", "toi_sentiment", "toi_strength",
                                              "oi_change", "oi_change_points", "components", "components_move")}})
        out["indices"][sym] = {"levels": lv, "candles": rows}
    return out


def scenario_inputs(scn, symbol):
    """(5-minute candles, levels, filters_at) of one index of an exported scenario; the filter values are the ones the
    live algo logged for each candle."""
    day, ix = scn["day"], scn["indices"][symbol]
    five, by_end = [], {}
    for r in ix["candles"]:
        start = at(day, r["start"])
        five.append({"time": int(start.timestamp()), **{k: r[k] for k in ("open", "high", "low", "close", "rsi")}})
        by_end[start + timedelta(minutes=cfg.CANDLE_MIN)] = r

    def filters_at(end):
        r = by_end.get(end) or {}
        return {"toi": {"sentiment": r["toi_sentiment"], "strength": r["toi_strength"]} if r.get("toi_sentiment") else None,
                "oiChange": {"verdict": r["oi_change"], "points": r["oi_change_points"]} if r.get("oi_change") else None,
                "components": {"verdict": r["components"], "indexMove": r["components_move"] or 0.0, "priced": 1,
                               "total": 1} if r.get("components") else None}
    return five, ix["levels"], filters_at


# ------------------------------------------------------------------ simulation
def fill_at_target(o, c):
    """Spot at which a target exit fills inside candle c: the target, or the open when the candle opened already
    through it (then the first tick is beyond the target)."""
    t = o["target"]
    return min(t, c["open"]) if o["side"] == "PE" else max(t, c["open"])


def replay_index(symbol, day, five, levels, variant, minutes=None, option=None, filters_at=None, after_candle=None):
    """Runs one index through one variant. five: the day's 5-minute candles with "rsi"; minutes: the day's 1-minute
    index candles (targets checked minute by minute; without them, on the 5-minute candles); option(side, spot, t):
    -> {"name", "candles": {minute epoch: candle}} for premiums, or None (index points only); after_candle(state, end):
    called after each evaluated candle (tests check invariants with it).
    Returns {"symbol", "variant", "events": [...], "trades": [...], "points"}."""
    st = new_state(symbol, day)
    events = [{"at": "09:30", "kind": "levels", "message": e["message"]} for e in lock_levels(st, levels, at(day, "09:30"))]
    trades = []
    by_min = sorted(minutes or [], key=lambda c: c["time"])

    def close_trade(t_end, spot, reason, price=None):
        o = st["open"]
        side = o["side"]
        pts = round((spot - o["entrySpot"]) * (1 if side == "CE" else -1), 2) + 0.0  # no "-0.00"
        tr = {"setup": o["setup"], "side": side, "entryAt": o["entryAt"], "entrySpot": o["entrySpot"],
              "target": o.get("target"), "stop": o["stop"], "reason": o["reason"], "exitAt": t_end.strftime("%H:%M"),
              "exitSpot": spot, "exitReason": reason, "points": pts, "option": o.get("option"),
              "entryPrice": o.get("entryPrice"), "exitPrice": price,
              "premiumPnl": round((price - o["entryPrice"]) * o["qty"], 2) if price is not None and o.get("entryPrice")
              else None, "qty": o.get("qty")}
        charges = (round_trip_charges(o["entryPrice"], price, o["qty"]) if tr["premiumPnl"] is not None else None)
        # stop-after-win: by premium P&L after charges, or by index points when there is no option price
        note_result(st, tr["premiumPnl"] if tr["premiumPnl"] is not None else pts, charges)
        trades.append(tr)
        events.append({"at": tr["exitAt"], "kind": "exit", "message": f"EXIT {o['setup']} {side} at spot {fmt(spot)}: "
                                                                       f"{reason} ({pts:+.2f} pts)"})
        st["open"] = None

    def premium_at(o, t):
        """Option close of the minute holding t (or the last before it)."""
        if not o.get("optCandles"):
            return None
        keys = [k for k in o["optCandles"] if k <= t]
        return o["optCandles"][max(keys)]["close"] if keys else None

    def watch_between(t0, t1):
        """Targets and the premium stop inside (t0, t1], minute by minute (or on the whole candle without minutes)."""
        o = st["open"]
        if not o:
            return
        steps = [m for m in by_min if t0 <= m["time"] < t1] if by_min else []
        if not steps:
            return
        for m in steps:
            if not st["open"]:
                return
            o = st["open"]
            end = ist(m["time"]) + timedelta(minutes=1)
            spot = m["high"] if o["side"] == "CE" else m["low"]
            low_prem = high_prem = None
            if o.get("optCandles") and m["time"] in o["optCandles"]:
                low_prem = o["optCandles"][m["time"]]["low"]
                high_prem = o["optCandles"][m["time"]]["high"]
            act = on_tick(st, spot, low_prem, high_prem)
            if act:
                if act["reason"].startswith("Premium target"):
                    target_px = round(o["entryPrice"] * (1 + cfg.PREMIUM_TARGET_PCT / 100), 2)
                    close_trade(end, m["close"], act["reason"], target_px)
                elif act["reason"].startswith("Target"):
                    close_trade(end, fill_at_target(o, m), act["reason"], premium_at(o, m["time"]))
                else:
                    stop_px = round(o["entryPrice"] * (1 - cfg.PREMIUM_STOP_PCT / 100), 2)
                    close_trade(end, m["close"], act["reason"], stop_px)

    prev_end = None
    for c in five:
        start, end = ist(c["time"]), ist(c["time"]) + timedelta(minutes=cfg.CANDLE_MIN)
        if prev_end is not None and by_min:
            watch_between(c["time"], c["time"] + cfg.CANDLE_MIN * 60)  # ticks inside this candle, before its close
        elif st["open"] and not by_min:  # 5-minute data only: the target on this candle's high / low
            o = st["open"]
            act = on_tick(st, c["high"] if o["side"] == "CE" else c["low"], None)
            if act:
                close_trade(end, fill_at_target(o, c), act["reason"] + " (5-minute candle high/low)")
        prev_end = end
        if start.time() < cfg.LEVELS_AT or end.time() > cfg.SESSION_TO:
            continue
        if st["open"] and end.time() >= cfg.SQUARE_OFF:
            close_trade(end, c["close"], f"Square-off {cfg.SQUARE_OFF:%H:%M}",
                        premium_at(st["open"], c["time"] + cfg.CANDLE_MIN * 60 - 60))
            continue
        filters = ({**filters_at(end), "rsi": c.get("rsi")} if filters_at else
                   {"oiChecked": False, "toi": None, "oiChange": None, "components": None, "rsi": c.get("rsi")})
        for a in on_candle(st, c, end, filters, "", variant):
            t = end.strftime("%H:%M")
            if a["type"] == "event":
                events.append({"at": t, "kind": a["kind"], "message": a["message"]})
            elif a["type"] == "exit":
                o = st["open"]
                close_trade(end, c["close"], a["reason"], premium_at(o, c["time"] + cfg.CANDLE_MIN * 60 - 60))
            elif a["type"] == "enter":
                o = st["open"]
                o.update(exiting=False)
                if option:
                    opt = option(a["side"], c["close"], c["time"] + cfg.CANDLE_MIN * 60)
                    if opt and opt.get("candles"):
                        first = min((k for k in opt["candles"] if k >= c["time"] + cfg.CANDLE_MIN * 60), default=None)
                        if first is not None:
                            o.update(option=opt["name"], optCandles=opt["candles"], qty=opt.get("qty"),
                                     entryPrice=opt["candles"][first]["open"])
                events.append({"at": t, "kind": "entry", "message": f"ENTRY {a['setup']} {a['side']} at spot "
                                                                     f"{fmt(c['close'])}"
                                                                     f"{' · ' + o['option'] + ' @ ' + fmt(o['entryPrice']) if o.get('entryPrice') else ''}"
                                                                     f" · target {fmt(o['target'])}. {a['reason']}"})
                o.pop("exiting", None)
        if after_candle:
            after_candle(st, end)
    if st["open"]:  # data ended before 15:15
        last = five[-1]
        close_trade(ist(last["time"]) + timedelta(minutes=cfg.CANDLE_MIN), last["close"], "End of data")
    for tr in trades:
        tr.pop("optCandles", None)
    return {"symbol": symbol, "variant": variant, "oiChecked": filters_at is not None, "events": events, "trades": trades,
            "points": round(sum(t["points"] for t in trades), 2),
            "premiumPnl": round(sum(t["premiumPnl"] for t in trades if t["premiumPnl"] is not None), 2)
            if any(t["premiumPnl"] is not None for t in trades) else None}


# ------------------------------------------------------------------ report
def report(day, results, source):
    checked = sorted({r["symbol"] for r in results if r.get("oiChecked")})
    oi = ("price + RSI only - **OI not checked** (no OI history for this day)" if not checked else
          f"Trending OI + OI change from the saved snapshots for {', '.join(checked)} (Index Components not checked)")
    lines = [f"# Algo replay {day}", "", f"Source: {source}. Filters: {oi}."
             f" Rules: docs/strategies/oi-breakout.md; numbers: algo_config.py.", ""]
    variants = sorted({r["variant"] for r in results})
    lines += ["| Variant | Index | Signals (armed) | Skips | Entries | Exits | Points |", "|---|---|---|---|---|---|---|"]
    for v in variants:
        for r in [x for x in results if x["variant"] == v]:
            k = [e["kind"] for e in r["events"]]
            lines.append(f"| {v} | {r['symbol']} | {k.count('armed')} | {k.count('skip')} | {k.count('entry')} | "
                         f"{k.count('exit')} | {r['points']:+.2f} |")
    for v in variants:
        lines += ["", f"## Variant {v}"]
        for r in [x for x in results if x["variant"] == v]:
            lines += ["", f"### {r['symbol']}: {len(r['trades'])} trade(s), {r['points']:+.2f} pts"
                      + (f", premium P&L {r['premiumPnl']:+,.2f}" if r.get("premiumPnl") is not None else "")]
            for t in r["trades"]:
                label = t["setup"] if t["side"] in t["setup"] else f"{t['setup']} {t['side']}"
                lines.append(f"- **{label}** entry {t['entryAt']} spot {fmt(t['entrySpot'])}"
                             f"{' · ' + t['option'] + ' @ ' + fmt(t['entryPrice']) if t.get('entryPrice') else ''}"
                             f" → exit {t['exitAt']} spot {fmt(t['exitSpot'])}"
                             f"{' @ ' + fmt(t['exitPrice']) if t.get('exitPrice') is not None else ''}"
                             f" · **{t['points']:+.2f} pts** · {t['exitReason']}")
            sig = [e for e in r["events"] if e["kind"] in ("armed", "skip", "cancel", "expire")]
            if sig:
                lines.append("")
                lines += [f"  - {e['at']} {e['kind']}: {e['message']}" for e in sig]
    return "\n".join(lines) + "\n"


def book_replay_account(store, variant, day, trades, instruments, capital=cfg.CAPITAL):
    """Books a variant's replayed trades with premiums in its own paper account "Replay <variant>" (paper engine)."""
    from paper_engine import BUY, MARKET, Book, PaperEngine
    name = f"Replay {variant}"
    acc = store.active_account(name) or store.create_account(capital, at(day, "09:00"), name=name)
    engine = PaperEngine(capital, day=at(day, "09:00").date())
    for t in trades:
        if t.get("entryPrice") is None or t.get("exitPrice") is None or not t.get("securityId"):
            continue
        sid, lot = t["securityId"], t["lotSize"]
        e_at, x_at = at(day, t["entryAt"]), at(day, t["exitAt"])
        engine.on_tick(sid, Book(t["entryPrice"], [(t["entryPrice"], 10 ** 6)], [(t["entryPrice"], 10 ** 6)]), e_at)
        o, evs = engine.place_order(sid, BUY, cfg.LOTS, lot, MARKET, e_at)
        events = evs
        engine.on_tick(sid, Book(t["exitPrice"], [(t["exitPrice"], 10 ** 6)], [(t["exitPrice"], 10 ** 6)]), x_at)
        events += engine.exit_position(sid, x_at) if x_at.time() < cfg.SQUARE_OFF else engine.square_off(x_at)
        for ev in events:
            data = dict(ev.data)
            if ev.kind == "order":
                data.update(source="replay", setup=f"{variant}: {t['setup']}")
            {"order": store.save_order, "trade": store.save_trade, "position": store.save_position}[ev.kind](acc["id"], day, data)
    return acc


# ------------------------------------------------------------------ CLI
def main():
    ap = argparse.ArgumentParser(description="Replay the OI breakout algo on a past day (simulation only).")
    ap.add_argument("--date", required=True)
    ap.add_argument("--variants", default="A,B,C,D")
    ap.add_argument("--source", choices=("db", "dhan"), default="dhan")
    ap.add_argument("--levels", default="", help='"NIFTY:R1=22800,...;BANKNIFTY:..." (default: the day\'s algo_levels)')
    ap.add_argument("--log-dir", default=cfg.LOG_DIR)
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--rules", default="", help=f"db source: compare rule sets ({', '.join(RULE_SETS)})")
    ap.add_argument("--export-scenario", action="store_true", help="write fixtures/scenarios/<date>.json and stop")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    except (AttributeError, ValueError):
        pass
    pg, paper = _stores()
    if a.export_scenario:
        path = os.path.join("fixtures", "scenarios", f"{a.date}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(export_scenario(paper, a.date), f, indent=1)
        print(f"Written: {path}")
        return
    levels = parse_levels(a.levels) if a.levels else levels_from_db(paper, a.date)
    if not levels:
        raise SystemExit("No levels: pass --levels or replay a day that has algo_levels rows.")
    variants = [v.strip().upper() for v in a.variants.split(",") if v.strip()]
    results, books = [], {}
    if a.source == "db":
        for name in [r.strip() for r in a.rules.split(",") if r.strip()] or ["live"]:
            with rule_set(name):
                for sym, lv in levels.items():
                    five = candles_from_db(paper, a.date, sym)
                    fa = oi_filters_from_store(pg, sym, a.date)
                    for v in variants:
                        r = replay_index(sym, a.date, five, lv, v, filters_at=fa)
                        results.append({**r, "variant": f"{v} {name}" if a.rules else v})
        source = "the live algo's stored 5-minute candles and RSI (algo_candles); index points only"
    else:
        results, books = _replay_dhan(a, levels, variants, pg, paper)
        source = "Dhan historical 1-minute candles (index + the option traded), grouped into 5-minute candles"
    text = report(a.date, results, source)
    os.makedirs(a.log_dir, exist_ok=True)
    base = os.path.join(a.log_dir, f"replay-{a.date}")
    with open(base + ".md", "w", encoding="utf-8") as f:
        f.write(text)
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump({"date": a.date, "source": a.source, "levels": levels, "results": results,
                   "accounts": books}, f, indent=1, default=str)
    print(text)
    print(f"Written: {base}.md and {base}.json")


def _stores():
    """(PgStore, PaperPgStore): Postgres only (DATABASE_URL from backend/.env.local)."""
    from envfile import load_env_file
    from store import PaperPgStore, PgStore
    load_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.local"))
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set: add it to backend/.env.local")
    pg = PgStore(dsn)
    return pg, PaperPgStore(pg)


def _replay_dhan(a, levels, variants, pg, store):
    from candles import parse_intraday, recent_sessions
    from dhan_client import DhanClient
    from instruments import OptionInstruments
    client = DhanClient()
    instruments = OptionInstruments(os.path.join(a.data_dir, "option_instruments.json"))
    day = datetime.fromisoformat(a.date).date()
    sessions = recent_sessions(day)
    results, books = [], {}
    for sym, lv in levels.items():
        frm, to = f"{sessions[0]} 09:15:00", f"{day + timedelta(days=1)} 09:15:00"
        minutes = parse_intraday(client.intraday(sym, frm, to, interval=1))
        five = candles_from_minutes(minutes, a.date)
        day_min = [m for m in minutes if ist(m["time"]).date() == day]
        exps = [e for e in instruments.expiries(sym, a.date) if e >= a.date]
        exp = exps[1] if exps and exps[0] == a.date and len(exps) > 1 else (exps[0] if exps else None)
        rows = instruments.chain(sym, exp) if exp else []
        cache = {}

        def option(side, spot, t, rows=rows, sym=sym):
            if not rows:
                return None
            r = min(rows, key=lambda x: abs(x["strike"] - spot))
            leg = r.get(side.lower())
            if not leg:
                return None
            sid = leg["securityId"]
            if sid not in cache:
                p = parse_intraday(client.intraday(sym, f"{a.date} 09:15:00", f"{day + timedelta(days=1)} 09:15:00",
                                                   interval=1, option_id=sid))
                cache[sid] = {c["time"]: c for c in p}
            return {"name": leg.get("name", str(sid)), "candles": cache[sid], "qty": cfg.LOTS * leg["lotSize"],
                    "securityId": sid, "lotSize": leg["lotSize"]}

        fa = oi_filters_from_store(pg, sym, a.date)
        for v in variants:
            res = replay_index(sym, a.date, five, lv, v, minutes=day_min, option=option, filters_at=fa)
            for t in res["trades"]:
                opt = next((o for o in (option(t["side"], t["entrySpot"], 0),) if o), None)
                if opt:
                    t.update(securityId=opt["securityId"], lotSize=opt["lotSize"])
            results.append(res)
    for v in variants:
        trades = [t for r in results if r["variant"] == v for t in r["trades"]]
        acc = book_replay_account(store, v, a.date, trades, instruments)
        books[v] = acc["id"]
    return results, books


if __name__ == "__main__":
    main()
