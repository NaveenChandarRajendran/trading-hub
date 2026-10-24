"""
scripts/import_legacy.py - one-off import of everything written before Postgres became the only store:
  backend/data/{SYMBOL}_{expiry}_{date}.json   Trending OI sessions + minute snapshots  -> toi_session, toi_snapshot
  backend/data/sr_{SYMBOL}_{expiry}_{date}.json S/R level history                         -> sr_levels
  backend/data/chain_*.jsonl                    option-chain snapshots                      -> oc_snapshots
  backend/data/paper.json                       paper accounts, orders, fills, positions,   -> pt_* (accounts matched by
                                                order levels, algo events / state              name), algo_events, algo_state
  backend/logs/algo-YYYY-MM-DD.log              the algo's decision log (both line formats) -> algo_events, algo_candles,
                                                                                               algo_levels
then recomputes algo_daily_summary for every imported day. Running it again adds nothing: every insert skips rows
that already exist (primary keys, and algo_events.uid). Prints the rows added per table.

    cd backend
    python scripts/import_legacy.py                 # data/ and logs/ next to this folder; DATABASE_URL from .env.local
    python scripts/import_legacy.py --data-dir data --log-dir logs
"""
import argparse
import glob
import json
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

from algo_reports import recompute  # noqa: E402
from envfile import load_env_file  # noqa: E402
from store import IST, PaperPgStore, PgStore  # noqa: E402

TABLES = ("toi_session", "toi_snapshot", "sr_levels", "oc_snapshots", "pt_accounts", "pt_orders", "pt_trades",
          "pt_positions", "pt_order_levels", "algo_events", "algo_state", "algo_levels", "algo_candles",
          "algo_daily_summary")
EVENT_TYPE = {"armed": "signal", "cancel": "signal", "expire": "signal", "stale": "feed"}
LEGACY_VARIANT = "A"  # 23-Oct ran variant A only, before variants were logged


def counts(pg):
    out = {}
    with pg._cursor() as cur:
        for t in TABLES:
            cur.execute(f"SELECT count(*) FROM {t}")
            out[t] = cur.fetchone()[0]
    return out


# ------------------------------------------------------------------ the algo's log files
def parse_log_line(line, day):
    """One decision-log line, either format:
        23-Oct:  "HH:MM:SS SYMBOL KIND [setup] message | {json}"
        now:     "HH:MM:SS SYMBOL VARIANT KIND [setup] message | {json}"
    -> {ts, trade_date, index, variant, type, kind, setup, message, details} or None."""
    head, sep, js = line.rstrip("\n").partition(" | ")
    parts = head.split(None, 4)
    if len(parts) < 4 or len(parts[0]) != 8 or parts[0][2] != ":":
        return None
    t, sym = parts[0], parts[1]
    if len(parts) >= 5 and parts[2] in ("A", "B", "C", "D"):
        variant, kind, rest = parts[2], parts[3].lower(), parts[4]
    else:
        variant, kind, rest = LEGACY_VARIANT, parts[2].lower(), head.split(None, 3)[3]
    setup = ""
    if rest.startswith("[") and "] " in rest:
        setup, rest = rest[1:].split("] ", 1)
    try:
        details = json.loads(js) if sep else {}
    except ValueError:
        details = {}
    return {"ts": f"{day}T{t}+05:30", "trade_date": day, "index": sym, "variant": variant,
            "type": EVENT_TYPE.get(kind, kind), "kind": kind, "setup": setup, "message": rest, "details": details}


def parse_log_file(path, day):
    """All rows of one log file (oldest first); indented lines under a row are its traceback."""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("    ") and rows:
                rows[-1]["details"]["traceback"] = rows[-1]["details"].get("traceback", "") + line[4:]
                continue
            r = parse_log_line(line, day)
            if r:
                rows.append(r)
    return rows


def import_log(paper, path, day):
    events = candles = levels = 0
    for r in parse_log_file(path, day):
        if r["kind"] == "candle":
            c = r["details"].get("candle") or {}
            f = r["details"].get("filters") or {}
            toi, oic, comp = f.get("toi") or {}, f.get("oiChange") or {}, f.get("components") or {}
            if "time" in c:
                candles += paper.algo_save_candle({
                    "trade_date": day, "index": r["index"], "candle_start": datetime.fromtimestamp(c["time"], IST),
                    "open": c.get("open"), "high": c.get("high"), "low": c.get("low"), "close": c.get("close"),
                    "minutes": c.get("minutes"), "rsi": f.get("rsi"), "toi_strength": toi.get("strength"),
                    "toi_sentiment": toi.get("sentiment"), "oi_change": oic.get("verdict"),
                    "oi_change_points": oic.get("points"), "components": comp.get("verdict"),
                    "components_move": comp.get("indexMove")})
            continue
        if r["kind"] == "levels" and isinstance(r["details"].get("levels"), dict):
            levels += paper.algo_save_levels({
                "trade_date": day, "index": r["index"], "expiry": r["details"].get("expiry") or "",
                "locked_at": datetime.fromisoformat(r["ts"]), "levels": r["details"]["levels"],
                "spot": r["details"].get("chainSpot")})
        events += paper.algo_add_event(r)
    return events, candles, levels


# ------------------------------------------------------------------ JSON store files
def import_tracker_files(pg, data_dir):
    n = 0
    for p in sorted(glob.glob(os.path.join(data_dir, "*_*_*.json"))):
        name = os.path.basename(p)[:-5]
        parts = name.split("_")
        if len(parts) != 3 or name.startswith(("sr_", "chain_")) or not parts[0].isupper():
            continue
        sym, expiry, day = parts
        with open(p, encoding="utf-8") as f:
            j = json.load(f)
        snaps = j.get("snaps", [])
        pg.save(sym, expiry, day, j.get("strikes", []), snaps, snaps)
        n += 1
    return n


def import_sr_files(pg, data_dir):
    for p in sorted(glob.glob(os.path.join(data_dir, "sr_*_*_*.json"))):
        _, sym, expiry, day = os.path.basename(p)[:-5].split("_")
        with open(p, encoding="utf-8") as f:
            rows = json.load(f).get("rows", [])
        pg.sr_write(sym, expiry, day, [r for r in rows if r.get("valid_to")], rows)


def import_chain_files(pg, data_dir):
    for p in sorted(glob.glob(os.path.join(data_dir, "chain_*_*_*.jsonl"))):
        _, sym, expiry, day = os.path.basename(p)[:-6].split("_")
        with open(p, encoding="utf-8") as f:
            for line in f:
                try:
                    pg.save_chain_snapshot(sym, expiry, day, json.loads(line))
                except ValueError:
                    continue


def import_paper_json(paper, path):
    """paper.json -> pt_* (each JSON account mapped to the Postgres account of the same name, created if missing)."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    mapping = {}
    for a in d.get("accounts", []):
        name = a.get("name")
        acc = paper.active_account(name) or paper.create_account(a["capital"], datetime.fromisoformat(a["created_at"]),
                                                                  name=name)
        mapping[str(a["id"])] = acc["id"]
    for table, save in (("orders", paper.save_order), ("trades", paper.save_trade), ("positions", paper.save_position),
                        ("order_levels", paper.save_order_levels)):
        for json_acc, days in d.get(table, {}).items():
            for day, rows in days.items():
                for row in rows.values():
                    save(mapping[json_acc], day, row)
    for day, rows in d.get("algo_events", {}).items():  # JSON-store runs of the algo (old row shape)
        for ev in rows:
            kind = ev.get("kind") or ev.get("type")
            paper.algo_add_event({"ts": ev.get("at") or ev.get("ts"), "trade_date": day,
                                  "index": ev.get("symbol") or ev.get("index"), "variant": ev.get("variant") or LEGACY_VARIANT,
                                  "type": EVENT_TYPE.get(kind, kind), "kind": kind, "setup": ev.get("setup", ""),
                                  "message": ev["message"], "details": ev.get("data") or ev.get("details") or {}})
    for day, states in d.get("algo_state", {}).items():
        existing = paper.algo_states(day)
        for key, st in states.items():
            sym, _, var = key.partition("|")
            var = var or LEGACY_VARIANT
            if (sym, var) not in existing:
                paper.algo_save_state(day, sym, var, st)
    return mapping


def run(pg, paper, data_dir, log_dir, out=print):
    """Imports everything into pg / paper (PgStore, PaperPgStore). Returns {table: rows added}."""
    before = counts(pg)
    import_tracker_files(pg, data_dir)
    import_sr_files(pg, data_dir)
    import_chain_files(pg, data_dir)
    import_paper_json(paper, os.path.join(data_dir, "paper.json"))
    for p in sorted(glob.glob(os.path.join(log_dir, "algo-????-??-??.log"))):
        day = os.path.basename(p)[5:15]
        e, c, lv = import_log(paper, p, day)
        out(f"{os.path.basename(p)}: {e} new events, {c} new candles, {lv} new level rows")
    with pg._cursor() as cur:  # every day with algo data (states or events)
        cur.execute("SELECT min(d), max(d) FROM (SELECT trade_date d FROM algo_state UNION ALL "
                    "SELECT trade_date FROM algo_events) x")
        lo, hi = cur.fetchone()
    if lo:
        recompute(paper, lo.isoformat(), hi.isoformat())
    after = counts(pg)
    out("")
    out("Rows added per table (before -> after):")
    for t in TABLES:
        out(f"  {t:<20} +{after[t] - before[t]:<8} ({before[t]} -> {after[t]})")
    return {t: after[t] - before[t] for t in TABLES}


def main():
    ap = argparse.ArgumentParser(description="Import the JSON store and algo log files into Postgres (idempotent).")
    ap.add_argument("--data-dir", default=os.path.join(BACKEND, "data"))
    ap.add_argument("--log-dir", default=os.path.join(BACKEND, "logs"))
    a = ap.parse_args()
    load_env_file(os.path.join(BACKEND, ".env.local"))
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set: add it to backend/.env.local")
    pg = PgStore(dsn)
    try:
        return run(pg, PaperPgStore(pg), a.data_dir, a.log_dir)
    finally:
        pg.close()


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    main()
