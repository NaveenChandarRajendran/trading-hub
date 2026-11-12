"""
toi_algo_store.py - the Trending OI Algo's records: decision log, state per day, evaluated candles, daily summary and
the page's settings (tables toi_algo_*, schema.sql). PgToiStore is the live one (Postgres is the source of truth, as
for the OI breakout algo); MemoryToiStore has the same methods for tests and JSON-only setups (nothing survives a
restart there).
"""
import copy
import json
from datetime import datetime

from store import IST


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


class MemoryToiStore:
    def __init__(self):
        self._events, self._states, self._candles, self._summaries, self._settings = [], {}, {}, {}, None

    def add_event(self, ev):
        self._events.append({**copy.deepcopy(ev), "id": len(self._events) + 1})

    def events(self, day):
        return [dict(e) for e in self._events if e["day"] == day]

    def save_state(self, day, state, now):
        self._states[day] = copy.deepcopy(state)

    def state(self, day):
        return copy.deepcopy(self._states.get(day))

    def save_candle(self, row):
        self._candles[(row["day"], row["start"])] = dict(row)

    def candles(self, day):
        return sorted((dict(r) for (d, _), r in self._candles.items() if d == day), key=lambda r: r["start"])

    def save_summary(self, row):
        self._summaries[row["day"]] = dict(row)

    def summaries(self, from_day, to_day):
        return [dict(r) for d, r in sorted(self._summaries.items()) if from_day <= d <= to_day]

    def settings(self):
        return copy.deepcopy(self._settings) or {}

    def save_settings(self, settings, now):
        self._settings = copy.deepcopy(settings)


class PgToiStore:
    """On the backend's Postgres pool (store.PgStore._cursor)."""

    def __init__(self, pg):
        self.pg = pg

    def add_event(self, ev):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO toi_algo_events (trade_date, ts, type, side, message, details) VALUES (%s, %s, %s, %s, %s, %s)",
                        (ev["day"], ev["ts"], ev["type"], ev.get("side"), ev["message"], json.dumps(ev.get("details") or {})))

    def events(self, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, trade_date, ts, type, side, message, details FROM toi_algo_events WHERE trade_date=%s "
                        "ORDER BY id", (day,))
            return [{"id": r[0], "day": _iso(r[1]), "ts": r[2].astimezone(IST).isoformat(), "type": r[3], "side": r[4],
                     "message": r[5], "details": r[6] or {}} for r in cur.fetchall()]

    def save_state(self, day, state, now):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO toi_algo_state (trade_date, state, updated_at) VALUES (%s, %s, %s) "
                        "ON CONFLICT (trade_date) DO UPDATE SET state=EXCLUDED.state, updated_at=EXCLUDED.updated_at",
                        (day, json.dumps(state), now))

    def state(self, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT state FROM toi_algo_state WHERE trade_date=%s", (day,))
            r = cur.fetchone()
            return r[0] if r else None

    COLS = ("open", "high", "low", "close", "supertrend", "st_up", "vwap", "vwap_future", "basis", "rsi", "toi_strength",
            "toi_sentiment", "no_trade")

    def save_candle(self, row):
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO toi_algo_candles (trade_date, candle_start, {', '.join(self.COLS)}) VALUES "
                        f"(%s, %s, {', '.join(['%s'] * len(self.COLS))}) ON CONFLICT (trade_date, candle_start) DO UPDATE SET "
                        + ", ".join(f"{c}=EXCLUDED.{c}" for c in self.COLS),
                        (row["day"], datetime.fromtimestamp(row["start"], IST), *(row.get(c) for c in self.COLS)))

    def candles(self, day):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT candle_start, {', '.join(self.COLS)} FROM toi_algo_candles WHERE trade_date=%s ORDER BY candle_start",
                        (day,))
            return [{"day": day, "start": int(r[0].timestamp()), **dict(zip(self.COLS, r[1:]))} for r in cur.fetchall()]

    SUM = ("trades", "wins", "losses", "adds", "partials", "gross_pnl", "charges", "net_pnl")

    def save_summary(self, row):
        with self.pg._cursor() as cur:
            cur.execute(f"INSERT INTO toi_algo_daily_summary (trade_date, {', '.join(self.SUM)}, updated_at) VALUES "
                        f"(%s, {', '.join(['%s'] * len(self.SUM))}, %s) ON CONFLICT (trade_date) DO UPDATE SET "
                        + ", ".join(f"{c}=EXCLUDED.{c}" for c in (*self.SUM, "updated_at")),
                        (row["day"], *(row[c] for c in self.SUM), row["updated_at"]))

    def summaries(self, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT trade_date, {', '.join(self.SUM)} FROM toi_algo_daily_summary WHERE trade_date BETWEEN %s AND %s "
                        "ORDER BY trade_date", (from_day, to_day))
            return [{"day": _iso(r[0]), **dict(zip(self.SUM, r[1:]))} for r in cur.fetchall()]

    def settings(self):
        with self.pg._cursor() as cur:
            cur.execute("SELECT settings FROM toi_algo_settings WHERE id=1")
            r = cur.fetchone()
            return r[0] if r else {}

    def save_settings(self, settings, now):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO toi_algo_settings (id, settings, updated_at) VALUES (1, %s, %s) "
                        "ON CONFLICT (id) DO UPDATE SET settings=EXCLUDED.settings, updated_at=EXCLUDED.updated_at",
                        (json.dumps(settings), now))
