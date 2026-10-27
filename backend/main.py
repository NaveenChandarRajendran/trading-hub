"""
main.py - FastAPI server for the Trending OI page.

Run (in this folder): python main.py
DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN and DATABASE_URL are read from backend/.env.local (variables already set win).
Options:  --port 8000  --strikes 7  --track NIFTY,BANKNIFTY  --force  --host 127.0.0.1

Endpoints:
    GET  /api/trending-oi?symbol=NIFTY&expiry=2026-10-27&interval=5
    GET  /api/expiries?symbol=NIFTY
    GET  /api/option-chain?symbol=NIFTY&expiry=2026-10-27   (shared, cached Dhan chain for the live OI pages)
    GET  /api/dashboard/summary?symbol=NIFTY&expiry=&stocks=HDFCBANK,...   (dashboard glance cards, see dashboard_api.py)
    GET  /api/quotes?symbols=HDFCBANK,ICICIBANK   (live prices of NSE stocks, for index components)
    GET  /api/history?symbol=HDFCBANK             (daily candles, for the previous close)
    GET  /api/sr/history?symbol=NIFTY&expiry=&date=   (OI support / resistance level history, see sr_api.py)
    GET|PUT|DELETE /api/dashboard/fixed-levels?index=&expiry=   (Dashboard "Fix zones", see dashboard_levels_api.py)
    /api/algo/*                                  (OI breakout algo, paper only: status, events, day, reports; algo_api.py)
    /api/scalper/*                               (Power Scalper, paper only: Scalper account, orders, OCO, reports)
    GET  /api/status
    POST /api/token   {"accessToken": "..."}   (replace an expired token without restarting)
    /api/paper/*, /ws/paper                     (paper trading, simulation only: see paper_api.py)

Storage: Postgres only (DATABASE_URL, e.g. postgresql://USER:PASSWORD@localhost:5432/algo_trading). Without it, or
when the database can't be reached, the backend refuses to start; there is no JSON-file fallback. ./data only holds
caches (Dhan instrument lists).
"""
import argparse
import logging
import os
import re
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from calc import build_rows, select_for_interval
from chain_cache import FALLBACK_LOT_SIZE, chain_response
import algo_api
import scalper_api
import algo_config
import dashboard_api
import dashboard_levels_api
from algo_filters import load_constituents
from algo_service import AlgoData, AlgoService
from candles import parse_intraday, recent_sessions
import paper_api
from paper_levels import TrackerLevels
import sr_api
from dhan_client import SCRIP, DhanClient, DhanError, TokenExpired
from dhan_feed import DhanFeed
from instruments import OptionInstruments, SecurityIds
from envfile import load_env_file
from store import IST, PaperPgStore, PgStore
from tracker import Tracker

ALLOWED_INTERVALS = (1, 3, 5, 10, 15, 30)
EXPIRY_CACHE_SECONDS = 3600
QUOTE_CACHE_SECONDS = 2.0
MAX_SYMBOLS = 100
HISTORY_DAYS = 10


class TokenBody(BaseModel):
    accessToken: str


def create_app(tracker, track=(), security_ids=None, paper=None, instruments=None, algo_mode=None, scalper=None):
    """paper: optional paper_api.PaperService; its routes and feed are added when given.
    algo_mode: "paper" | "signals" | "off" runs the OI breakout algo (needs paper; None = not created, as in tests).
    scalper: True creates the Power Scalper service (needs paper), or pass a ScalperService (tests).
    instruments: OptionInstruments for lot sizes (defaults to the paper service's; a fallback table without either)."""
    expiry_cache = {}  # symbol -> (time, [expiries])
    quote_cache = {}  # tuple(ids) -> (time, quotes)
    quote_lock = threading.Lock()
    history_cache = {}  # (symbol, IST date) -> {"timestamp": [...], "close": [...]}
    sec_ids = security_ids or SecurityIds()  # symbol -> Dhan security ID; cache in data/security_ids.json
    instruments = instruments or (paper.instruments if paper else None)
    lot_cache = {}  # (symbol, expiry) -> lot size from Dhan's instrument list

    def lot_size(symbol, expiry):
        if (symbol, expiry) not in lot_cache:
            lot = None
            try:
                rows = instruments.chain(symbol, expiry) if instruments else []
                lot = next((r[k]["lotSize"] for r in rows for k in ("ce", "pe") if r[k]), None)
            except Exception as e:  # instrument CSV unreachable and no cache yet
                logging.getLogger("main").warning("lot size for %s %s unavailable: %s", symbol, expiry, e)
            if lot is None:
                return FALLBACK_LOT_SIZE[symbol]  # not cached, so the instrument list is tried again next time
            lot_cache[(symbol, expiry)] = lot
        return lot_cache[(symbol, expiry)]

    def get_expiries(symbol):
        hit = expiry_cache.get(symbol)
        if hit and time.time() - hit[0] < EXPIRY_CACHE_SECONDS:
            return hit[1]
        exps = tracker.client.expiries(symbol)
        expiry_cache[symbol] = (time.time(), exps)
        return exps

    def quotes_for_ids(security_ids):
        """Live prices for NSE stocks. One Dhan call serves everybody asking within QUOTE_CACHE_SECONDS."""
        key = tuple(sorted(set(security_ids)))
        with quote_lock:
            hit = quote_cache.get(key)
            if hit and time.time() - hit[0] < QUOTE_CACHE_SECONDS:
                return hit[1]
            q = tracker.client.ohlc(key) if key else {}
            quote_cache[key] = (time.time(), q)
            return q

    def cached_history(sym):
        """Daily candles already fetched today, or None (never calls Dhan)."""
        return history_cache.get((sym, datetime.now(IST).date().isoformat()))

    def history_for(sym, security_id):
        """Daily candles for one stock, cached per IST day: candles before today do not change during the day.
        Failures are never cached, so they are retried. Raises TokenExpired / DhanError."""
        today = datetime.now(IST).date()
        key = (sym, today.isoformat())
        hit = history_cache.get(key)
        if hit is None:
            hit = tracker.client.historical(security_id, (today - timedelta(days=HISTORY_DAYS)).isoformat(), today.isoformat())
            history_cache[key] = hit
        return hit

    if scalper is True and paper:
        from scalper_service import ScalperService
        scalper = ScalperService(paper.store, paper, paper.instruments, clock=paper.clock)
    algo = None
    if paper and algo_mode in ("paper", "signals"):
        constituents = load_constituents()
        algo_warmer = dashboard_api.HistoryWarmer(history_for)

        def algo_chain(symbol, expiry):
            entry, _cached = tracker.chains.get(symbol, expiry)
            return {"spot": entry.chain["spot"], "oc": entry.chain["oc"], "lotSize": lot_size(symbol, expiry)}

        def algo_trending(symbol, expiry):
            rows = trending_oi_body(symbol, expiry, algo_config.TOI_INTERVAL)["rows"]
            return rows[0] if rows else None

        def algo_components(symbol):
            lst = constituents[symbol]
            ids, _unknown = sec_ids.resolve([c["symbol"] for c in lst])
            by_id = quotes_for_ids(list(ids.values()))
            quotes = {sym: by_id[str(sid)]["ltp"] for sym, sid in ids.items() if str(sid) in by_id}
            history, missing = {}, {}
            for sym, sid in ids.items():
                h = cached_history(sym)
                if h is None:
                    missing[sym] = sid
                else:
                    history[sym] = h
            if missing:
                algo_warmer.request(missing)  # previous closes load in the background; no verdict until then
            return {"constituents": lst, "quotes": quotes, "history": history}

        def algo_intraday(symbol):
            sessions = recent_sessions(datetime.now(IST).date())
            frm, to = f"{sessions[0]} 09:15:00", f"{sessions[-1] + timedelta(days=1)} 09:15:00"  # toDate is exclusive
            return parse_intraday(tracker.client.intraday(symbol, frm, to))

        algo = AlgoService(paper.store, paper, paper.instruments, AlgoData(
            expiries=get_expiries, chain=algo_chain, trending=algo_trending, components=algo_components,
            intraday=algo_intraday, token_expired=lambda: tracker.client.token_expired,
            check_token=getattr(tracker.client, "check_token", None)),
            clock=paper.clock, mode=algo_mode)

    def start_default_tracking():
        tracker.restore_today()  # resume whatever was tracked earlier today (backend restarted mid-session)
        for sym in track:
            try:
                tracker.register(sym, get_expiries(sym)[0])
            except Exception as e:  # token missing/expired etc. - page can still register later
                logging.getLogger("main").warning("could not auto-track %s: %s", sym, e)

    @asynccontextmanager
    async def lifespan(_app):
        tracker.start()
        if paper:
            paper.start()
        threading.Thread(target=start_default_tracking, daemon=True).start()
        if algo:
            algo.start()
        if scalper:
            scalper.start()
        yield
        if scalper:
            scalper.stop()
        if algo:
            algo.stop_thread()
        if paper:
            paper.stop()
        tracker.stop()

    app = FastAPI(title="Trending OI", lifespan=lifespan)
    # The React build can be opened from file:// (origin "null"), so allow every origin.
    # Safe enough because the server listens on 127.0.0.1 only by default.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/expiries")
    def expiries(symbol: str = "NIFTY"):
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        try:
            return {"symbol": symbol, "expiries": get_expiries(symbol)}
        except DhanError as e:
            raise HTTPException(502, str(e))

    @app.get("/api/option-chain")
    def option_chain(symbol: str = "NIFTY", expiry: str = ""):
        """Whole option chain for the live pages, from the shared cache (one Dhan call per key per 10 s at most)."""
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        if expiry and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiry):
            raise HTTPException(400, "expiry must look like 2026-10-27")
        try:
            if not expiry:
                expiry = get_expiries(symbol)[0]
            entry, cached = tracker.chains.get(symbol, expiry)
        except TokenExpired as e:
            raise HTTPException(401, f"{e} Send a new one with POST /api/token.")
        except DhanError as e:
            raise HTTPException(502, f"Dhan option chain failed: {e}")
        return chain_response(symbol, expiry, entry, cached, lot_size(symbol, expiry), tracker.clock(),
                              tracker.market_open(), tracker.client.token_expired)

    def trending_oi_body(symbol, expiry, interval):
        """Body of GET /api/trending-oi (also used by the dashboard). Raises DhanError (expiries / first fetch),
        ValueError (too many expiries tracked) or another Exception (database unreachable)."""
        if not expiry:
            expiry = get_expiries(symbol)[0]
        key = tracker.register(symbol, expiry)
        v = tracker.view(key)
        snaps = v["snaps"]
        chosen, live = select_for_interval(snaps, interval)
        rows = build_rows(chosen)
        if live and rows and tracker.market_open():  # no LIVE tag once the market has closed
            rows[-1]["live"] = True
        for r in rows:
            r.setdefault("live", False)
            r["date"] = f"{r['ts'][8:10]}-{r['ts'][5:7]}-{r['ts'][0:4]}"
            r["time"] = r["ts"][11:16] + ":00"
        rows.reverse()  # newest first, like OI Pulse
        for i, r in enumerate(rows, 1):
            r["no"] = i

        if tracker.client.token_expired:
            message = "Dhan token expired. POST a new one to /api/token."
        elif not snaps and not tracker.market_open() and not tracker.force:
            message = "Market is closed and nothing was recorded today."
        elif not snaps:
            message = "Waiting for the first snapshot (within a minute)."
        else:
            message = ""
        return {
            "meta": {
                "symbol": symbol, "expiry": expiry, "interval": interval,
                "strikes": [int(k) for k in v["strikes"]], "strikeCount": len(v["strikes"]),
                "spot": snaps[-1]["spot"] if snaps else None,
                "asOf": snaps[-1]["ts"] if snaps else None,
                "marketOpen": tracker.market_open(),
                "tokenExpired": tracker.client.token_expired,
                "lastError": v["last_error"], "message": message,
            },
            "rows": rows,
        }

    @app.get("/api/trending-oi")
    def trending_oi(symbol: str = "NIFTY", expiry: str = "", interval: int = 5):
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        if interval not in ALLOWED_INTERVALS:
            raise HTTPException(400, f"interval must be one of {list(ALLOWED_INTERVALS)}")
        try:
            return trending_oi_body(symbol, expiry, interval)
        except DhanError as e:
            raise HTTPException(502, str(e))
        except ValueError as e:
            raise HTTPException(409, str(e))
        except Exception as e:  # database unreachable while loading today's rows
            logging.getLogger("main").exception("could not load today's rows")
            raise HTTPException(503, f"Database unavailable: {e}")

    @app.get("/api/quotes")
    def quotes(symbols: str = ""):
        """Live last prices for NSE stocks (index components): ?symbols=HDFCBANK,ICICIBANK,..."""
        syms = list(dict.fromkeys(x.strip().upper() for x in symbols.split(",") if x.strip()))
        if not syms or len(syms) > MAX_SYMBOLS:
            raise HTTPException(400, f"send 1 to {MAX_SYMBOLS} symbols, comma separated")
        try:
            ids, unknown = sec_ids.resolve(syms)
        except Exception as e:
            raise HTTPException(502, f"could not load Dhan instrument list: {e}")
        try:
            q = quotes_for_ids(ids.values())
        except TokenExpired as e:
            raise HTTPException(401, str(e))
        except DhanError as e:
            raise HTTPException(502, str(e))
        return {"asOf": datetime.now().isoformat(timespec="seconds"), "ids": ids, "unknown": unknown, "quotes": q}

    @app.get("/api/history")
    def history(symbol: str = ""):
        """Daily candles for one stock (for the previous close). The browser never sees the Dhan token."""
        sym = symbol.strip().upper()
        if not sym:
            raise HTTPException(400, "symbol is required")
        try:
            ids, _unknown = sec_ids.resolve([sym])
        except Exception as e:
            raise HTTPException(502, f"could not load Dhan instrument list: {e}")
        if sym not in ids:
            raise HTTPException(404, f"no Dhan security ID for {sym}")
        try:
            hit = history_for(sym, ids[sym])
        except TokenExpired as e:
            raise HTTPException(401, str(e))
        except DhanError as e:
            raise HTTPException(502, str(e))
        return {"symbol": sym, "id": ids[sym], **hit}

    @app.get("/api/status")
    def status():
        return {
            "marketOpen": tracker.market_open(), "force": tracker.force,
            "tokenExpired": tracker.client.token_expired,
            "hasCredentials": bool(tracker.client.client_id and tracker.client.token),
            "storage": tracker.store.kind, "chainFetches": tracker.chains.fetches,
            "paper": {"storage": paper.store.kind, "feedConnected": paper.feed.status["connected"]} if paper else None,
        }

    @app.post("/api/token")
    def set_token(body: TokenBody):
        if len(body.accessToken.strip()) < 20:
            raise HTTPException(400, "that does not look like a Dhan access token")
        tracker.client.set_token(body.accessToken)
        if paper:
            paper.feed.set_token(body.accessToken)
        return {"ok": True}

    dashboard_api.register(app, dashboard_api.DashboardDeps(
        tracker=tracker, get_expiries=get_expiries, lot_size=lot_size, trending_oi_body=trending_oi_body,
        resolve_ids=sec_ids.resolve, quotes_for_ids=quotes_for_ids, cached_history=cached_history, history_for=history_for,
        near_future=lambda symbol: instruments.near_future(symbol) if instruments else None))
    sr_api.register(app, tracker, get_expiries)
    dashboard_levels_api.register(app, tracker.store, tracker.clock)
    if paper:
        paper_api.register(app, paper)
    if algo:
        algo_api.register(app, algo)
        app.state.algo = algo
    if scalper:
        scalper_api.register(app, scalper)
        app.state.scalper = scalper
    return app


ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.local")
NO_DB = ("DATABASE_URL is not set. The backend stores everything in Postgres and has no file fallback.\n"
         "Add this line to backend/.env.local and start again:\n"
         "    DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/algo_trading")


def open_stores(env_file=ENV_FILE):
    """(PgStore, PaperPgStore) from DATABASE_URL (read from backend/.env.local). Exits with a clear message when it is
    missing or the database can't be reached: never a fallback."""
    load_env_file(env_file)
    dsn = os.getenv("DATABASE_URL", "").strip()
    if not dsn:
        raise SystemExit(NO_DB)
    try:
        store = PgStore(dsn)
    except Exception as e:
        raise SystemExit(f"Cannot connect to Postgres with DATABASE_URL from backend/.env.local: {e}\n"
                         "Check that the PostgreSQL service is running and the user, password and database name "
                         "in DATABASE_URL are right.")
    logging.getLogger("main").info("Storing everything in Postgres")
    return store, PaperPgStore(store)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--strikes", type=int, default=7, help="strikes each side of ATM (7 -> 15 strikes)")
    ap.add_argument("--track", default="NIFTY,BANKNIFTY", help="symbols tracked from start (nearest expiry)")
    ap.add_argument("--data-dir", default="data", help="cache folder (Dhan instrument lists); data lives in Postgres")
    ap.add_argument("--force", action="store_true", help="poll even when the market is closed (testing)")
    a = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    import uvicorn

    store, paper_store = open_stores()
    client = DhanClient()
    tracker = Tracker(client, store=store, each_side=a.strikes, force=a.force)
    track = [s.strip().upper() for s in a.track.split(",") if s.strip()]
    paper = paper_api.PaperService(
        paper_store, DhanFeed(client.client_id, client.token, token_ok=lambda: not client.token_expired),
        OptionInstruments(os.path.join(a.data_dir, "option_instruments.json")), levels=TrackerLevels(tracker))
    logging.getLogger("main").info("OI breakout algo: ALGO_MODE=%s (paper orders only, never real orders)", algo_config.MODE)
    uvicorn.run(create_app(tracker, track, paper=paper, algo_mode=algo_config.MODE, scalper=True), host=a.host,
                port=a.port, log_level="info")


if __name__ == "__main__":
    main()
