"""
store.py - where the per-minute snapshots live.

PgStore   : Postgres (use this). Survives backend restarts, PC shutdowns and page refreshes.
JsonStore : one JSON file per day in ./data (fallback when DATABASE_URL is not set, and for tests).

Both expose the same four methods used by tracker.py:
    load(symbol, expiry, date)  -> (strikes, snaps)      date = 'YYYY-MM-DD' (IST trading day)
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
