"""
toi_algo_store.py - the Trending OI Algo's records: decision log, state per day, evaluated candles, daily summary and
the page's settings (tables toi_algo_*, schema.sql; settings in the shared th_algo_settings, algo_settings.py). PgToiStore is the live one (Postgres is the source of truth, as
for the OI breakout algo); MemoryToiStore has the same methods for tests and JSON-only setups (nothing survives a
restart there).
"""
import copy
import json
from datetime import datetime

from algo_settings import MemorySettings, PgSettings
from store import IST

SLUG = "trending-oi"


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


class MemoryToiStore:
    def __init__(self):
        self._events, self._states, self._candles, self._summaries = [], {}, {}, {}
        self.settings_store = MemorySettings()

    def add_event(self, ev):
        self._events.append({**copy.deepcopy(ev), "id": len(self._events) + 1})

    def events(self, day):
        return [dict(e) for e in self._events if e["day"] == day]

    def settings_history(self, limit=100):
        return self.settings_store.history(SLUG, limit)

    def save_state(self, day, state, now):
        self._states[day] = copy.deepcopy(state)

    def state(self, day):
        return copy.deepcopy(self._states.get(day))

    def states_between(self, from_day, to_day):
        return {d: copy.deepcopy(st) for d, st in sorted(self._states.items()) if from_day <= d <= to_day}

    def save_candle(self, row):
        self._candles[(row["day"], row["start"])] = dict(row)

    def candles(self, day):
        return sorted((dict(r) for (d, _), r in self._candles.items() if d == day), key=lambda r: r["start"])

    def save_summary(self, row):
        self._summaries[row["day"]] = dict(row)

    def summaries(self, from_day, to_day):
        return [dict(r) for d, r in sorted(self._summaries.items()) if from_day <= d <= to_day]

    def settings(self):
        return self.settings_store.overrides(SLUG)

    def save_settings(self, settings, now, changes=None, who=""):
        self.settings_store.save(SLUG, settings, changes or {}, who, now)


class PgToiStore:
    """On the backend's Postgres pool (store.PgStore._cursor)."""

    def __init__(self, pg):
        self.pg = pg
        self.settings_store = PgSettings(pg)

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

    def settings_history(self, limit=100):
        return self.settings_store.history(SLUG, limit)

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

    def states_between(self, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT trade_date, state FROM toi_algo_state WHERE trade_date BETWEEN %s AND %s ORDER BY trade_date",
                        (from_day, to_day))
            return {_iso(r[0]): r[1] for r in cur.fetchall()}

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
        return self.settings_store.overrides(SLUG)

    def save_settings(self, settings, now, changes=None, who=""):
        self.settings_store.save(SLUG, settings, changes or {}, who, now)
