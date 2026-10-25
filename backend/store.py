"""
store.py - where the per-minute snapshots live.

PgStore   : Postgres (use this). Survives backend restarts, PC shutdowns and page refreshes.
JsonStore : one JSON file per day in ./data (fallback when DATABASE_URL is not set, and for tests).

Both expose the same methods used by tracker.py:
    load(symbol, expiry, date)  -> (strikes, snaps)      date = 'YYYY-MM-DD' (IST trading day)
    last_day(symbol, expiry, before) -> latest recorded date before `before`, or None
    save(symbol, expiry, date, strikes, new_snaps, all_snaps)
    active_keys(date)           -> [(symbol, expiry), ...] tracked on that day
A snapshot is a dict: ts ('YYYY-MM-DD HH:MM' IST), spot, strikes_used, call_chg, put_chg,
call_ltp, put_ltp, call_ltp_chg, put_ltp_chg.
"""
import glob
import json
import logging
import os
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

    def last_day(self, symbol, expiry, before):
        days = [os.path.basename(p)[:-5].rsplit("_", 1)[1] for p in glob.glob(os.path.join(self.data_dir, f"{symbol}_{expiry}_*.json"))]
        days = [d for d in days if len(d) == 10 and d < before]
        return max(days) if days else None

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

    def last_day(self, symbol, expiry, before):
        with self._cursor() as cur:
            cur.execute("SELECT max(trade_date) FROM toi_session WHERE symbol=%s AND expiry=%s AND trade_date < %s",
                        (symbol, expiry, before))
            row = cur.fetchone()
        return str(row[0]) if row and row[0] else None

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


class PaperJsonStore:
    """Everything in one file, data/paper.json, rewritten on every change (fine for one person's trades)."""
    kind = "json"

    def __init__(self, data_dir="data"):
        os.makedirs(data_dir, exist_ok=True)
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

    def active_account(self):
        a = next((a for a in reversed(self.d["accounts"]) if not a["archived_at"]), None)
        return dict(a) if a else None

    def accounts(self):
        return [dict(a) for a in self.d["accounts"]]

    def create_account(self, capital, now):
        a = {"id": len(self.d["accounts"]) + 1, "capital": float(capital), "created_at": now.isoformat(),
             "archived_at": None}
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
                   "avg_price", "slippage_capped", "reason", "blocked", "created_at", "updated_at", "filled_at")

    def __init__(self, pg):
        self.pg = pg

    @staticmethod
    def _account(r):
        return {"id": r[0], "capital": r[1], "created_at": r[2].astimezone(IST).isoformat(),
                "archived_at": r[3].astimezone(IST).isoformat() if r[3] else None}

    def active_account(self):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, capital, created_at, archived_at FROM pt_accounts WHERE archived_at IS NULL "
                        "ORDER BY id DESC LIMIT 1")
            r = cur.fetchone()
        return self._account(r) if r else None

    def accounts(self):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, capital, created_at, archived_at FROM pt_accounts ORDER BY id")
            return [self._account(r) for r in cur.fetchall()]

    def create_account(self, capital, now):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO pt_accounts (capital, created_at) VALUES (%s, %s) "
                        "RETURNING id, capital, created_at, archived_at", (float(capital), now))
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
                        (acc, day, *[o[c] for c in cols]))

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
