"""
store.py - where the per-minute snapshots live.

PgStore   : Postgres, the single source of truth (main.py refuses to start without DATABASE_URL).
JsonStore : a file-backed test double with the same methods. Never used by main.py (no JSON fallback).

Both expose the same four methods used by tracker.py:
    load(symbol, expiry, date)  -> (strikes, snaps)      date = 'YYYY-MM-DD' (IST trading day)
    save(symbol, expiry, date, strikes, new_snaps, all_snaps)
    active_keys(date)           -> [(symbol, expiry), ...] tracked on that day
and the S/R level history (sr_levels.py): sr_rows / sr_write / sr_settings / save_sr_settings.
A snapshot is a dict: ts ('YYYY-MM-DD HH:MM' IST), spot, strikes_used, call_chg, put_chg,
call_ltp, put_ltp, call_ltp_chg, put_ltp_chg.
"""
import glob
import json
import logging
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
log = logging.getLogger("store")

SNAP_FIELDS = ("spot", "strikes_used", "call_chg", "put_chg", "call_ltp", "put_ltp", "call_ltp_chg", "put_ltp_chg")
LEVEL_SLOTS = ("R1", "R2", "R3", "S1", "S2", "S3")
CANDLE_COLS = ("candle_start", "open", "high", "low", "close", "minutes", "rsi", "toi_strength", "toi_sentiment",
               "oi_change", "oi_change_points", "components", "components_move")
SUMMARY_COLS = ("is_live", "signals", "entries", "wins", "losses", "points", "gross_pnl", "charges", "net_pnl")
SCALPER_SUMMARY_COLS = ("trades", "wins", "losses", "fills", "realized", "charges", "net", "best_trade", "worst_trade")
STRATEGY_EDITABLE = ("name", "description", "notes", "archived_at")
DAILY_SUMMARY_KEYS = ("strategy_id", "account_id", "trade_date", *SCALPER_SUMMARY_COLS)
PLAN_EDITABLE = ("name", "yearly_pct", "method", "initial_capital", "start_month", "years", "archived_at")
OPEN_ORDER_STATES = ("PENDING", "TRIGGERED")


class DuplicateName(ValueError):
    """A user already has a strategy with this name (names are unique per user, ignoring case; archived ones count)."""
OC_LEG = ("oi", "prev_oi", "ltp", "prev_close", "volume", "iv")
OC_COLS = ("strike", "spot") + tuple(f"ce_{k}" for k in OC_LEG) + tuple(f"pe_{k}" for k in OC_LEG)


def event_uid(ev):
    """Dedupe key of a decision-log row: ts (IST, seconds) | index | variant | type | setup | message.
    The same formula as the migration in schema.sql, so imported and live rows never duplicate."""
    import hashlib
    ts = ev["ts"]
    if isinstance(ts, str):
        ts = datetime.fromisoformat(ts)
    key = "|".join([ts.astimezone(IST).strftime("%Y-%m-%dT%H:%M:%S"), ev["index"], ev["variant"], ev["type"],
                    ev.get("setup") or "", ev["message"]])
    return hashlib.md5(key.encode("utf-8")).hexdigest()


def _event_row(r):
    details = r[7] or {}
    return {"ts": r[0].astimezone(IST).isoformat(), "trade_date": r[1].isoformat(), "index": r[2], "variant": r[3],
            "type": r[4], "kind": details.get("kind", r[4]), "setup": r[5], "message": r[6], "details": details}


class JsonStore:
    kind = "json"

    def __init__(self, data_dir="data"):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, symbol, expiry, date):
        return os.path.join(self.data_dir, f"{symbol}_{expiry}_{date}.json")

    def load(self, symbol, expiry, date):
        path = self._path(symbol, expiry, date)
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    j = json.load(f)
                return [float(k) for k in j.get("strikes", [])], j.get("snaps", [])
            except (OSError, ValueError):
                log.warning("could not read %s, starting fresh", path)
        return [], []

    def save(self, symbol, expiry, date, strikes, new_snaps, all_snaps):
        path = self._path(symbol, expiry, date)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"symbol": symbol, "expiry": expiry, "date": date, "strikes": strikes, "snaps": all_snaps}, f)
        os.replace(tmp, path)

    def active_keys(self, date):
        keys = []
        for p in glob.glob(os.path.join(self.data_dir, f"*_{date}.json")):
            parts = os.path.basename(p)[:-5].split("_")
            if len(parts) == 3:
                keys.append((parts[0], parts[1]))
        return keys

    # ---------------------------------------------------- S/R level history (sr_levels.py)
    # ---- option-chain snapshots (chain_snapshots.py): one JSON line per minute, appended
    def _chain_path(self, symbol, expiry, date):
        return os.path.join(self.data_dir, f"chain_{symbol}_{expiry}_{date}.jsonl")

    def save_chain_snapshot(self, symbol, expiry, date, snap):
        with open(self._chain_path(symbol, expiry, date), "a", encoding="utf-8") as f:
            f.write(json.dumps(snap, separators=(",", ":")) + "\n")

    def chain_snapshots(self, symbol, expiry, date):
        path = self._chain_path(symbol, expiry, date)
        if not os.path.exists(path):
            return []
        out = {}
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    s = json.loads(line)
                except ValueError:  # a line cut short by a crash
                    continue
                out[s["ts"]] = s  # the same minute twice: the later write wins
        return [out[k] for k in sorted(out)]

    def chain_snapshot_expiries(self, symbol, date):
        names = glob.glob(os.path.join(self.data_dir, f"chain_{symbol}_*_{date}.jsonl"))
        return sorted(os.path.basename(p)[len(f"chain_{symbol}_"):-len(f"_{date}.jsonl")] for p in names)

    def _sr_path(self, symbol, expiry, date):
        return os.path.join(self.data_dir, f"sr_{symbol}_{expiry}_{date}.json")

    def sr_rows(self, symbol, expiry, date):
        """The day's level rows, oldest first: {slot, strike, oi, valid_from, valid_to, reason}."""
        try:
            with open(self._sr_path(symbol, expiry, date), encoding="utf-8") as f:
                return json.load(f).get("rows", [])
        except (OSError, ValueError):
            return []

    def sr_write(self, symbol, expiry, date, closed, opened):
        """Closes rows (matched by slot + valid_from) and appends new ones."""
        rows = self.sr_rows(symbol, expiry, date)
        ends = {(r["slot"], r["valid_from"]): r["valid_to"] for r in closed}
        for r in rows:
            if (r["slot"], r["valid_from"]) in ends and r.get("valid_to") is None:
                r["valid_to"] = ends[(r["slot"], r["valid_from"])]
        rows += opened
        path = self._sr_path(symbol, expiry, date)
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump({"symbol": symbol, "expiry": expiry, "date": date, "rows": rows}, f)
        os.replace(path + ".tmp", path)

    # ---- Dashboard "Fix zones" (test double of PgStore's: one JSON file)
    def _fixed_path(self):
        return os.path.join(self.data_dir, "dashboard_fixed_levels.json")

    def _fixed_rows(self):
        try:
            with open(self._fixed_path(), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def fixed_levels(self, index, expiry):
        """The active fixed set {fixedAt, levels} for index + expiry, or None."""
        row = next((r for r in self._fixed_rows() if r["index"] == index and r["expiry"] == expiry and r["active"]), None)
        return {"fixedAt": row["fixedAt"], "levels": row["levels"]} if row else None

    def fix_levels(self, index, expiry, levels, at):
        rows = self._fixed_rows()
        for r in rows:
            if r["index"] == index and r["expiry"] == expiry and r["active"]:
                r.update(active=False, unfixedAt=at.isoformat())
        rows.append({"index": index, "expiry": expiry, "fixedAt": at.isoformat(),
                     "levels": {k: v for k, v in levels.items() if v is not None}, "active": True, "unfixedAt": None})
        with open(self._fixed_path(), "w", encoding="utf-8") as f:
            json.dump(rows, f)
        return self.fixed_levels(index, expiry)

    def unfix_levels(self, index, expiry, at):
        rows = self._fixed_rows()
        for r in rows:
            if r["index"] == index and r["expiry"] == expiry and r["active"]:
                r.update(active=False, unfixedAt=at.isoformat())
        with open(self._fixed_path(), "w", encoding="utf-8") as f:
            json.dump(rows, f)

    def sr_settings(self):
        try:
            with open(os.path.join(self.data_dir, "sr_settings.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_sr_settings(self, settings):
        with open(os.path.join(self.data_dir, "sr_settings.json"), "w", encoding="utf-8") as f:
            json.dump(settings, f)


class PgStore:
    kind = "postgres"

    def __init__(self, dsn, minconn=1, maxconn=4):
        import psycopg2.pool  # imported here so the JSON-only setup does not need psycopg2

        self._pool = psycopg2.pool.ThreadedConnectionPool(minconn, maxconn, dsn)
        self.init_schema()

    @contextmanager
    def _cursor(self):
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                yield cur
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            self._pool.putconn(conn)  # a broken connection is discarded by the pool

    def init_schema(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "schema.sql"), encoding="utf-8") as f:
            ddl = f.read()
        with self._cursor() as cur:
            cur.execute(ddl)

    def close(self):
        if not self._pool.closed:
            self._pool.closeall()

    # ------------------------------------------------------------------ read
    def load(self, symbol, expiry, date):
        start = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=IST)
        end = start + timedelta(days=1)
        with self._cursor() as cur:
            cur.execute("SELECT strikes FROM toi_session WHERE symbol=%s AND expiry=%s AND trade_date=%s",
                        (symbol, expiry, date))
            row = cur.fetchone()
            strikes = [float(k) for k in row[0]] if row else []
            cur.execute(
                "SELECT ts, spot, strikes_used, call_chg, put_chg, call_ltp, put_ltp, call_ltp_chg, put_ltp_chg "
                "FROM toi_snapshot WHERE symbol=%s AND expiry=%s AND ts >= %s AND ts < %s ORDER BY ts",
                (symbol, expiry, start, end))
            snaps = []
            for r in cur.fetchall():
                snap = {"ts": r[0].astimezone(IST).strftime("%Y-%m-%d %H:%M")}
                snap.update(dict(zip(SNAP_FIELDS, r[1:])))
                snaps.append(snap)
        return strikes, snaps

    # ----------------------------------------------------------------- write
    def save(self, symbol, expiry, date, strikes, new_snaps, all_snaps):
        with self._cursor() as cur:
            # The strike set is fixed for the day: the first writer wins, later writes never change it.
            cur.execute(
                "INSERT INTO toi_session (symbol, expiry, trade_date, strikes) VALUES (%s,%s,%s,%s) "
                "ON CONFLICT (symbol, expiry, trade_date) DO NOTHING",
                (symbol, expiry, date, [float(k) for k in strikes]))
            for s in new_snaps:
                ts = datetime.strptime(s["ts"], "%Y-%m-%d %H:%M").replace(tzinfo=IST)
                cur.execute(
                    "INSERT INTO toi_snapshot (symbol, expiry, ts, spot, strikes_used, call_chg, put_chg, call_ltp, "
                    "put_ltp, call_ltp_chg, put_ltp_chg) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (symbol, expiry, ts) DO UPDATE SET spot=EXCLUDED.spot, strikes_used=EXCLUDED.strikes_used, "
                    "call_chg=EXCLUDED.call_chg, put_chg=EXCLUDED.put_chg, call_ltp=EXCLUDED.call_ltp, "
                    "put_ltp=EXCLUDED.put_ltp, call_ltp_chg=EXCLUDED.call_ltp_chg, put_ltp_chg=EXCLUDED.put_ltp_chg",
                    (symbol, expiry, ts, *[s[f] for f in SNAP_FIELDS]))

    def active_keys(self, date):
        with self._cursor() as cur:
            cur.execute("SELECT symbol, expiry FROM toi_session WHERE trade_date=%s", (date,))
            return [(r[0], r[1]) for r in cur.fetchall()]

    # ---------------------------------------------------- S/R level history (sr_levels.py)
    def save_chain_snapshot(self, symbol, expiry, date, snap):
        """One snapshot (chain_snapshots.make_snapshot) -> one oc_snapshots row per strike."""
        from psycopg2.extras import execute_values
        ts = datetime.strptime(snap["ts"], "%Y-%m-%d %H:%M").replace(tzinfo=IST)
        rows = [(date, ts, symbol, expiry, r[0], snap["spot"], *r[1:]) for r in snap["rows"]]
        if not rows:
            return
        with self._cursor() as cur:
            execute_values(cur, f'INSERT INTO oc_snapshots (trade_date, ts, "index", expiry, {", ".join(OC_COLS)}) '
                                "VALUES %s ON CONFLICT (\"index\", expiry, ts, strike) DO NOTHING", rows)

    def chain_snapshots(self, symbol, expiry, date):
        """The day's snapshots rebuilt as chain_snapshots.make_snapshot dicts, oldest first."""
        from chain_snapshots import COLUMNS
        with self._cursor() as cur:
            cur.execute(f'SELECT ts, {", ".join(OC_COLS)} FROM oc_snapshots WHERE "index"=%s AND expiry=%s '
                        "AND trade_date=%s ORDER BY ts, strike", (symbol, expiry, date))
            out = {}
            for r in cur.fetchall():
                ts = r[0].astimezone(IST).strftime("%Y-%m-%d %H:%M")
                snap = out.setdefault(ts, {"ts": ts, "spot": r[2], "columns": COLUMNS, "rows": []})
                snap["rows"].append([r[1], *r[3:]])
            return [out[k] for k in sorted(out)]

    def chain_snapshot_expiries(self, symbol, date):
        with self._cursor() as cur:
            cur.execute('SELECT DISTINCT expiry FROM oc_snapshots WHERE "index"=%s AND trade_date=%s ORDER BY 1',
                        (symbol, date))
            return [r[0] for r in cur.fetchall()]

    def sr_rows(self, symbol, expiry, date):
        with self._cursor() as cur:
            cur.execute("SELECT slot, strike, oi, valid_from, valid_to, reason FROM sr_levels "
                        "WHERE symbol=%s AND expiry=%s AND trade_date=%s ORDER BY valid_from, slot", (symbol, expiry, date))
            fmt = lambda t: t.astimezone(IST).strftime("%Y-%m-%d %H:%M") if t else None  # noqa: E731
            return [{"slot": r[0], "strike": r[1], "oi": r[2], "valid_from": fmt(r[3]), "valid_to": fmt(r[4]),
                     "reason": r[5]} for r in cur.fetchall()]

    def sr_write(self, symbol, expiry, date, closed, opened):
        ts = lambda s: datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=IST)  # noqa: E731
        with self._cursor() as cur:
            for r in closed:
                cur.execute("UPDATE sr_levels SET valid_to=%s WHERE symbol=%s AND expiry=%s AND slot=%s AND valid_from=%s "
                            "AND valid_to IS NULL", (ts(r["valid_to"]), symbol, expiry, r["slot"], ts(r["valid_from"])))
            for r in opened:
                cur.execute("INSERT INTO sr_levels (symbol, expiry, trade_date, slot, strike, oi, valid_from, reason) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (symbol, expiry, slot, valid_from) DO NOTHING",
                            (symbol, expiry, date, r["slot"], r["strike"], r["oi"], ts(r["valid_from"]), r["reason"]))

    # ---- Dashboard "Fix zones" (dashboard_levels_api.py): one active set per index + expiry
    def fixed_levels(self, index, expiry):
        """The active fixed set {fixedAt, levels} for index + expiry, or None."""
        with self._cursor() as cur:
            cur.execute('SELECT fixed_at, r1, r2, r3, s1, s2, s3 FROM dashboard_fixed_levels '
                        'WHERE "index"=%s AND expiry=%s AND active', (index, expiry))
            r = cur.fetchone()
        if not r:
            return None
        return {"fixedAt": r[0].astimezone(IST).isoformat(),
                "levels": {k: v for k, v in zip(LEVEL_SLOTS, r[1:]) if v is not None}}

    def fix_levels(self, index, expiry, levels, at):
        """Replaces the active set (the old one is kept, inactive) in one transaction."""
        with self._cursor() as cur:
            cur.execute('UPDATE dashboard_fixed_levels SET active=false, unfixed_at=%s '
                        'WHERE "index"=%s AND expiry=%s AND active', (at, index, expiry))
            cur.execute('INSERT INTO dashboard_fixed_levels ("index", expiry, fixed_at, r1, r2, r3, s1, s2, s3) '
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (index, expiry, at, *[levels.get(k) for k in LEVEL_SLOTS]))
        return self.fixed_levels(index, expiry)

    def unfix_levels(self, index, expiry, at):
        with self._cursor() as cur:
            cur.execute('UPDATE dashboard_fixed_levels SET active=false, unfixed_at=%s '
                        'WHERE "index"=%s AND expiry=%s AND active', (at, index, expiry))

    def sr_settings(self):
        with self._cursor() as cur:
            cur.execute("SELECT settings FROM sr_settings WHERE id=1")
            row = cur.fetchone()
            return row[0] if row else {}

    def save_sr_settings(self, settings):
        with self._cursor() as cur:
            cur.execute("INSERT INTO sr_settings (id, settings) VALUES (1, %s) "
                        "ON CONFLICT (id) DO UPDATE SET settings=EXCLUDED.settings", (json.dumps(settings),))


# ================================================================ paper trading
# Both paper stores expose the same methods, used by paper_api.PaperService:
#   active_account() / create_account(capital, now) / archive_account(id, now) / set_capital(id, capital) / accounts()
#   save_order(acc, day, order) / save_trade(acc, day, trade) / save_position(acc, day, position)   (engine dicts)
#   orders(acc, day) / trades(acc, day)  -> [dict]          day = 'YYYY-MM-DD' (IST trading day)
#   day_summary(acc, from_day, to_day)   -> [{date, realized, charges, trades}]   days with trades only
#   net_before(acc, day)                 -> realized - charges of every earlier day
_CHARGE_FIELDS = ("brokerage", "stt", "transaction", "sebi", "stamp", "gst")


def _summarize_days(positions_by_day, trades_by_day, from_day, to_day):
    rows = []
    for day in sorted(trades_by_day):
        trades = trades_by_day[day]
        if from_day <= day <= to_day and trades:
            rows.append({"date": day,
                         "realized": round(sum(p["realized"] for p in positions_by_day.get(day, [])), 2),
                         "charges": round(sum(t["charges"]["total"] for t in trades), 2),
                         "trades": len(trades)})
    return rows


def _locked(cls):
    """Every public method under one lock: the paper service and the algo write the same file from two threads."""
    for name, fn in list(vars(cls).items()):
        if callable(fn) and not name.startswith("_"):
            def wrap(f):
                def inner(self, *a, **k):
                    with self._lock:
                        return f(self, *a, **k)
                inner.__name__, inner.__doc__ = f.__name__, f.__doc__
                return inner
            setattr(cls, name, wrap(fn))
    return cls


@_locked
class PaperJsonStore:
    """Test double of PaperPgStore: everything in one JSON file, rewritten on every change. main.py never uses it."""
    kind = "json"

    def __init__(self, data_dir="data"):
        os.makedirs(data_dir, exist_ok=True)
        self._lock = threading.RLock()
        self.path = os.path.join(data_dir, "paper.json")
        self.d = {"accounts": [], "orders": {}, "trades": {}, "positions": {}}
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self.d = json.load(f)

    def _write(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.d, f)
        os.replace(tmp, self.path)

    def _day(self, table, acc, day):
        return self.d[table].setdefault(str(acc), {}).setdefault(day, {})

    def active_account(self, name=None):
        """name None: the manual Paper Trading account; "Algo": the algo's."""
        a = next((a for a in reversed(self.d["accounts"]) if not a["archived_at"] and a.get("name") == name), None)
        return dict(a) if a else None

    def accounts(self):
        return [dict(a) for a in self.d["accounts"]]

    def create_account(self, capital, now, name=None, strategy_id=None):
        a = {"id": len(self.d["accounts"]) + 1, "capital": float(capital), "created_at": now.isoformat(),
             "archived_at": None, "name": name, "strategy_id": strategy_id}
        self.d["accounts"].append(a)
        self._write()
        return dict(a)

    def archive_account(self, acc, now):
        for a in self.d["accounts"]:
            if a["id"] == acc:
                a["archived_at"] = now.isoformat()
        self._write()

    def set_capital(self, acc, capital):
        for a in self.d["accounts"]:
            if a["id"] == acc:
                a["capital"] = float(capital)
        self._write()

    # ---- strategies (same interface as PaperPgStore)
    def _strategy_out(self, st):
        acc = next((a["id"] for a in reversed(self.d["accounts"])
                    if a.get("strategy_id") == st["id"] and not a["archived_at"]), None)
        return {**st, "account_id": acc}

    def strategies(self, user_id):
        return [self._strategy_out(st) for st in self.d.get("strategies", []) if st["user_id"] == user_id]

    def all_strategies(self):
        return [self._strategy_out(st) for st in self.d.get("strategies", [])]

    def save_daily_summary(self, row):
        t = self.d.setdefault("daily_summary", {})
        t[f"{row['account_id']}|{row['trade_date']}"] = {k: row.get(k) for k in DAILY_SUMMARY_KEYS}
        self._write()

    def daily_summaries(self, strategy_ids, from_day, to_day):
        ids = set(strategy_ids)
        rows = [dict(r) for r in self.d.get("daily_summary", {}).values()
                if r["strategy_id"] in ids and from_day <= r["trade_date"] <= to_day]
        return sorted(rows, key=lambda r: (r["trade_date"], r["strategy_id"]))

    def strategy(self, sid):
        st = next((st for st in self.d.get("strategies", []) if st["id"] == sid), None)
        return self._strategy_out(st) if st else None

    def create_strategy(self, user_id, name, description, capital, kind, now, account_name=None):
        rows = self.d.setdefault("strategies", [])
        if any(st["user_id"] == user_id and st["name"].lower() == name.lower() for st in rows):
            raise DuplicateName(name)
        st = {"id": len(rows) + 1, "user_id": user_id, "name": name, "description": description, "notes": "",
              "capital": float(capital), "kind": kind, "created_at": now.isoformat(), "updated_at": now.isoformat(),
              "archived_at": None}
        rows.append(st)
        self.create_account(capital, now, account_name, st["id"])  # writes the file
        return self.strategy(st["id"])

    def update_strategy(self, sid, now, **fields):
        st = next(st for st in self.d["strategies"] if st["id"] == sid)
        if "name" in fields and any(o["id"] != sid and o["user_id"] == st["user_id"]
                                    and o["name"].lower() == fields["name"].lower() for o in self.d["strategies"]):
            raise DuplicateName(fields["name"])
        st.update({k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in fields.items() if k in STRATEGY_EDITABLE})
        st["updated_at"] = now.isoformat()
        self._write()
        return self.strategy(sid)

    def strategy_set_capital(self, sid, capital, now):
        st = self.strategy(sid)
        self.set_capital(st["account_id"], capital)
        return self._set_strategy_capital(sid, capital, now)

    def strategy_reset(self, sid, capital, now):
        st = self.strategy(sid)
        if st["account_id"]:
            self.archive_account(st["account_id"], now)
        acc = next(a for a in self.d["accounts"] if a["id"] == st["account_id"]) if st["account_id"] else {}
        self.create_account(capital, now, acc.get("name"), sid)
        return self._set_strategy_capital(sid, capital, now)

    def _set_strategy_capital(self, sid, capital, now):
        st = next(st for st in self.d["strategies"] if st["id"] == sid)
        st["capital"], st["updated_at"] = float(capital), now.isoformat()
        self._write()
        return self.strategy(sid)

    def book_open(self, acc, day):
        """True when the account holds an open position or a pending order on that day."""
        pos = self.d["positions"].get(str(acc), {}).get(day, {}).values()
        orders = self.d["orders"].get(str(acc), {}).get(day, {}).values()
        return any(p["buy_qty"] != p["sell_qty"] for p in pos) or any(o["status"] in OPEN_ORDER_STATES for o in orders)

    def user_pref(self, user_id, key):
        return self.d.get("prefs", {}).get(f"{user_id}|{key}")

    # ---- growth plans (same interface as PaperPgStore)
    @staticmethod
    def _iso(v):
        return v.isoformat() if hasattr(v, "isoformat") else v

    def add_plan(self, user_id, name, yearly_pct, method, initial_capital, start_month, years, now):
        rows = self.d.setdefault("plans", [])
        pl = {"id": len(rows) + 1, "user_id": user_id, "name": name, "yearly_pct": float(yearly_pct), "method": method,
              "initial_capital": float(initial_capital), "start_month": start_month, "years": int(years),
              "created_at": now.isoformat(), "archived_at": None}
        rows.append(pl)
        self._write()
        return dict(pl)

    def plans(self, user_id):
        return [dict(p) for p in self.d.get("plans", []) if p["user_id"] == user_id]

    def plan(self, pid):
        return next((dict(p) for p in self.d.get("plans", []) if p["id"] == pid), None)

    def update_plan(self, pid, **fields):
        pl = next(p for p in self.d["plans"] if p["id"] == pid)
        pl.update({k: self._iso(v) for k, v in fields.items() if k in PLAN_EDITABLE})
        self._write()
        return dict(pl)

    def delete_plan(self, pid):
        """The plan and every link to it (active and history)."""
        self.d["strategy_plans"] = [m for m in self.d.get("strategy_plans", []) if m["plan_id"] != pid]
        self.d["plans"] = [p for p in self.d.get("plans", []) if p["id"] != pid]
        self._write()

    def apply_plan(self, strategy_id, plan_id, initial_capital, now):
        rows = self.d.setdefault("strategy_plans", [])
        for m in rows:
            if m["strategy_id"] == strategy_id and not m["ended_at"]:
                m["ended_at"] = now.isoformat()
        m = {"id": len(rows) + 1, "strategy_id": strategy_id, "plan_id": plan_id,
             "initial_capital": float(initial_capital), "applied_at": now.isoformat(), "ended_at": None}
        rows.append(m)
        self._write()
        return dict(m)

    def end_plans(self, now, strategy_id=None, plan_id=None):
        for m in self.d.get("strategy_plans", []):
            if not m["ended_at"] and (strategy_id is None or m["strategy_id"] == strategy_id) \
                    and (plan_id is None or m["plan_id"] == plan_id):
                m["ended_at"] = now.isoformat()
        self._write()

    def plan_mappings(self, strategy_id=None, plan_id=None):
        """Newest first."""
        rows = [dict(m) for m in self.d.get("strategy_plans", [])
                if (strategy_id is None or m["strategy_id"] == strategy_id) and (plan_id is None or m["plan_id"] == plan_id)]
        return sorted(rows, key=lambda m: m["id"], reverse=True)

    def add_capital_event(self, strategy_id, at, kind, amount, capital_after):
        rows = self.d.setdefault("capital_events", [])
        rows.append({"id": len(rows) + 1, "strategy_id": strategy_id, "at": at.isoformat(), "kind": kind,
                     "amount": float(amount), "capital_after": float(capital_after)})
        self._write()

    def capital_events(self, strategy_id):
        return [dict(e) for e in self.d.get("capital_events", []) if e["strategy_id"] == strategy_id]

    def set_user_pref(self, user_id, key, value):
        self.d.setdefault("prefs", {})[f"{user_id}|{key}"] = str(value)
        self._write()

    def save_order(self, acc, day, order):
        self._day("orders", acc, day)[order["id"]] = order
        self._write()

    def save_trade(self, acc, day, trade):
        self._day("trades", acc, day)[trade["id"]] = trade
        self._write()

    def save_position(self, acc, day, pos):
        self._day("positions", acc, day)[str(pos["security_id"])] = pos
        self._write()

    def save_order_levels(self, acc, day, row):
        self.d.setdefault("order_levels", {})
        self._day("order_levels", acc, day)[row["order_id"]] = row
        self._write()

    def order_levels(self, acc, day):
        return list(self.d.get("order_levels", {}).get(str(acc), {}).get(day, {}).values())

    # ---- OI breakout algo: the same interface as PaperPgStore (test double, never used by main.py)
    def _algo(self, table):
        return self.d.setdefault(table, {})

    def algo_add_event(self, ev):
        uid = event_uid(ev)
        seen = self._algo("algo_uids")
        if uid in seen:
            return False
        seen[uid] = 1
        row = {**{k: ev.get(k) for k in ("ts", "trade_date", "index", "variant", "type", "setup", "message")},
               "kind": ev.get("kind") or ev["type"], "details": {**(ev.get("details") or {}), "kind": ev.get("kind") or ev["type"]}}
        row["setup"] = row["setup"] or ""
        self._algo("algo_events").setdefault(ev["trade_date"], []).append(json.loads(json.dumps(row, default=str)))
        self._write()
        return True

    def algo_events(self, day, variant=None, index=None):
        rows = self._algo("algo_events").get(day, [])
        return [dict(r) for r in rows if (not variant or r["variant"] == variant or r["index"] == "*")
                and (not index or r["index"] in (index, "*"))]

    def algo_save_state(self, day, index, variant, state):
        self._algo("algo_state").setdefault(day, {})[f"{index}|{variant}"] = json.loads(json.dumps(state, default=str))
        self._write()

    def algo_states(self, day):
        return {tuple(k.split("|")): v for k, v in self._algo("algo_state").get(day, {}).items()}

    def algo_states_between(self, from_day, to_day):
        out = []
        for day in sorted(self._algo("algo_state")):
            if from_day <= day <= to_day:
                for k, v in sorted(self._algo("algo_state")[day].items()):
                    i, var = k.split("|")
                    out.append((day, i, var, v))
        return out

    def algo_save_levels(self, row):
        days = self._algo("algo_levels").setdefault(row["trade_date"], {})
        if row["index"] in days:
            return False
        days[row["index"]] = {"index": row["index"], "expiry": row["expiry"], "lockedAt": str(row["locked_at"]),
                              "levels": dict(row["levels"]), "spot": row.get("spot")}
        self._write()
        return True

    def algo_levels(self, day):
        return dict(self._algo("algo_levels").get(day, {}))

    def algo_save_candle(self, row):
        days = self._algo("algo_candles").setdefault(row["trade_date"], {})
        key = f"{row['index']}|{row['candle_start']}"
        if key in days:
            return False
        days[key] = json.loads(json.dumps({"trade_date": row["trade_date"], "index": row["index"],
                                           **{c: row.get(c) for c in CANDLE_COLS}}, default=str))
        self._write()
        return True

    def algo_candles(self, day, index=None):
        rows = self._algo("algo_candles").get(day, {}).values()
        return sorted((dict(r) for r in rows if not index or r["index"] == index), key=lambda r: (r["index"], r["candle_start"]))

    def algo_save_summaries(self, rows):
        t = self._algo("algo_daily_summary")
        for r in rows:
            t[f"{r['trade_date']}|{r['index']}|{r['variant']}"] = {k: r.get(k) for k in ("trade_date", "index", "variant", *SUMMARY_COLS)}
        self._write()

    def algo_summaries(self, from_day, to_day, index=None, variant=None):
        rows = [dict(r) for r in self._algo("algo_daily_summary").values()
                if from_day <= r["trade_date"] <= to_day and (not index or r["index"] == index)
                and (not variant or r["variant"] == variant)]
        return sorted(rows, key=lambda r: (r["trade_date"], r["index"], r["variant"]))

    def algo_days(self, from_day, to_day):
        days = set(self._algo("algo_state")) | set(self._algo("algo_events"))
        return sorted(d for d in days if from_day <= d <= to_day)

    def orders(self, acc, day):
        return sorted(self.d["orders"].get(str(acc), {}).get(day, {}).values(), key=lambda o: o["created_at"])

    def trades(self, acc, day):
        return sorted(self.d["trades"].get(str(acc), {}).get(day, {}).values(), key=lambda t: t["time"])

    def day_summary(self, acc, from_day, to_day):
        a = str(acc)
        pos = {d: list(v.values()) for d, v in self.d["positions"].get(a, {}).items()}
        trd = {d: list(v.values()) for d, v in self.d["trades"].get(a, {}).items()}
        return _summarize_days(pos, trd, from_day, to_day)

    def net_before(self, acc, day):
        rows = self.day_summary(acc, "0000-00-00", day)
        return round(sum(r["realized"] - r["charges"] for r in rows if r["date"] < day), 2)

    def trades_between(self, acc, from_day, to_day):
        days = self.d["trades"].get(str(acc), {})
        return [{**t, "date": d} for d in sorted(days) if from_day <= d <= to_day
                for t in sorted(days[d].values(), key=lambda t: t["time"])]

    def scalper_save_summary(self, row):
        t = self.d.setdefault("scalper_daily_summary", {})
        t[f"{row['account_id']}|{row['trade_date']}"] = {k: row.get(k) for k in ("account_id", "trade_date", *SCALPER_SUMMARY_COLS)}
        self._write()

    def scalper_summaries(self, acc, from_day, to_day):
        rows = [dict(r) for r in self.d.get("scalper_daily_summary", {}).values()
                if r["account_id"] == acc and from_day <= r["trade_date"] <= to_day]
        return sorted(rows, key=lambda r: r["trade_date"])


class PaperPgStore:
    """Paper trading tables (pt_*) in Postgres, sharing PgStore's connection pool and schema.sql."""
    kind = "postgres"
    _ORDER_COLS = ("id", "security_id", "side", "order_type", "lots", "lot_size", "price", "trigger_price", "status",
                   "avg_price", "slippage_capped", "reason", "blocked", "created_at", "updated_at", "filled_at",
                   "source", "setup", "variant", "oco_group")
    _ORDER_DEFAULTS = {"source": "manual", "setup": "", "variant": "", "oco_group": ""}

    def __init__(self, pg):
        self.pg = pg

    @staticmethod
    def _account(r):
        return {"id": r[0], "capital": r[1], "created_at": r[2].astimezone(IST).isoformat(),
                "archived_at": r[3].astimezone(IST).isoformat() if r[3] else None, "name": r[4], "strategy_id": r[5]}

    def active_account(self, name=None):
        """name None: the manual Paper Trading account; "Algo": the algo's."""
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, capital, created_at, archived_at, name, strategy_id FROM pt_accounts WHERE archived_at IS NULL "
                        "AND name IS NOT DISTINCT FROM %s ORDER BY id DESC LIMIT 1", (name,))
            r = cur.fetchone()
        return self._account(r) if r else None

    def accounts(self):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, capital, created_at, archived_at, name, strategy_id FROM pt_accounts ORDER BY id")
            return [self._account(r) for r in cur.fetchall()]

    def create_account(self, capital, now, name=None, strategy_id=None):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_accounts (capital, created_at, name, strategy_id) VALUES (%s, %s, %s, %s) "
                        "RETURNING id, capital, created_at, archived_at, name, strategy_id",
                        (float(capital), now, name, strategy_id))
            return self._account(cur.fetchone())

    def archive_account(self, acc, now):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE pt_accounts SET archived_at=%s WHERE id=%s", (now, acc))

    def set_capital(self, acc, capital):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE pt_accounts SET capital=%s WHERE id=%s", (float(capital), acc))

    # ---- strategies (th_strategies; the open capital period is the pt_accounts row with archived_at NULL)
    _STRATEGY_SQL = ("SELECT s.id, s.user_id, s.name, s.description, s.notes, s.capital, s.kind, s.created_at, "
                     "s.updated_at, s.archived_at, (SELECT a.id FROM pt_accounts a WHERE a.strategy_id = s.id "
                     "AND a.archived_at IS NULL ORDER BY a.id DESC LIMIT 1) FROM th_strategies s ")

    @staticmethod
    def _strategy(r):
        iso = lambda t: t.astimezone(IST).isoformat() if t else None  # noqa: E731
        return {"id": r[0], "user_id": r[1], "name": r[2], "description": r[3], "notes": r[4], "capital": r[5],
                "kind": r[6], "created_at": iso(r[7]), "updated_at": iso(r[8]), "archived_at": iso(r[9]),
                "account_id": r[10]}

    def strategies(self, user_id):
        with self.pg._cursor() as cur:
            cur.execute(self._STRATEGY_SQL + "WHERE s.user_id=%s ORDER BY s.id", (user_id,))
            return [self._strategy(r) for r in cur.fetchall()]

    def all_strategies(self):
        with self.pg._cursor() as cur:
            cur.execute(self._STRATEGY_SQL + "ORDER BY s.id")
            return [self._strategy(r) for r in cur.fetchall()]

    def save_daily_summary(self, row):
        cols = SCALPER_SUMMARY_COLS
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO pt_daily_summary (strategy_id, account_id, trade_date, {', '.join(cols)}, updated_at) "
                        f"VALUES (%s, %s, %s, {', '.join(['%s'] * len(cols))}, now()) "
                        "ON CONFLICT (account_id, trade_date) DO UPDATE SET "
                        + ", ".join(f"{c}=EXCLUDED.{c}" for c in cols) + ", updated_at=now()",
                        (row["strategy_id"], row["account_id"], row["trade_date"], *[row.get(c) for c in cols]))

    def daily_summaries(self, strategy_ids, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT strategy_id, account_id, trade_date, {', '.join(SCALPER_SUMMARY_COLS)} FROM pt_daily_summary "
                        "WHERE strategy_id = ANY(%s) AND trade_date BETWEEN %s AND %s ORDER BY trade_date, strategy_id",
                        (list(strategy_ids), from_day, to_day))
            return [{"strategy_id": r[0], "account_id": r[1], "trade_date": r[2].isoformat(),
                     **dict(zip(SCALPER_SUMMARY_COLS, r[3:]))} for r in cur.fetchall()]

    def strategy(self, sid):
        with self.pg._cursor() as cur:
            cur.execute(self._STRATEGY_SQL + "WHERE s.id=%s", (sid,))
            r = cur.fetchone()
            return self._strategy(r) if r else None

    def _unique(self, fn):
        import psycopg2.errors
        try:
            return fn()
        except psycopg2.errors.UniqueViolation as e:
            raise DuplicateName(str(e)) from None

    def create_strategy(self, user_id, name, description, capital, kind, now, account_name=None):
        """The strategy and its first capital period (pt_accounts row), in one transaction."""
        def run():
            with self.pg._cursor() as cur:
                cur.execute("INSERT INTO th_strategies (user_id, name, description, capital, kind, created_at, updated_at) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
                            (user_id, name, description, float(capital), kind, now, now))
                sid = cur.fetchone()[0]
                cur.execute("INSERT INTO pt_accounts (capital, created_at, name, strategy_id) VALUES (%s, %s, %s, %s)",
                            (float(capital), now, account_name, sid))
            return self.strategy(sid)
        return self._unique(run)

    def update_strategy(self, sid, now, **fields):
        fields = {k: v for k, v in fields.items() if k in STRATEGY_EDITABLE}
        sets = ", ".join(f"{k}=%s" for k in fields)

        def run():
            with self.pg._cursor() as cur:
                cur.execute(f"UPDATE th_strategies SET {sets + ', ' if sets else ''}updated_at=%s WHERE id=%s",
                            (*fields.values(), now, sid))
            return self.strategy(sid)
        return self._unique(run)

    def strategy_set_capital(self, sid, capital, now):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE pt_accounts SET capital=%s WHERE strategy_id=%s AND archived_at IS NULL", (float(capital), sid))
            cur.execute("UPDATE th_strategies SET capital=%s, updated_at=%s WHERE id=%s", (float(capital), now, sid))
        return self.strategy(sid)

    def strategy_reset(self, sid, capital, now):
        """Archive the open capital period and open a new one (same account name); history stays."""
        with self.pg._cursor() as cur:
            cur.execute("UPDATE pt_accounts SET archived_at=%s WHERE strategy_id=%s AND archived_at IS NULL "
                        "RETURNING name", (now, sid))
            prev = cur.fetchone()
            cur.execute("INSERT INTO pt_accounts (capital, created_at, name, strategy_id) VALUES (%s, %s, %s, %s)",
                        (float(capital), now, prev[0] if prev else None, sid))
            cur.execute("UPDATE th_strategies SET capital=%s, updated_at=%s WHERE id=%s", (float(capital), now, sid))
        return self.strategy(sid)

    def book_open(self, acc, day):
        """True when the account holds an open position or a pending order on that day."""
        with self.pg._cursor() as cur:
            cur.execute("SELECT EXISTS (SELECT 1 FROM pt_positions WHERE account_id=%s AND trade_date=%s "
                        "AND buy_qty <> sell_qty) OR EXISTS (SELECT 1 FROM pt_orders WHERE account_id=%s "
                        "AND trade_date=%s AND status = ANY(%s))", (acc, day, acc, day, list(OPEN_ORDER_STATES)))
            return cur.fetchone()[0]

    def user_pref(self, user_id, key):
        with self.pg._cursor() as cur:
            cur.execute("SELECT value FROM th_user_prefs WHERE user_id=%s AND key=%s", (user_id, key))
            r = cur.fetchone()
            return r[0] if r else None

    # ---- growth plans (th_growth_plans, th_strategy_plans, th_capital_events)
    _PLAN_COLS = "id, user_id, name, yearly_pct, method, initial_capital, start_month, years, created_at, archived_at"

    @staticmethod
    def _plan(r):
        iso = lambda t: t.astimezone(IST).isoformat() if t else None  # noqa: E731
        return {"id": r[0], "user_id": r[1], "name": r[2], "yearly_pct": r[3], "method": r[4], "initial_capital": r[5],
                "start_month": r[6].isoformat()[:7], "years": r[7], "created_at": iso(r[8]), "archived_at": iso(r[9])}

    def add_plan(self, user_id, name, yearly_pct, method, initial_capital, start_month, years, now):
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO th_growth_plans (user_id, name, yearly_pct, method, initial_capital, start_month, "
                        f"years, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {self._PLAN_COLS}",
                        (user_id, name, yearly_pct, method, initial_capital, f"{start_month}-01", years, now))
            return self._plan(cur.fetchone())

    def plans(self, user_id):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT {self._PLAN_COLS} FROM th_growth_plans WHERE user_id=%s ORDER BY id", (user_id,))
            return [self._plan(r) for r in cur.fetchall()]

    def plan(self, pid):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT {self._PLAN_COLS} FROM th_growth_plans WHERE id=%s", (pid,))
            r = cur.fetchone()
            return self._plan(r) if r else None

    def update_plan(self, pid, **fields):
        fields = {k: (f"{v}-01" if k == "start_month" else v) for k, v in fields.items() if k in PLAN_EDITABLE}
        with self.pg._cursor() as cur:
            cur.execute(f"UPDATE th_growth_plans SET {', '.join(f'{k}=%s' for k in fields)} WHERE id=%s "
                        f"RETURNING {self._PLAN_COLS}", (*fields.values(), pid))
            return self._plan(cur.fetchone())

    def delete_plan(self, pid):
        """The plan and every link to it (active and history), in one transaction."""
        with self.pg._cursor() as cur:
            cur.execute("DELETE FROM th_strategy_plans WHERE plan_id=%s", (pid,))
            cur.execute("DELETE FROM th_growth_plans WHERE id=%s", (pid,))

    @staticmethod
    def _mapping(r):
        iso = lambda t: t.astimezone(IST).isoformat() if t else None  # noqa: E731
        return {"id": r[0], "strategy_id": r[1], "plan_id": r[2], "initial_capital": r[3], "applied_at": iso(r[4]),
                "ended_at": iso(r[5])}

    def apply_plan(self, strategy_id, plan_id, initial_capital, now):
        """Ends the strategy's active plan (kept as history) and applies this one, in one transaction."""
        with self.pg._cursor() as cur:
            cur.execute("UPDATE th_strategy_plans SET ended_at=%s WHERE strategy_id=%s AND ended_at IS NULL",
                        (now, strategy_id))
            cur.execute("INSERT INTO th_strategy_plans (strategy_id, plan_id, initial_capital, applied_at) "
                        "VALUES (%s, %s, %s, %s) RETURNING id, strategy_id, plan_id, initial_capital, applied_at, ended_at",
                        (strategy_id, plan_id, initial_capital, now))
            return self._mapping(cur.fetchone())

    def end_plans(self, now, strategy_id=None, plan_id=None):
        q, args = "UPDATE th_strategy_plans SET ended_at=%s WHERE ended_at IS NULL", [now]
        if strategy_id is not None:
            q, args = q + " AND strategy_id=%s", args + [strategy_id]
        if plan_id is not None:
            q, args = q + " AND plan_id=%s", args + [plan_id]
        with self.pg._cursor() as cur:
            cur.execute(q, args)

    def plan_mappings(self, strategy_id=None, plan_id=None):
        """Newest first."""
        q, args = "SELECT id, strategy_id, plan_id, initial_capital, applied_at, ended_at FROM th_strategy_plans WHERE true", []
        if strategy_id is not None:
            q, args = q + " AND strategy_id=%s", args + [strategy_id]
        if plan_id is not None:
            q, args = q + " AND plan_id=%s", args + [plan_id]
        with self.pg._cursor() as cur:
            cur.execute(q + " ORDER BY id DESC", args)
            return [self._mapping(r) for r in cur.fetchall()]

    def add_capital_event(self, strategy_id, at, kind, amount, capital_after):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO th_capital_events (strategy_id, at, kind, amount, capital_after) "
                        "VALUES (%s, %s, %s, %s, %s)", (strategy_id, at, kind, amount, capital_after))

    def capital_events(self, strategy_id):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, strategy_id, at, kind, amount, capital_after FROM th_capital_events "
                        "WHERE strategy_id=%s ORDER BY at, id", (strategy_id,))
            return [{"id": r[0], "strategy_id": r[1], "at": r[2].astimezone(IST).isoformat(), "kind": r[3],
                     "amount": r[4], "capital_after": r[5]} for r in cur.fetchall()]

    def set_user_pref(self, user_id, key, value):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO th_user_prefs (user_id, key, value) VALUES (%s, %s, %s) "
                        "ON CONFLICT (user_id, key) DO UPDATE SET value=EXCLUDED.value", (user_id, key, str(value)))

    def save_order(self, acc, day, o):
        cols = self._ORDER_COLS
        updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c not in ("id", "created_at"))
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO pt_orders (account_id, trade_date, strategy_id, {', '.join(cols)}) "
                        f"VALUES (%s, %s, (SELECT strategy_id FROM pt_accounts WHERE id=%s), {', '.join(['%s'] * len(cols))}) "
                        f"ON CONFLICT (account_id, id) DO UPDATE SET {updates}",
                        (acc, day, acc, *[o.get(c, self._ORDER_DEFAULTS.get(c)) for c in cols]))

    def save_trade(self, acc, day, t):
        c = t["charges"]
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_trades (account_id, id, order_id, trade_date, security_id, side, qty, price, "
                        "value, brokerage, stt, transaction, sebi, stamp, gst, traded_at, strategy_id) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,(SELECT strategy_id FROM pt_accounts WHERE id=%s)) ON CONFLICT DO NOTHING",
                        (acc, t["id"], t["order_id"], day, t["security_id"], t["side"], t["qty"], t["price"],
                         t["value"], *[c[k] for k in _CHARGE_FIELDS], t["time"], acc))

    def save_position(self, acc, day, p):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_positions (account_id, trade_date, security_id, lot_size, buy_qty, sell_qty, "
                        "avg_buy, avg_sell, realized, strategy_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,(SELECT strategy_id FROM pt_accounts WHERE id=%s)) "
                        "ON CONFLICT (account_id, trade_date, security_id) DO UPDATE SET lot_size=EXCLUDED.lot_size, "
                        "buy_qty=EXCLUDED.buy_qty, sell_qty=EXCLUDED.sell_qty, avg_buy=EXCLUDED.avg_buy, "
                        "avg_sell=EXCLUDED.avg_sell, realized=EXCLUDED.realized",
                        (acc, day, p["security_id"], p["lot_size"], p["buy_qty"], p["sell_qty"], p["avg_buy"],
                         p["avg_sell"], p["realized"], acc))

    def save_order_levels(self, acc, day, r):
        z = r["zone"] or {}
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_order_levels (account_id, order_id, trade_date, symbol, expiry, spot, levels_at, "
                        "levels, zone_slot, zone_strike, created_at, strategy_id) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,(SELECT strategy_id FROM pt_accounts WHERE id=%s)) "
                        "ON CONFLICT (account_id, order_id) DO NOTHING",
                        (acc, r["order_id"], day, r["symbol"], r["expiry"], r["spot"], r["levelsAt"],
                         json.dumps(r["levels"]), z.get("slot"), z.get("strike"), r["created_at"], acc))

    # ---- OI breakout algo (algo_service.py). Every day argument is the IST trading date 'YYYY-MM-DD'.
    def algo_add_event(self, ev):
        """ev: {ts, trade_date, index, variant, type, kind, setup, message, details}. A repeat (same uid) is ignored."""
        details = {**(ev.get("details") or {}), "kind": ev.get("kind") or ev["type"]}
        with self.pg._cursor() as cur:
            cur.execute('INSERT INTO algo_events (trade_date, ts, "index", variant, type, setup, message, details, uid, '
                        "strategy_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,(SELECT strategy_id FROM pt_accounts WHERE name='Algo' AND archived_at IS NULL ORDER BY id DESC LIMIT 1)) ON CONFLICT (uid) DO NOTHING",
                        (ev["trade_date"], ev["ts"], ev["index"], ev["variant"], ev["type"], ev.get("setup", ""),
                         ev["message"], json.dumps(details, default=str), event_uid(ev)))
            return cur.rowcount == 1

    def algo_events(self, day, variant=None, index=None):
        q = ('SELECT ts, trade_date, "index", variant, type, setup, message, details FROM algo_events '
             "WHERE trade_date=%s")
        args = [day]
        if variant:
            q += " AND (variant=%s OR \"index\"='*')"
            args.append(variant)
        if index:
            q += " AND (\"index\"=%s OR \"index\"='*')"
            args.append(index)
        with self.pg._cursor() as cur:
            cur.execute(q + " ORDER BY ts, id", args)
            return [_event_row(r) for r in cur.fetchall()]

    def algo_save_state(self, day, index, variant, state):
        with self.pg._cursor() as cur:
            cur.execute('INSERT INTO algo_state (trade_date, "index", variant, state, updated_at, strategy_id) '
                        "VALUES (%s,%s,%s,%s,now(),(SELECT strategy_id FROM pt_accounts WHERE name='Algo' AND archived_at IS NULL ORDER BY id DESC LIMIT 1)) "
                        'ON CONFLICT (trade_date, "index", variant) DO UPDATE SET state=EXCLUDED.state, updated_at=now()',
                        (day, index, variant, json.dumps(state, default=str)))

    def algo_states(self, day):
        """{(index, variant): state} of one day."""
        with self.pg._cursor() as cur:
            cur.execute('SELECT "index", variant, state FROM algo_state WHERE trade_date=%s', (day,))
            return {(r[0], r[1]): r[2] for r in cur.fetchall()}

    def algo_states_between(self, from_day, to_day):
        """[(day, index, variant, state)] for a date range (reports)."""
        with self.pg._cursor() as cur:
            cur.execute('SELECT trade_date, "index", variant, state FROM algo_state WHERE trade_date BETWEEN %s AND %s '
                        'ORDER BY trade_date, "index", variant', (from_day, to_day))
            return [(r[0].isoformat(), r[1], r[2], r[3]) for r in cur.fetchall()]

    def algo_save_levels(self, row):
        """The day's locked levels; the first lock of the day wins (a re-import never changes it)."""
        lv = row["levels"]
        with self.pg._cursor() as cur:
            cur.execute('INSERT INTO algo_levels (trade_date, "index", expiry, locked_at, r1, r2, r3, s1, s2, s3, spot) '
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trade_date, \"index\") DO NOTHING",
                        (row["trade_date"], row["index"], row["expiry"], row["locked_at"],
                         *[lv.get(s) for s in LEVEL_SLOTS], row.get("spot")))
            return cur.rowcount == 1

    def algo_levels(self, day):
        with self.pg._cursor() as cur:
            cur.execute('SELECT "index", expiry, locked_at, r1, r2, r3, s1, s2, s3, spot FROM algo_levels '
                        "WHERE trade_date=%s", (day,))
            return {r[0]: {"index": r[0], "expiry": r[1], "lockedAt": r[2].astimezone(IST).isoformat(),
                           "levels": {s: v for s, v in zip(LEVEL_SLOTS, r[3:9]) if v is not None}, "spot": r[9]}
                    for r in cur.fetchall()}

    def algo_save_candle(self, row):
        with self.pg._cursor() as cur:
            cur.execute(f'INSERT INTO algo_candles (trade_date, "index", {", ".join(CANDLE_COLS)}) '
                        f"VALUES (%s,%s,{', '.join(['%s'] * len(CANDLE_COLS))}) "
                        'ON CONFLICT (trade_date, "index", candle_start) DO NOTHING',
                        (row["trade_date"], row["index"], *[row.get(c) for c in CANDLE_COLS]))
            return cur.rowcount == 1

    def algo_candles(self, day, index=None):
        q = f'SELECT trade_date, "index", {", ".join(CANDLE_COLS)} FROM algo_candles WHERE trade_date=%s'
        args = [day]
        if index:
            q += ' AND "index"=%s'
            args.append(index)
        with self.pg._cursor() as cur:
            cur.execute(q + ' ORDER BY "index", candle_start', args)
            out = []
            for r in cur.fetchall():
                d = {"trade_date": r[0].isoformat(), "index": r[1], **dict(zip(CANDLE_COLS, r[2:]))}
                d["candle_start"] = d["candle_start"].astimezone(IST).isoformat()
                out.append(d)
            return out

    def algo_save_summaries(self, rows):
        with self.pg._cursor() as cur:
            for r in rows:
                cur.execute(f'INSERT INTO algo_daily_summary (trade_date, "index", variant, {", ".join(SUMMARY_COLS)}, '
                            f"updated_at, strategy_id) VALUES (%s,%s,%s,{', '.join(['%s'] * len(SUMMARY_COLS))}, now(), "
                            "(SELECT strategy_id FROM pt_accounts WHERE name='Algo' AND archived_at IS NULL ORDER BY id DESC LIMIT 1)) "
                            'ON CONFLICT (trade_date, "index", variant) DO UPDATE SET '
                            + ", ".join(f"{c}=EXCLUDED.{c}" for c in SUMMARY_COLS) + ", updated_at=now()",
                            (r["trade_date"], r["index"], r["variant"], *[r.get(c) for c in SUMMARY_COLS]))

    def algo_summaries(self, from_day, to_day, index=None, variant=None):
        q = (f'SELECT trade_date, "index", variant, {", ".join(SUMMARY_COLS)} FROM algo_daily_summary '
             "WHERE trade_date BETWEEN %s AND %s")
        args = [from_day, to_day]
        if index:
            q += ' AND "index"=%s'
            args.append(index)
        if variant:
            q += " AND variant=%s"
            args.append(variant)
        with self.pg._cursor() as cur:
            cur.execute(q + ' ORDER BY trade_date, "index", variant', args)
            return [{"trade_date": r[0].isoformat(), "index": r[1], "variant": r[2], **dict(zip(SUMMARY_COLS, r[3:]))}
                    for r in cur.fetchall()]

    def algo_days(self, from_day, to_day):
        """IST trading dates with any algo state or events in the range."""
        with self.pg._cursor() as cur:
            cur.execute("SELECT trade_date FROM algo_state WHERE trade_date BETWEEN %s AND %s UNION "
                        "SELECT trade_date FROM algo_events WHERE trade_date BETWEEN %s AND %s ORDER BY 1",
                        (from_day, to_day, from_day, to_day))
            return [r[0].isoformat() for r in cur.fetchall()]

    def order_levels(self, acc, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT order_id, symbol, expiry, trade_date, spot, levels_at, levels, zone_slot, zone_strike, "
                        "created_at FROM pt_order_levels WHERE account_id=%s AND trade_date=%s", (acc, day))
            rows = cur.fetchall()
        return [{"order_id": r[0], "symbol": r[1], "expiry": r[2].isoformat(), "date": r[3].isoformat(), "spot": r[4],
                 "levelsAt": r[5], "levels": r[6], "zone": {"slot": r[7], "strike": r[8]} if r[7] else None,
                 "created_at": r[9].astimezone(IST).isoformat()} for r in rows]

    def orders(self, acc, day):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT {', '.join(self._ORDER_COLS)} FROM pt_orders WHERE account_id=%s AND trade_date=%s "
                        "ORDER BY created_at, id", (acc, day))
            rows = [dict(zip(self._ORDER_COLS, r)) for r in cur.fetchall()]
        for o in rows:
            o["qty"] = o["lots"] * o["lot_size"]
            for k in ("created_at", "updated_at", "filled_at"):
                o[k] = o[k].astimezone(IST).isoformat() if o[k] else None
        return rows

    def trades(self, acc, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, order_id, security_id, side, qty, price, value, brokerage, stt, transaction, sebi, "
                        "stamp, gst, traded_at FROM pt_trades WHERE account_id=%s AND trade_date=%s "
                        "ORDER BY traded_at, id", (acc, day))
            out = []
            for r in cur.fetchall():
                charges = dict(zip(_CHARGE_FIELDS, r[7:13]))
                charges["total"] = round(sum(charges.values()), 2)
                out.append({"id": r[0], "order_id": r[1], "security_id": r[2], "side": r[3], "qty": r[4],
                            "price": r[5], "value": r[6], "charges": charges,
                            "time": r[13].astimezone(IST).isoformat()})
            return out

    def day_summary(self, acc, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute(
                "SELECT t.trade_date, COALESCE(p.realized, 0), t.charges, t.n FROM "
                "(SELECT trade_date, SUM(brokerage + stt + transaction + sebi + stamp + gst) AS charges, COUNT(*) AS n "
                " FROM pt_trades WHERE account_id=%s AND trade_date BETWEEN %s AND %s GROUP BY trade_date) t "
                "LEFT JOIN (SELECT trade_date, SUM(realized) AS realized FROM pt_positions WHERE account_id=%s "
                " GROUP BY trade_date) p ON p.trade_date = t.trade_date ORDER BY t.trade_date",
                (acc, from_day, to_day, acc))
            return [{"date": r[0].isoformat(), "realized": round(r[1], 2), "charges": round(r[2], 2), "trades": r[3]}
                    for r in cur.fetchall()]

    def net_before(self, acc, day):
        rows = self.day_summary(acc, "1900-01-01", day)
        return round(sum(r["realized"] - r["charges"] for r in rows if r["date"] < day), 2)

    def trades_between(self, acc, from_day, to_day):
        """Every fill of an account in a date range (same shape as trades(), plus "date"), oldest first."""
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, order_id, security_id, side, qty, price, value, brokerage, stt, transaction, sebi, "
                        "stamp, gst, traded_at, trade_date FROM pt_trades WHERE account_id=%s AND trade_date BETWEEN "
                        "%s AND %s ORDER BY traded_at, id", (acc, from_day, to_day))
            out = []
            for r in cur.fetchall():
                charges = dict(zip(_CHARGE_FIELDS, r[7:13]))
                charges["total"] = round(sum(charges.values()), 2)
                out.append({"id": r[0], "order_id": r[1], "security_id": r[2], "side": r[3], "qty": r[4],
                            "price": r[5], "value": r[6], "charges": charges,
                            "time": r[13].astimezone(IST).isoformat(), "date": r[14].isoformat()})
            return out

    def scalper_save_summary(self, row):
        cols = SCALPER_SUMMARY_COLS
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO scalper_daily_summary (account_id, trade_date, {', '.join(cols)}, updated_at, "
                        f"strategy_id) VALUES (%s, %s, {', '.join(['%s'] * len(cols))}, now(), (SELECT strategy_id FROM pt_accounts WHERE id=%s)) "
                        "ON CONFLICT (account_id, trade_date) DO UPDATE SET "
                        + ", ".join(f"{c}=EXCLUDED.{c}" for c in cols) + ", updated_at=now()",
                        (row["account_id"], row["trade_date"], *[row.get(c) for c in cols], row["account_id"]))

    def scalper_summaries(self, acc, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT account_id, trade_date, {', '.join(SCALPER_SUMMARY_COLS)} FROM scalper_daily_summary "
                        "WHERE account_id=%s AND trade_date BETWEEN %s AND %s ORDER BY trade_date", (acc, from_day, to_day))
            return [{"account_id": r[0], "trade_date": r[1].isoformat(), **dict(zip(SCALPER_SUMMARY_COLS, r[2:]))}
                    for r in cur.fetchall()]
