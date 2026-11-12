"""
algo_settings.py - editable settings of every algo (the Algos hub's Settings tab). PAPER TRADING ONLY.

Defaults stay in each algo's config file. Overrides live in th_algo_settings (one row per algo slug), and every change
is logged in th_algo_settings_log (key, old -> new, time, user). New decisions read the merged values at once; an open
trade keeps the stop and lots it was opened with (each algo stores those on the trade).

A field: {key, label, group, kind, default, min?, max?, choices?, readOnly?, help?}
  kind  number | int | time ("HH:MM") | bool | list (a subset of choices) | text (read-only info)
"""
import copy
import json
import re

TIME = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


def check(fields, changes):
    """Validated copy of changes {key: value}; ValueError with a readable message on the first bad value."""
    spec = {f["key"]: f for f in fields}
    out = {}
    for k, v in changes.items():
        f = spec.get(k)
        if f is None:
            raise ValueError(f"unknown setting {k}")
        name = f["label"]
        if f.get("readOnly"):
            raise ValueError(f"{name} is fixed (set in code)")
        kind = f["kind"]
        if kind == "bool":
            if not isinstance(v, bool):
                raise ValueError(f"{name}: on or off")
        elif kind == "time":
            if not isinstance(v, str) or not TIME.fullmatch(v):
                raise ValueError(f"{name}: a time like 09:45")
        elif kind == "list":
            if not isinstance(v, list) or not set(v) <= set(f.get("choices") or []):
                raise ValueError(f"{name}: a list of {', '.join(f.get('choices') or [])}")
        elif kind in ("number", "int"):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"{name}: a number")
            if kind == "int":
                if v != int(v):
                    raise ValueError(f"{name}: a whole number")
                v = int(v)
            lo, hi = f.get("min", 0), f.get("max")
            if v < lo or (hi is not None and v > hi):
                raise ValueError(f"{name}: from {lo:g}" + (f" to {hi:g}" if hi is not None else " up"))
        else:
            raise ValueError(f"{name} can't be changed here")
        if f.get("choices") and kind != "list" and v not in f["choices"]:
            raise ValueError(f"{name}: one of {', '.join(str(c) for c in f['choices'])}")
        out[k] = v
    return out


class MemorySettings:
    """Same methods as PgSettings, for tests and JSON-only setups (nothing survives a restart)."""

    def __init__(self):
        self._over, self._log = {}, []

    def overrides(self, slug):
        return copy.deepcopy(self._over.get(slug, {}))

    def save(self, slug, overrides, changes, who, now):
        self._over[slug] = copy.deepcopy(overrides)
        for k, (old, new) in changes.items():
            self._log.append({"id": len(self._log) + 1, "slug": slug, "ts": now.isoformat(), "key": k, "old": old,
                              "new": new, "user": who or ""})

    def history(self, slug, limit=100):
        return [dict(r) for r in reversed(self._log) if r["slug"] == slug][:limit]


class PgSettings:
    """th_algo_settings / th_algo_settings_log on the backend's Postgres pool (store.PgStore._cursor)."""

    def __init__(self, pg):
        self.pg = pg

    def overrides(self, slug):
        with self.pg._cursor() as cur:
            cur.execute("SELECT overrides FROM th_algo_settings WHERE slug=%s", (slug,))
            r = cur.fetchone()
            return r[0] if r else {}

    def save(self, slug, overrides, changes, who, now):
        with self.pg._cursor() as cur:
            cur.execute("INSERT INTO th_algo_settings (slug, overrides, updated_at, updated_by) VALUES (%s,%s,%s,%s) "
                        "ON CONFLICT (slug) DO UPDATE SET overrides=EXCLUDED.overrides, updated_at=EXCLUDED.updated_at, "
                        "updated_by=EXCLUDED.updated_by", (slug, json.dumps(overrides), now, who or ""))
            for k, (old, new) in changes.items():
                cur.execute("INSERT INTO th_algo_settings_log (slug, ts, key, old_value, new_value, changed_by) "
                            "VALUES (%s,%s,%s,%s,%s,%s)", (slug, now, k, json.dumps(old), json.dumps(new), who or ""))

    def history(self, slug, limit=100):
        with self.pg._cursor() as cur:
            cur.execute("SELECT id, ts, key, old_value, new_value, changed_by FROM th_algo_settings_log WHERE slug=%s "
                        "ORDER BY id DESC LIMIT %s", (slug, limit))
            return [{"id": r[0], "slug": slug, "ts": r[1].isoformat(), "key": r[2], "old": r[3], "new": r[4], "user": r[5]}
                    for r in cur.fetchall()]


class AlgoSettings:
    """One algo's settings: fields + the store. cross(values) -> error text or None checks fields together."""

    def __init__(self, store, slug, fields, cross=None):
        self.store, self.slug, self.fields, self.cross = store, slug, fields, cross
        self.defaults = {f["key"]: f["default"] for f in fields}

    def values(self):
        """Defaults with the saved overrides (unknown or fixed keys in the table are ignored)."""
        editable = {f["key"] for f in self.fields if not f.get("readOnly")}
        return {**self.defaults, **{k: v for k, v in self.store.overrides(self.slug).items() if k in editable}}

    def change(self, changes, who, now):
        """Validates, saves and logs. Returns {key: (old, new)} of the values that really changed."""
        clean = check(self.fields, changes)
        cur = self.values()
        diff = {k: (cur[k], v) for k, v in clean.items() if cur[k] != v}
        if not diff:
            return {}
        new = {**cur, **clean}
        err = self.cross(new) if self.cross else None
        if err:
            raise ValueError(err)
        overrides = {k: v for k, v in {**self.store.overrides(self.slug), **clean}.items() if k in self.defaults}
        self.store.save(self.slug, overrides, diff, who, now)
        return diff

    def view(self, note=""):
        cur = self.values()
        return {"editable": any(not f.get("readOnly") for f in self.fields),
                "fields": [{**{k: v for k, v in f.items() if k != "default"}, "value": cur[f["key"]], "default": f["default"]}
                           for f in self.fields],
                "history": self.store.history(self.slug), "note": note}
