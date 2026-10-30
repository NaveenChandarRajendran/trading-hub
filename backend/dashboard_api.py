"""
dashboard_api.py - GET /api/dashboard/summary: everything the Dashboard's glance cards and S/R lines need, in one call.

The backend only gathers raw data; the browser runs each app's own logic on it (so the dashboard can never disagree
with the apps). Sections, each with its own status so one failure never breaks the rest:
    chain       the shared cached option chain (chain_cache.py), same body as GET /api/option-chain
    trendingOi  the latest Trending OI rows from the tracker (no Dhan call)
    components  live quotes + daily candles for the index stocks the page sends (weights stay in the frontend)
status: "ok" | "stale" (served from cache after a failed refresh) | "warming" (daily candles still being fetched)
        | "empty" (nothing recorded yet) | "token" (Dhan token expired) | "error"

GET /api/dashboard/candles: index candles for today and the previous trading session (Dhan intraday, 1-minute, cached),
aggregated to 1 / 3 / 5 / 15 minutes, with the near-month index future's volume per candle (an index has none).
The live candle and volume come over /ws/paper ("candle" / "volume" messages, see paper_api.py).
"""
import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable

from fastapi import HTTPException

from candles import INTERVALS, aggregate, merge_volume, parse_intraday, recent_sessions
from chain_cache import chain_response
from dhan_client import SCRIP, DhanError, TokenExpired
from store import IST

log = logging.getLogger("dashboard")
TRENDING_INTERVAL = 5  # the Trending OI app's default; the card reads the newest row, which is the same at any interval
MAX_STOCKS = 100
CANDLE_TTL_OPEN = 60  # seconds: completed 1-minute candles; the live one comes from the feed
CANDLE_TTL_CLOSED = 900


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
    near_future: Callable[[str], dict | None]  # near-month index future (volume for the chart), or None


def _prev_session(one_min, sessions):
    """High / low / close of the session before the shown one (the date picker's pivot), or None."""
    if len(sessions) < 2:
        return None
    rows = [c for c in one_min if datetime.fromtimestamp(c["time"], IST).date() == sessions[0]]
    if not rows:
        return None
    return {"date": sessions[0].isoformat(), "high": max(c["high"] for c in rows), "low": min(c["low"] for c in rows),
            "close": rows[-1]["close"]}


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


class CandleService:
    """Index 1-minute candles for today and the previous trading session (Dhan intraday), with the near-month future's
    volume per minute, cached per symbol. Used by GET /api/dashboard/candles and the signal watcher."""

    def __init__(self, tracker, near_future):
        self.tracker = tracker
        self.near_future = near_future
        self._cache = {}  # (symbol, sessions) -> (fetched at, 1-minute candles with volume, future, volume error,
        #                                          the future's own 1-minute candles)
        self._lock = threading.Lock()

    def _fetch(self, symbol, sessions):
        """Index 1-minute candles + the near-month future's volume. A volume failure never hides the candles."""
        client = self.tracker.client
        # Dhan's intraday toDate is exclusive by date (checked 22-Oct-2026: 21-Oct 09:15 -> 21-Oct 15:30 returned
        # nothing, -> 22-Oct returned 21-Oct's 374 candles), so ask up to the day after the last session.
        frm, to = f"{sessions[0]} 09:15:00", f"{sessions[-1] + timedelta(days=1)} 09:15:00"
        one_min = parse_intraday(client.intraday(symbol, frm, to))
        fut, volume_error, fut_candles = None, "", []
        try:
            fut = self.near_future(symbol)
            if fut is None:
                volume_error = "No index future found in Dhan's instrument list."
            else:
                fut_candles = parse_intraday(client.intraday(symbol, frm, to, future_id=fut["securityId"]))
                one_min = merge_volume(one_min, fut_candles)
        except TokenExpired:
            raise
        except Exception as e:  # DhanError or the instrument list: candles without volume
            volume_error = f"Futures volume unavailable: {e}"
        return one_min, fut, volume_error, fut_candles

    def get(self, symbol, max_age=None, day=None, n=2):
        fetched, sessions, one_min, fut, volume_error, last_error, _fut_candles = self._get(symbol, max_age, day, n)
        return fetched, sessions, one_min, fut, volume_error, last_error

    def get_with_futures(self, symbol, max_age=None, n=4):
        """(sessions, index 1-minute candles, the near-month future's 1-minute candles, last error) for the last n
        sessions. Dharani v2 needs the futures' own candles and a longer history (EMA 200 on 3-minute candles)."""
        _f, sessions, one_min, _fut, _ve, last_error, fut_candles = self._get(symbol, max_age, None, n)
        return sessions, one_min, fut_candles, last_error

    def _get(self, symbol, max_age, day, n):
        """(fetched at, sessions, 1-minute candles, future, volume error, last error). Raises DhanError / TokenExpired
        only when there is nothing cached; otherwise the last candles come back with last error set.
        day: an earlier trading day (date) for the chart's date picker: that session and the one before it; an earlier
        day never changes, so it is fetched once."""
        now = self.tracker.clock()
        past = day is not None and day < now.date()
        sessions = tuple(recent_sessions(day if past else now.date(), n))
        key = (symbol, sessions)
        ttl = float("inf") if past else max_age if max_age is not None else CANDLE_TTL_OPEN if self.tracker.market_open() else CANDLE_TTL_CLOSED
        last_error = ""
        with self._lock:  # one set of Dhan calls serves every caller asking at the same time
            hit = self._cache.get(key)
            if not hit or (now - hit[0]).total_seconds() >= ttl:
                try:
                    hit = self._cache[key] = (now, *self._fetch(symbol, sessions))
                except DhanError as e:
                    if not hit:
                        raise
                    last_error = str(e)  # keep showing the last candles
        fetched, one_min, fut, volume_error, fut_candles = hit
        return fetched, sessions, one_min, fut, volume_error, last_error, fut_candles


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

    candles_svc = CandleService(tracker, deps.near_future)
    app.state.candles = candles_svc  # shared with the signal watcher (sig_service.py)

    daily_cache = {}  # (symbol, IST date, days) -> response body

    @app.get("/api/dashboard/sessions")
    def sessions(n: int = 60):
        """Trading days for the date picker, newest first (today first when it is a trading day)."""
        n = max(1, min(n, 250))
        return {"days": [d.isoformat() for d in reversed(recent_sessions(tracker.clock().date(), n))]}

    @app.get("/api/dashboard/daily")
    def daily(symbol: str = "NIFTY", days: int = 30):
        """Index daily candles for the last `days` trading days (chart interval "1 day"). Cached per IST day."""
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        days = max(5, min(days, 400))
        today = tracker.clock().date()
        key = (symbol, today, days)
        if key not in daily_cache or tracker.market_open():
            # ask for enough calendar days to cover the trading days, plus warm-up for the indicators (SuperTrend, BB 20)
            frm = today - timedelta(days=int(days * 1.6) + 45)
            try:
                p = tracker.client.index_daily(symbol, frm.isoformat(), (today + timedelta(days=1)).isoformat())
            except TokenExpired as e:
                raise HTTPException(401, f"{e} Send a new one with POST /api/token.")
            except DhanError as e:
                raise HTTPException(502, str(e))
            rows = []
            for i, ts in enumerate(p.get("timestamp") or []):
                try:
                    rows.append({"time": int(ts), "open": float(p["open"][i]), "high": float(p["high"][i]),
                                 "low": float(p["low"][i]), "close": float(p["close"][i])})
                except (KeyError, IndexError, TypeError, ValueError):
                    continue
            daily_cache[key] = {"meta": {"symbol": symbol, "days": days, "shown": min(days, len(rows))}, "candles": rows}
        return daily_cache[key]

    @app.get("/api/dashboard/candles")
    def candles(symbol: str = "NIFTY", interval: int = 5, date: str = "", warm: int = 0):
        """Today and the session before as candles; warm = that many earlier sessions more, sent apart ("warm") so the
        chart's long indicators (EMA 200 on 5-minute candles, Rebound Call) start full on the first shown candle.
        warm=2 shares the signal watcher's 4-session cache (Power Breakout), warm=10 the Rebound Call's 12-session one, so
        neither costs an extra Dhan call."""
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        if interval not in INTERVALS:
            raise HTTPException(400, f"interval must be one of {list(INTERVALS)}")
        day = None
        if date:
            try:
                day = datetime.strptime(date, "%Y-%m-%d").date()
            except ValueError:
                raise HTTPException(400, "date must look like 2026-10-21")
            if day > tracker.clock().date():
                raise HTTPException(400, "date can't be in the future")
        try:
            warm = max(0, min(warm, 10))  # 10 = the Rebound Call watcher's 12-session cache (EMA 200 as the rule has it)
            fetched, sessions, one_min, fut, volume_error, last_error = candles_svc.get(symbol, day=day, n=2 + warm)
        except TokenExpired as e:
            raise HTTPException(401, f"{e} Send a new one with POST /api/token.")
        except DhanError as e:
            raise HTTPException(502, str(e))
        token = tracker.client.token_expired
        shown = sessions[-2:]
        early = [c for c in one_min if datetime.fromtimestamp(c["time"], IST).date() < shown[0]]
        one_min = [c for c in one_min if datetime.fromtimestamp(c["time"], IST).date() >= shown[0]]
        sessions = shown
        return {
            "meta": {
                "symbol": symbol, "interval": interval, "sessions": [d.isoformat() for d in sessions],
                "asOf": fetched.strftime("%Y-%m-%d %H:%M:%S"), "marketOpen": tracker.market_open(),
                "tokenExpired": token, "lastError": last_error,
                "message": "Dhan token expired. Send a new one with POST /api/token." if token else "",
                # volume = this future's (an index has none); the page subscribes to it for the live minute
                "volume": {"securityId": fut["securityId"], "name": fut["name"], "expiry": fut["expiry"]} if fut else None,
                "volumeError": volume_error,
                "live": day is None or day >= tracker.clock().date(),
                "prevSession": _prev_session(one_min, sessions),
            },
            "candles": aggregate(one_min, interval),
            "warm": aggregate(early, interval) if early else [],
        }

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
