"""
tracker.py - polls Dhan once a minute (at hh:mm:03) for every tracked (symbol, expiry) and keeps
one small snapshot per minute for the day. Any interval (1/3/5/15 min ...) is then just a filter.

Every snapshot is written to the store (Postgres, or JSON files as a fallback), so a restart, a PC shutdown or a
page refresh never loses rows. If a write fails the row is kept in memory and retried on the next poll.
The strike set (ATM +/- N) is fixed from the FIRST snapshot of the day and never changes.
"""
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from calc import pick_strikes, summarize
from chain_cache import ChainCache
from dhan_client import STRIKE_STEP, DhanError
from holidays import NSE_HOLIDAYS
from store import IST, JsonStore

log = logging.getLogger("tracker")


def now_ist():
    return datetime.now(IST)


@dataclass
class DayData:
    symbol: str
    expiry: str
    date: str
    strikes: list = field(default_factory=list)
    snaps: list = field(default_factory=list)
    last_ok: str = ""
    last_error: str = ""
    unsaved: list = field(default_factory=list)  # snapshots whose store write failed; retried on the next poll


class Tracker:
    def __init__(self, client, store=None, data_dir="data", each_side=7, force=False,
                 session=((9, 15), (15, 40)), max_keys=8, clock=now_ist):
        self.client = client
        self.store = store or JsonStore(data_dir)
        self.each_side = each_side
        self.force = force  # poll even when the market is closed (testing on weekends)
        self.session = session
        self.max_keys = max_keys
        self.clock = clock
        # Shared with GET /api/option-chain: every fetch the tracker makes also refreshes the live pages' cache.
        self.chains = ChainCache(client, market_open=self.market_open, clock=clock)
        self._days = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None

    # ---------------------------------------------------------- lifecycle
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="tracker", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    # ------------------------------------------------------------ helpers
    def market_open(self, now=None):
        now = now or self.clock()
        if now.weekday() >= 5 or now.strftime("%Y-%m-%d") in NSE_HOLIDAYS:
            return False
        hm = (now.hour, now.minute)
        return self.session[0] <= hm <= self.session[1]

    def _in_session(self, ts):
        """ts is 'YYYY-MM-DD HH:MM'."""
        return self.session[0] <= (int(ts[11:13]), int(ts[14:16])) <= self.session[1]

    def _load(self, symbol, expiry):
        today = self.clock().strftime("%Y-%m-%d")
        strikes, snaps = self.store.load(symbol, expiry, today)  # raises if the database is unreachable
        if not self.force:  # drop rows recorded outside the session (e.g. from an earlier --force run)
            snaps = [x for x in snaps if self._in_session(x["ts"])]
        return DayData(symbol, expiry, today, strikes, snaps)

    def restore_today(self):
        """Resume tracking everything that was tracked earlier today (e.g. after a backend restart)."""
        today = self.clock().strftime("%Y-%m-%d")
        for symbol, expiry in self.store.active_keys(today):
            try:
                self.register(symbol, expiry)
            except Exception as e:
                log.warning("could not restore %s %s: %s", symbol, expiry, e)

    # ---------------------------------------------------------- public API
    def register(self, symbol, expiry):
        """Start tracking (symbol, expiry) if not already. Returns the key."""
        key = (symbol, expiry)
        with self._lock:
            if key in self._days:
                return key
            if len(self._days) >= self.max_keys:
                raise ValueError(f"already tracking {self.max_keys} expiries")
        day = self._load(symbol, expiry)  # database read, done without holding the lock
        with self._lock:
            self._days.setdefault(key, day)
        self._wake.set()  # fetch the first snapshot right away
        return key

    def view(self, key):
        """Thread-safe copy of what the API needs."""
        with self._lock:
            d = self._days[key]
            return {
                "date": d.date, "strikes": list(d.strikes), "snaps": list(d.snaps),
                "last_ok": d.last_ok, "last_error": d.last_error, "tracking": len(self._days),
            }

    # ------------------------------------------------------------- polling
    def poll_key(self, key, now=None):
        """Fetch one snapshot for key and store it. Raises DhanError on failure."""
        now = now or self.clock()
        symbol, expiry = key
        today = now.strftime("%Y-%m-%d")
        with self._lock:
            d = self._days[key]
            if d.date != today:  # new trading day: forget yesterday
                d.date, d.strikes, d.snaps, d.unsaved = today, [], [], []
            have_strikes = list(d.strikes)

        # Always a fresh fetch (max_age=0) and never an older chain on failure, exactly as before the shared cache.
        chain = self.chains.get(symbol, expiry, max_age=0, allow_stale=False)[0].chain  # network call, no lock held
        spot, oc = chain["spot"], chain["oc"]
        strikes = have_strikes or pick_strikes(oc.keys(), spot, STRIKE_STEP[symbol], self.each_side)
        totals, used = summarize(oc, strikes)
        snap = {"ts": now.strftime("%Y-%m-%d %H:%M"), "spot": spot, "strikes_used": used, **totals}

        with self._lock:
            d = self._days[key]
            d.strikes = strikes
            if d.snaps and d.snaps[-1]["ts"] == snap["ts"]:
                d.snaps[-1] = snap
            else:
                d.snaps.append(snap)
            d.last_ok, d.last_error = now.isoformat(timespec="seconds"), ""
            pending, d.unsaved = d.unsaved + [snap], []
            date, all_snaps, strikes_now = d.date, list(d.snaps), list(d.strikes)

        try:  # network/disk call without holding the lock
            self.store.save(symbol, expiry, date, strikes_now, pending, all_snaps)
        except Exception as e:  # keep serving from memory and retry next minute
            log.warning("store write failed for %s %s: %s", symbol, expiry, e)
            with self._lock:
                d.unsaved = pending + d.unsaved
                d.last_error = f"Database write failed, will retry: {e}"
        return snap

    def _poll_all(self, only_new):
        now = self.clock()
        if not (self.force or self.market_open(now)):
            return
        if self.client.token_expired:
            return
        with self._lock:
            keys = [k for k, d in self._days.items() if (not d.snaps) or not only_new]
        for key in keys:
            if self._stop.is_set():
                return
            try:
                self.poll_key(key, now)
            except DhanError as e:
                log.warning("%s %s: %s", key[0], key[1], e)
                with self._lock:
                    self._days[key].last_error = str(e)
                if self.client.token_expired:
                    return
            except Exception:  # never let the thread die
                log.exception("unexpected error polling %s", key)

    def _run(self):
        while not self._stop.is_set():
            now = self.clock()
            nxt = now.replace(second=3, microsecond=0)
            if now.second >= 3:
                nxt += timedelta(minutes=1)
            woke = self._wake.wait((nxt - now).total_seconds())
            self._wake.clear()
            if self._stop.is_set():
                break
            self._poll_all(only_new=woke)
