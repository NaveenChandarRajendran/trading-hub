"""
chain_cache.py - one shared, cached Dhan option chain per (symbol, expiry).

Every live page (and the Trending OI tracker) reads the chain through here, so opening three pages does not
triple the Dhan calls:
- a chain younger than the TTL is served from memory (10 s while the market is open, 5 min when closed);
- requests that arrive together for the same key wait for ONE fetch (per-key lock) instead of each calling Dhan;
- DhanClient still keeps option-chain calls >= 3.1 s apart on top of this.
If a refresh fails and an older chain exists, the older chain is served with the error attached (stale), so
pages keep showing the last good data. Failures are never cached: the next request tries again.
"""
import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime

from dhan_client import STRIKE_STEP, DhanError
from store import IST

TTL_OPEN_SECONDS = 10.0
TTL_CLOSED_SECONDS = 300.0

# Used only when Dhan's instrument list can't be read. NSE revises lot sizes; the instrument list is the source of truth.
FALLBACK_LOT_SIZE = {"NIFTY": 65, "BANKNIFTY": 30}


@dataclass
class Entry:
    chain: dict  # {"spot": float, "oc": {strike: {"ce": {...}|None, "pe": {...}|None}}} (dhan_client.parse_chain)
    fetched_at: datetime  # IST
    last_error: str = ""  # set when the latest refresh failed and this older chain is being served
    opening: tuple = None  # (time 'HH:MM:SS', {strike: (call oi, put oi)}) of the day's first chain, see OpeningOi
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)


class OpeningOi:
    """The day's first option chain at or after 09:15 per (symbol, expiry): Sensibull's "change in OI" counts from the
    09:15 OI, not from the previous day's settled OI (owner, 23-Oct-2026: the Sensibull view did not match). Kept in
    data/open_oi_YYYY-MM-DD.json so a restart keeps the morning baseline. If the backend starts late, the baseline is
    the first chain it saw (its time is shown)."""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self._day, self._snaps = None, {}
        self._lock = threading.Lock()

    def _path(self, day):
        return os.path.join(self.data_dir, f"open_oi_{day}.json")

    def _load(self, day):
        if self._day == day:
            return
        self._day, self._snaps = day, {}
        try:
            with open(self._path(day), encoding="utf-8") as f:
                raw = json.load(f)
            self._snaps = {k: (v["at"], {float(s): tuple(x) for s, x in v["oi"].items()}) for k, v in raw.items()}
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def get(self, symbol, expiry, now):
        with self._lock:
            self._load(now.strftime("%Y-%m-%d"))
            return self._snaps.get(f"{symbol}|{expiry}")

    def record(self, symbol, expiry, chain, now):
        """Keeps the first chain of the day (from 09:15) for this key; returns the kept snapshot."""
        if (now.hour, now.minute) < (9, 15):
            return None
        key = f"{symbol}|{expiry}"
        with self._lock:
            self._load(now.strftime("%Y-%m-%d"))
            if key in self._snaps:
                return self._snaps[key]
            oi = {float(k): (_oi(v.get("ce")), _oi(v.get("pe"))) for k, v in chain.get("oc", {}).items()}
            if not any(c or p for c, p in oi.values()):
                return None
            self._snaps[key] = (now.strftime("%H:%M:%S"), oi)
            try:
                os.makedirs(self.data_dir, exist_ok=True)
                tmp = self._path(self._day) + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({k: {"at": at, "oi": {str(s): list(x) for s, x in v.items()}} for k, (at, v) in self._snaps.items()}, f)
                os.replace(tmp, self._path(self._day))
            except OSError:
                pass  # kept in memory; tried again with the next new key
            return self._snaps[key]


def _oi(leg):
    try:
        return float((leg or {}).get("oi") or 0)
    except (TypeError, ValueError):
        return 0.0


class ChainCache:
    def __init__(self, client, market_open=lambda: True, clock=lambda: datetime.now(IST),
                 ttl_open=TTL_OPEN_SECONDS, ttl_closed=TTL_CLOSED_SECONDS, opening=None):
        self.opening = opening  # OpeningOi or None
        self.client = client
        self.market_open = market_open
        self.clock = clock
        self.ttl_open, self.ttl_closed = ttl_open, ttl_closed
        self._entries = {}  # (symbol, expiry) -> Entry
        self._key_locks = {}  # (symbol, expiry) -> Lock, so only one fetch per key runs at a time
        self._lock = threading.Lock()
        self.fetches = 0  # Dhan calls made through the cache (for /api/status and tests)

    def ttl(self):
        return self.ttl_open if self.market_open() else self.ttl_closed

    def _key_lock(self, key):
        with self._lock:
            return self._key_locks.setdefault(key, threading.Lock())

    def peek(self, symbol, expiry):
        with self._lock:
            return self._entries.get((symbol, expiry))

    def get(self, symbol, expiry, max_age=None, allow_stale=True):
        """Returns (entry, cached). max_age (seconds) overrides the TTL; 0 always fetches.
        allow_stale=False raises on a failed refresh instead of serving the older chain (the tracker must never
        record the same chain twice as if it were new)."""
        key = (symbol, expiry)
        max_age = self.ttl() if max_age is None else max_age
        with self._key_lock(key):  # concurrent callers for the same key queue here and reuse the first fetch
            old = self.peek(symbol, expiry)
            if old and max_age > 0 and (self.clock() - old.fetched_at).total_seconds() < max_age:
                return old, True
            try:
                self.fetches += 1
                chain = self.client.option_chain(symbol, expiry)
            except DhanError as e:
                if old is None or not allow_stale:
                    raise
                stale = Entry(old.chain, old.fetched_at, last_error=str(e), opening=old.opening)
                with self._lock:
                    self._entries[key] = stale
                return stale, True
            now = self.clock()
            entry = Entry(chain, now)
            if self.opening is not None:
                try:
                    entry.opening = (self.opening.record(symbol, expiry, chain, now) if self.market_open()
                                     else self.opening.get(symbol, expiry, now))
                except Exception:
                    entry.opening = None
            with self._lock:
                self._entries[key] = entry
            return entry, False


def strike_rows(chain, opening=None):
    """Dhan's oc map -> [{"strike": 23000.0, "ce": {...raw Dhan leg...} | None, "pe": ...}] ascending. With the day's
    opening snapshot, each leg also gets "open_oi" (its OI at that time; a strike missing then gets none)."""
    out = []
    for k, v in sorted(chain["oc"].items()):
        ce, pe = v["ce"], v["pe"]
        o = opening.get(float(k)) if opening else None
        if o is not None:
            ce = {**ce, "open_oi": o[0]} if ce else ce
            pe = {**pe, "open_oi": o[1]} if pe else pe
        out.append({"strike": k, "ce": ce, "pe": pe})
    return out


def chain_response(symbol, expiry, entry, cached, lot_size, now, market_open, token_expired):
    """Body of GET /api/option-chain. Leg fields are Dhan's own (oi, previous_oi, last_price, ...), in units."""
    if token_expired:
        message = "Dhan token expired. Send a new one to the backend (POST /api/token)."
    elif entry.last_error:
        message = "Showing the last good data; the latest Dhan refresh failed."
    elif not market_open:
        message = "Market is closed. Showing the last session's data."
    else:
        message = ""
    return {
        "meta": {
            "symbol": symbol, "expiry": expiry, "spot": entry.chain["spot"],
            "lotSize": lot_size, "strikeStep": STRIKE_STEP.get(symbol),
            "asOf": entry.fetched_at.strftime("%Y-%m-%d %H:%M:%S"),
            "ageSeconds": round(max(0.0, (now - entry.fetched_at).total_seconds()), 1),
            "cached": cached, "stale": bool(entry.last_error),
            "marketOpen": market_open, "tokenExpired": token_expired,
            "lastError": entry.last_error, "message": message,
            # Sensibull-style change in OI counts from this snapshot (legs carry "open_oi"); None = not recorded today
            "openOiAt": entry.opening[0] if entry.opening else None,
        },
        "rows": strike_rows(entry.chain, entry.opening[1] if entry.opening else None),
    }
