"""
orb_store.py - the ORB Algo's records: decision log (orb_algo_events), the state per day (orb_algo_state) and the daily
summary per setup (orb_algo_daily_summary), schema.sql. Settings: the shared th_algo_settings (algo_settings.py, slug
"orb"). PgOrbStore is the live one; MemoryOrbStore has the same methods for tests (nothing survives a restart there).
"""
import copy
import json

from algo_settings import MemorySettings, PgSettings
from store import IST

SUM = ("trades", "wins", "losses", "points", "gross_pnl", "charges", "net_pnl")


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


class MemoryOrbStore:
    def __init__(self):
        self._events, self._states, self._summaries = [], {}, {}
        self.settings_store = MemorySettings()

    def add_event(self, ev):
        self._events.append({**copy.deepcopy(ev), "id": len(self._events) + 1})

    def events(self, day):
        return [dict(e) for e in self._events if e["day"] == day]

    def save_state(self, day, state, now):
        self._states[day] = copy.deepcopy(state)

    def state(self, day):
        return copy.deepcopy(self._states.get(day))

    def states_between(self, from_day, to_day):
        return {d: copy.deepcopy(st) for d, st in sorted(self._states.items()) if from_day <= d <= to_day}

    def save_summary(self, rows):
        for r in rows:
            self._summaries[(r["day"], r["setup"])] = dict(r)

    def summaries(self, from_day, to_day):
        return [dict(r) for (d, _s), r in sorted(self._summaries.items()) if from_day <= d <= to_day]


class PgOrbStore:
    def __init__(self, pg):
        self.pg = pg
        self.settings_store = PgSettings(pg)

    def add_event(self, ev):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO orb_algo_events (trade_date, ts, type, setup, side, message, details) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (ev["day"], ev["ts"], ev["type"], ev.get("setup") or "", ev.get("side"), ev["message"],
                         json.dumps(ev.get("details") or {}, default=str)))

    def events(self, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, trade_date, ts, type, setup, side, message, details FROM orb_algo_events "
                        "WHERE trade_date=%s ORDER BY id", (day,))
            return [{"id": r[0], "day": _iso(r[1]), "ts": r[2].astimezone(IST).isoformat(), "type": r[3], "setup": r[4],
                     "side": r[5], "message": r[6], "details": r[7] or {}} for r in cur.fetchall()]

    def save_state(self, day, state, now):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO orb_algo_state (trade_date, state, updated_at) VALUES (%s, %s, %s) "
                        "ON CONFLICT (trade_date) DO UPDATE SET state=EXCLUDED.state, updated_at=EXCLUDED.updated_at",
                        (day, json.dumps(state, default=str), now))

    def state(self, day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT state FROM orb_algo_state WHERE trade_date=%s", (day,))
            r = cur.fetchone()
            return r[0] if r else None

    def states_between(self, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute("SELECT trade_date, state FROM orb_algo_state WHERE trade_date BETWEEN %s AND %s ORDER BY trade_date",
                        (from_day, to_day))
            return {_iso(r[0]): r[1] for r in cur.fetchall()}

    def save_summary(self, rows):
        with self.pg._cursor() as cur:
            for r in rows:
                cur.execute(f"INSERT INTO orb_algo_daily_summary (trade_date, setup, {', '.join(SUM)}, updated_at) VALUES "
                            f"(%s, %s, {', '.join(['%s'] * len(SUM))}, %s) ON CONFLICT (trade_date, setup) DO UPDATE SET "
                            + ", ".join(f"{c}=EXCLUDED.{c}" for c in (*SUM, "updated_at")),
                            (r["day"], r["setup"], *(r[c] for c in SUM), r["updated_at"]))

    def summaries(self, from_day, to_day):
        with self.pg._cursor() as cur:
            cur.execute(f"SELECT trade_date, setup, {', '.join(SUM)} FROM orb_algo_daily_summary "
                        "WHERE trade_date BETWEEN %s AND %s ORDER BY trade_date, setup", (from_day, to_day))
            return [{"day": _iso(r[0]), "setup": r[1], **dict(zip(SUM, r[2:]))} for r in cur.fetchall()]
