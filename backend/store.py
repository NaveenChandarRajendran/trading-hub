"""
store.py - where the per-minute snapshots live.

PgStore   : Postgres (use this). Survives backend restarts, PC shutdowns and page refreshes.
JsonStore : one JSON file per day in ./data (fallback when DATABASE_URL is not set, and for tests).

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
        with self._cursor() as cur:
            cur.execute("INSERT INTO option_chain_snapshot (symbol, expiry, trade_date, ts, spot, snap) "
                        "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (symbol, expiry, ts) DO UPDATE SET spot=EXCLUDED.spot, "
                        "snap=EXCLUDED.snap", (symbol, expiry, date, snap["ts"], snap["spot"], json.dumps(snap)))

    def chain_snapshots(self, symbol, expiry, date):
        with self._cursor() as cur:
            cur.execute("SELECT snap FROM option_chain_snapshot WHERE symbol=%s AND expiry=%s AND trade_date=%s "
                        "ORDER BY ts", (symbol, expiry, date))
            return [r[0] for r in cur.fetchall()]

    def chain_snapshot_expiries(self, symbol, date):
        with self._cursor() as cur:
            cur.execute("SELECT DISTINCT expiry FROM option_chain_snapshot WHERE symbol=%s AND trade_date=%s ORDER BY 1",
                        (symbol, date))
            return [r[0].isoformat() for r in cur.fetchall()]

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
    """Everything in one file, data/paper.json, rewritten on every change (fine for one person's trades)."""
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

    def create_account(self, capital, now, name=None):
        a = {"id": len(self.d["accounts"]) + 1, "capital": float(capital), "created_at": now.isoformat(),
             "archived_at": None, "name": name}
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

    # ---- OI breakout algo (algo_service.py)
    def algo_add_event(self, day, ev):
        self.d.setdefault("algo_events", {}).setdefault(day, []).append(ev)
        self._write()

    def algo_events(self, day):
        return list(self.d.get("algo_events", {}).get(day, []))

    def algo_save_state(self, day, symbol, state):
        self.d.setdefault("algo_state", {}).setdefault(day, {})[symbol] = state
        self._write()

    def algo_states(self, day):
        return dict(self.d.get("algo_state", {}).get(day, {}))

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


class PaperPgStore:
    """Paper trading tables (pt_*) in Postgres, sharing PgStore's connection pool and schema.sql."""
    kind = "postgres"
    _ORDER_COLS = ("id", "security_id", "side", "order_type", "lots", "lot_size", "price", "trigger_price", "status",
                   "avg_price", "slippage_capped", "reason", "blocked", "created_at", "updated_at", "filled_at",
                   "source", "setup")
    _ORDER_DEFAULTS = {"source": "manual", "setup": ""}

    def __init__(self, pg):
        self.pg = pg

    @staticmethod
    def _account(r):
        return {"id": r[0], "capital": r[1], "created_at": r[2].astimezone(IST).isoformat(),
                "archived_at": r[3].astimezone(IST).isoformat() if r[3] else None, "name": r[4]}

    def active_account(self, name=None):
        """name None: the manual Paper Trading account; "Algo": the algo's."""
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, capital, created_at, archived_at, name FROM pt_accounts WHERE archived_at IS NULL "
                        "AND name IS NOT DISTINCT FROM %s ORDER BY id DESC LIMIT 1", (name,))
            r = cur.fetchone()
        return self._account(r) if r else None

    def accounts(self):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, capital, created_at, archived_at, name FROM pt_accounts ORDER BY id")
            return [self._account(r) for r in cur.fetchall()]

    def create_account(self, capital, now, name=None):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_accounts (capital, created_at, name) VALUES (%s, %s, %s) "
                        "RETURNING id, capital, created_at, archived_at, name", (float(capital), now, name))
            return self._account(cur.fetchone())

    def archive_account(self, acc, now):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE pt_accounts SET archived_at=%s WHERE id=%s", (now, acc))

    def set_capital(self, acc, capital):
        with self.pg._cursor() as cur:
            cur.execute("UPDATE pt_accounts SET capital=%s WHERE id=%s", (float(capital), acc))

    def save_order(self, acc, day, o):
        cols = self._ORDER_COLS
        updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c not in ("id", "created_at"))
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO pt_orders (account_id, trade_date, {', '.join(cols)}) "
                        f"VALUES (%s, %s, {', '.join(['%s'] * len(cols))}) "
                        f"ON CONFLICT (account_id, id) DO UPDATE SET {updates}",
                        (acc, day, *[o.get(c, self._ORDER_DEFAULTS.get(c)) for c in cols]))

    def save_trade(self, acc, day, t):
        c = t["charges"]
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_trades (account_id, id, order_id, trade_date, security_id, side, qty, price, "
                        "value, brokerage, stt, transaction, sebi, stamp, gst, traded_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                        (acc, t["id"], t["order_id"], day, t["security_id"], t["side"], t["qty"], t["price"],
                         t["value"], *[c[k] for k in _CHARGE_FIELDS], t["time"]))

    def save_position(self, acc, day, p):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_positions (account_id, trade_date, security_id, lot_size, buy_qty, sell_qty, "
                        "avg_buy, avg_sell, realized) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "ON CONFLICT (account_id, trade_date, security_id) DO UPDATE SET lot_size=EXCLUDED.lot_size, "
                        "buy_qty=EXCLUDED.buy_qty, sell_qty=EXCLUDED.sell_qty, avg_buy=EXCLUDED.avg_buy, "
                        "avg_sell=EXCLUDED.avg_sell, realized=EXCLUDED.realized",
                        (acc, day, p["security_id"], p["lot_size"], p["buy_qty"], p["sell_qty"], p["avg_buy"],
                         p["avg_sell"], p["realized"]))

    def save_order_levels(self, acc, day, r):
        z = r["zone"] or {}
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_order_levels (account_id, order_id, trade_date, symbol, expiry, spot, levels_at, "
                        "levels, zone_slot, zone_strike, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "ON CONFLICT (account_id, order_id) DO NOTHING",
                        (acc, r["order_id"], day, r["symbol"], r["expiry"], r["spot"], r["levelsAt"],
                         json.dumps(r["levels"]), z.get("slot"), z.get("strike"), r["created_at"]))

    # ---- OI breakout algo (algo_service.py)
    def algo_add_event(self, day, ev):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO algo_events (trade_date, at, symbol, setup, kind, message, data) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s)", (day, ev["at"], ev["symbol"], ev.get("setup", ""), ev["kind"],
                                                         ev["message"], json.dumps(ev.get("data", {}))))

    def algo_events(self, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT at, symbol, setup, kind, message, data FROM algo_events WHERE trade_date=%s ORDER BY id",
                        (day,))
            return [{"at": r[0].astimezone(IST).isoformat(), "symbol": r[1], "setup": r[2], "kind": r[3],
                     "message": r[4], "data": r[5]} for r in cur.fetchall()]

    def algo_save_state(self, day, symbol, state):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO algo_state (trade_date, symbol, state, updated_at) VALUES (%s,%s,%s,now()) "
                        "ON CONFLICT (trade_date, symbol) DO UPDATE SET state=EXCLUDED.state, updated_at=now()",
                        (day, symbol, json.dumps(state)))

    def algo_states(self, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT symbol, state FROM algo_state WHERE trade_date=%s", (day,))
            return {r[0]: r[1] for r in cur.fetchall()}

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
