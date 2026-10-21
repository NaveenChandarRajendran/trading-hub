"""
dashboard_api.py - GET /api/dashboard/summary: everything the Dashboard's glance cards and S/R lines need, in one call.

The backend only gathers raw data; the browser runs each app's own logic on it (so the dashboard can never disagree
with the apps). Sections, each with its own status so one failure never breaks the rest:
    chain       the shared cached option chain (chain_cache.py), same body as GET /api/option-chain
    trendingOi  the latest Trending OI rows from the tracker (no Dhan call)
    components  live quotes + daily candles for the index stocks the page sends (weights stay in the frontend)
status: "ok" | "stale" (served from cache after a failed refresh) | "warming" (daily candles still being fetched)
        | "empty" (nothing recorded yet) | "token" (Dhan token expired) | "error"
"""
import logging
import re
import threading
from dataclasses import dataclass
from typing import Callable

from fastapi import HTTPException

from chain_cache import chain_response
from dhan_client import SCRIP, DhanError, TokenExpired

log = logging.getLogger("dashboard")
TRENDING_INTERVAL = 5  # the Trending OI app's default; the card reads the newest row, which is the same at any interval
MAX_STOCKS = 100


@dataclass
class DashboardDeps:
    tracker: object  # tracker.Tracker (its .chains is the shared option-chain cache)
    get_expiries: Callable[[str], list]
    lot_size: Callable[[str, str], int]
    trending_oi_body: Callable[[str, str, int], dict]
    resolve_ids: Callable[[list], tuple]  # symbols -> ({symbol: id}, [unknown])
    quotes_for_ids: Callable[[list], dict]  # ids -> {"1333": {"ltp": ...}}
    cached_history: Callable[[str], dict | None]
    history_for: Callable[[str, int], dict]


def section(status, data=None, error="", as_of=None):
    return {"status": status, "error": error, "asOf": as_of, "data": data}


def failed(e):
    """A Dhan failure as a section."""
    if isinstance(e, TokenExpired):
        return section("token", error=f"{e} Send a new one with POST /api/token.")
    return section("error", error=str(e) or e.__class__.__name__)


class HistoryWarmer:
    """Fetches missing daily candles one stock at a time in a background thread (Dhan allows ~4 history calls/s and
    the first call of the day may need 50 stocks), so the summary never waits for them."""

    def __init__(self, history_for):
        self.history_for = history_for
        self._lock = threading.Lock()
        self._queue = {}  # symbol -> security id, waiting
        self._thread = None
        self.last_error = ""

    def request(self, wanted):
        with self._lock:
            self._queue.update(wanted)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="history-warmer", daemon=True)
                self._thread.start()

    def _run(self):
        while True:
            with self._lock:
                if not self._queue:
                    return
                sym, sid = self._queue.popitem()
            try:
                self.history_for(sym, sid)
                self.last_error = ""
            except TokenExpired as e:
                self.last_error = str(e)
                with self._lock:
                    self._queue.clear()  # nothing will work until a new token arrives
                return
            except DhanError as e:  # skip this one; the next summary asks again
                self.last_error = f"{sym}: {e}"

    def join(self, timeout=None):
        t = self._thread
        if t:
            t.join(timeout)


def register(app, deps: DashboardDeps):
    warmer = HistoryWarmer(deps.history_for)
    app.state.dashboard_warmer = warmer  # tests wait on it
    tracker = deps.tracker

    def chain_section(symbol, expiry):
        try:
            entry, cached = tracker.chains.get(symbol, expiry)
        except DhanError as e:
            return failed(e)
        body = chain_response(symbol, expiry, entry, cached, deps.lot_size(symbol, expiry), tracker.clock(),
                              tracker.market_open(), tracker.client.token_expired)
        status = "token" if tracker.client.token_expired else "stale" if entry.last_error else "ok"
        return section(status, body, body["meta"]["message"] if status != "ok" else "", body["meta"]["asOf"])

    def trending_section(symbol, expiry):
        try:
            body = deps.trending_oi_body(symbol, expiry, TRENDING_INTERVAL)
        except DhanError as e:
            return failed(e)
        except ValueError as e:  # already tracking the maximum number of expiries
            return section("error", error=str(e))
        except Exception as e:  # database unreachable
            log.exception("trending OI for the dashboard")
            return section("error", error=f"Database unavailable: {e}")
        meta = body["meta"]
        data = {"meta": meta, "rows": body["rows"][:2]}  # newest first: the latest row and the one before it
        if meta["tokenExpired"] and not body["rows"]:
            return section("token", data, meta["message"], meta["asOf"])
        if not body["rows"]:
            return section("empty", data, meta["message"], meta["asOf"])
        return section("stale" if meta["lastError"] else "ok", data, meta["lastError"], meta["asOf"])

    def components_section(stocks):
        if not stocks:
            return section("empty", {"quotes": {}, "history": {}, "unknown": []}, "No stocks sent.")
        try:
            ids, unknown = deps.resolve_ids(stocks)
        except Exception as e:
            return section("error", error=f"Could not load Dhan instrument list: {e}")
        try:
            by_id = deps.quotes_for_ids(list(ids.values()))
        except DhanError as e:
            return failed(e)
        quotes = {sym: by_id[str(sid)] for sym, sid in ids.items() if str(sid) in by_id}
        history, missing = {}, {}
        for sym, sid in ids.items():
            h = deps.cached_history(sym)
            if h is None:
                missing[sym] = sid
            else:
                history[sym] = h
        if missing:
            warmer.request(missing)
        data = {"quotes": quotes, "history": history, "unknown": unknown, "pending": sorted(missing)}
        as_of = tracker.clock().strftime("%Y-%m-%d %H:%M:%S")
        if missing:
            return section("warming", data, f"Loading previous closes ({len(history)} of {len(ids)} stocks).", as_of)
        return section("ok", data, "", as_of)

    @app.get("/api/dashboard/summary")
    def summary(symbol: str = "NIFTY", expiry: str = "", stocks: str = ""):
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        if expiry and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiry):
            raise HTTPException(400, "expiry must look like 2026-10-27")
        syms = list(dict.fromkeys(x.strip().upper() for x in stocks.split(",") if x.strip()))
        if len(syms) > MAX_STOCKS:
            raise HTTPException(400, f"send at most {MAX_STOCKS} stocks")

        if not expiry:
            try:
                expiry = deps.get_expiries(symbol)[0]
            except DhanError as e:
                expiry, chain, trending = "", failed(e), failed(e)
        if expiry:
            chain, trending = chain_section(symbol, expiry), trending_section(symbol, expiry)
        components = components_section(syms)

        token = tracker.client.token_expired
        return {
            "meta": {
                "symbol": symbol, "expiry": expiry, "asOf": tracker.clock().strftime("%Y-%m-%d %H:%M:%S"),
                "marketOpen": tracker.market_open(), "tokenExpired": token,
                "message": "Dhan token expired. Send a new one with POST /api/token." if token else "",
            },
            "chain": chain,
            "trendingOi": trending,
            "components": components,
        }
