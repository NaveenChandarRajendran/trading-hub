"""
main.py - FastAPI server for the Trending OI page.

Run (Windows Command Prompt, in this folder):
    set DHAN_CLIENT_ID=...
    set DHAN_ACCESS_TOKEN=...
    python main.py
Options:  --port 8000  --strikes 7  --track NIFTY,BANKNIFTY  --force  --host 127.0.0.1

Endpoints:
    GET  /api/trending-oi?symbol=NIFTY&expiry=2026-10-27&interval=5
    GET  /api/expiries?symbol=NIFTY
    GET  /api/quotes?symbols=HDFCBANK,ICICIBANK   (live prices of NSE stocks, for index components)
    GET  /api/history?symbol=HDFCBANK             (daily candles, for the previous close)
    GET  /api/status
    POST /api/token   {"accessToken": "..."}   (replace an expired token without restarting)
    /api/paper/*, /ws/paper                     (paper trading, simulation only: see paper_api.py)

Storage: set DATABASE_URL (e.g. postgresql://USER:PASSWORD@localhost:5432/algo_trading) to keep every snapshot in
Postgres. Without it the backend falls back to JSON files in ./data.
"""
import argparse
import logging
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from calc import build_rows, select_for_interval
import paper_api
from dhan_client import SCRIP, DhanClient, DhanError, TokenExpired
from dhan_feed import DhanFeed
from instruments import OptionInstruments, SecurityIds
from store import IST, JsonStore, PaperJsonStore, PaperPgStore, PgStore
from tracker import Tracker

ALLOWED_INTERVALS = (1, 3, 5, 10, 15, 30)
EXPIRY_CACHE_SECONDS = 3600
QUOTE_CACHE_SECONDS = 2.0
MAX_SYMBOLS = 100
HISTORY_DAYS = 10


class TokenBody(BaseModel):
    accessToken: str


def create_app(tracker, track=(), security_ids=None, paper=None):
    """paper: optional paper_api.PaperService; its routes and feed are added when given."""
    expiry_cache = {}  # symbol -> (time, [expiries])
    quote_cache = {}  # tuple(ids) -> (time, quotes)
    quote_lock = threading.Lock()
    history_cache = {}  # (symbol, IST date) -> {"timestamp": [...], "close": [...]}
    sec_ids = security_ids or SecurityIds()  # symbol -> Dhan security ID; cache in data/security_ids.json

    def get_expiries(symbol):
        hit = expiry_cache.get(symbol)
        if hit and time.time() - hit[0] < EXPIRY_CACHE_SECONDS:
            return hit[1]
        exps = tracker.client.expiries(symbol)
        expiry_cache[symbol] = (time.time(), exps)
        return exps

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
        yield
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

    @app.get("/api/trending-oi")
    def trending_oi(symbol: str = "NIFTY", expiry: str = "", interval: int = 5):
        symbol = symbol.upper()
        if symbol not in SCRIP:
            raise HTTPException(400, f"symbol must be one of {list(SCRIP)}")
        if interval not in ALLOWED_INTERVALS:
            raise HTTPException(400, f"interval must be one of {list(ALLOWED_INTERVALS)}")
        try:
            if not expiry:
                expiry = get_expiries(symbol)[0]
            key = tracker.register(symbol, expiry)
        except DhanError as e:
            raise HTTPException(502, str(e))
        except ValueError as e:
            raise HTTPException(409, str(e))
        except Exception as e:  # database unreachable while loading today's rows
            logging.getLogger("main").exception("could not load today's rows")
            raise HTTPException(503, f"Database unavailable: {e}")

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
        key = tuple(sorted(set(ids.values())))
        try:
            with quote_lock:  # one Dhan call serves everybody asking within QUOTE_CACHE_SECONDS
                hit = quote_cache.get(key)
                if hit and time.time() - hit[0] < QUOTE_CACHE_SECONDS:
                    q = hit[1]
                else:
                    q = tracker.client.ohlc(key) if key else {}
                    quote_cache[key] = (time.time(), q)
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
        today = datetime.now(IST).date()
        key = (sym, today.isoformat())
        hit = history_cache.get(key)  # candles before today do not change during the day
        if hit is None:
            try:
                hit = tracker.client.historical(ids[sym], (today - timedelta(days=HISTORY_DAYS)).isoformat(), today.isoformat())
            except TokenExpired as e:
                raise HTTPException(401, str(e))
            except DhanError as e:
                raise HTTPException(502, str(e))
            history_cache[key] = hit  # failures are never cached, so they are retried
        return {"symbol": sym, "id": ids[sym], **hit}

    @app.get("/api/status")
    def status():
        return {
            "marketOpen": tracker.market_open(), "force": tracker.force,
            "tokenExpired": tracker.client.token_expired,
            "hasCredentials": bool(tracker.client.client_id and tracker.client.token),
            "storage": tracker.store.kind,
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

    if paper:
        paper_api.register(app, paper)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--strikes", type=int, default=7, help="strikes each side of ATM (7 -> 15 strikes)")
    ap.add_argument("--track", default="NIFTY,BANKNIFTY", help="symbols tracked from start (nearest expiry)")
    ap.add_argument("--data-dir", default="data", help="JSON fallback folder (used only without DATABASE_URL)")
    ap.add_argument("--force", action="store_true", help="poll even when the market is closed (testing)")
    a = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    import uvicorn

    dsn = os.getenv("DATABASE_URL")
    if dsn:
        try:
            store = PgStore(dsn)
        except Exception as e:  # do not silently fall back: the user expects Postgres
            sys.exit(f"Cannot connect to Postgres using DATABASE_URL: {e}")
        logging.getLogger("main").info("Storing snapshots in Postgres")
        paper_store = PaperPgStore(store)
    else:
        store = JsonStore(a.data_dir)
        logging.getLogger("main").warning("DATABASE_URL is not set: using JSON files in %s (set it to use Postgres)", a.data_dir)
        paper_store = PaperJsonStore(a.data_dir)
    client = DhanClient()
    tracker = Tracker(client, store=store, each_side=a.strikes, force=a.force)
    track = [s.strip().upper() for s in a.track.split(",") if s.strip()]
    paper = paper_api.PaperService(
        paper_store, DhanFeed(client.client_id, client.token),
        OptionInstruments(os.path.join(a.data_dir, "option_instruments.json")))
    uvicorn.run(create_app(tracker, track, paper=paper), host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
