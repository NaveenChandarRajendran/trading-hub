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
    GET  /api/option-chain?symbol=NIFTY&expiry=2026-10-27   (shared, cached Dhan chain for the live OI pages)
    GET  /api/dashboard/summary?symbol=NIFTY&expiry=&stocks=HDFCBANK,...   (dashboard glance cards, see dashboard_api.py)
    GET  /api/quotes?symbols=HDFCBANK,ICICIBANK   (live prices of NSE stocks, for index components)
    GET  /api/history?symbol=HDFCBANK             (daily candles, for the previous close)
    GET  /api/status
    POST /api/token   {"accessToken": "..."}   (replace an expired token without restarting)
    /api/paper/*, /ws/paper                     (paper trading, simulation only: see paper_api.py)
    /api/signals/*, /api/autopaper/*            (signal watcher + auto PAPER trading: see sig_service.py, autopaper.py)
    /api/orderflow, /api/orderflow/dext         (estimated delta of the index futures: see orderflow.py)

Storage: set DATABASE_URL (e.g. postgresql://USER:PASSWORD@localhost:5432/algo_trading) to keep every snapshot in
Postgres. Without it the backend falls back to JSON files in ./data.
"""
import argparse
import json
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
import autopaper
import orderflow
import dashboard_api
import paper_api
import sig_rules
import sig_service
from dhan_client import SCRIP, DhanClient, DhanError, TokenExpired
from dhan_feed import DhanFeed
from instruments import OptionInstruments, SecurityIds
from megabull_client import MegaBullClient
from store import IST, JsonStore, PaperJsonStore, PaperPgStore, PgStore
from tracker import Tracker

ALLOWED_INTERVALS = (1, 3, 5, 10, 15, 30)
EXPIRY_CACHE_SECONDS = 3600
QUOTE_CACHE_SECONDS = 2.0
MAX_SYMBOLS = 100
HISTORY_DAYS = 10


class TokenBody(BaseModel):
    accessToken: str


def create_app(tracker, track=(), security_ids=None, paper=None, instruments=None, signal_config=None):
    """paper: optional paper_api.PaperService; its routes and feed are added when given.
    signal_config: autopaper.json settings; when given, the signal watcher + auto paper trader run (sig_service.py).
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

    def start_default_tracking():
        tracker.restore_today()  # resume whatever was tracked earlier today (backend restarted mid-session)
        for sym in track:
            try:
                tracker.register(sym, get_expiries(sym)[0])
            except Exception as e:  # token missing/expired etc. - page can still register later
                logging.getLogger("main").warning("could not auto-track %s: %s", sym, e)

    signals = None  # set below once the routes exist

    @asynccontextmanager
    async def lifespan(_app):
        tracker.start()
        if paper:
            paper.start()
        threading.Thread(target=start_default_tracking, daemon=True).start()
        if signals:
            signals.start()
        yield
        if signals:
            signals.stop()
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
        shown_day = None
        if not snaps and not tracker.market_open() and not tracker.force:
            last = tracker.last_session(symbol, expiry)  # weekend / holiday / before 09:15: the last recorded session
            if last:
                shown_day, strikes, snaps = last
                v = {**v, "strikes": strikes}
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
        elif shown_day:
            message = f"Market is closed: showing the last recorded session, {shown_day[8:10]}-{shown_day[5:7]}-{shown_day[0:4]}."
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
                "asOf": snaps[-1]["ts"] if snaps else None, "sessionDay": shown_day,
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
    if paper:
        paper_api.register(app, paper)
    import bt_service
    bts = bt_service.BacktestService(tracker.client, tracker.market_open)
    bt_service.register(app, bts)
    app.state.backtest = bts
    import journal as journal_mod
    jr = journal_mod.Journal("data")
    journal_mod.register(app, jr, paper)
    import builder_store  # the strategy builder's saved test strategies (owner 30-Oct-2026), PAPER notes only
    builder_store.register(app, builder_store.BuilderStore("data", clock=tracker.clock))
    app.state.journal = jr
    if signal_config is not None:
        signals = build_signals(signal_config, tracker, app.state.candles, get_expiries, lot_size, trending_oi_body, paper,
                                journal=jr)
        sig_service.register(app, signals)
        app.state.signals = signals
        if getattr(signals, "selling", None) is not None:
            import sell_desk
            sell_desk.register(app, signals.selling)
        if signals.phone is not None:
            import notify
            notify.register(app, signals.phone)
        if signal_config.get("momentum", {}).get("enabled", False):  # Momentum 20 stock books (owner 28-Oct-2026)
            import momentum_book
            phone = signals.phone
            desk = momentum_book.MomentumDesk(signal_config["momentum"], data_dir="data",
                                              on_text=phone.send if phone is not None else (lambda text: None))
            momentum_book.register(app, desk)
            app.state.momentum = desk
    return app


def build_signals(cfg, tracker, candles, get_expiries, lot_size, trending_oi_body, paper, journal=None):
    """Signal watcher + auto PAPER trader (Trading Hub paper account; MegaBull paper API when enabled)."""
    sig_rules.configure(cfg.get("rules", {}))
    trader = None
    svc_ref = {}
    alert = lambda kind, msg: svc_ref["svc"].alert(kind, msg)  # noqa: E731
    import notify
    phone = notify.Notifier(alert=alert)  # owner 27-Oct-2026: entry / exit / day summary on the phone (Telegram), if set up
    rows_today = lambda: notify.day_rows(journal, paper, tracker.clock().date().isoformat())  # noqa: E731

    def on_order(trade, event):
        if journal is not None:  # the app's own order history (MegaBull keeps only today's)
            journal.record(trade, event, tracker.clock())
        svc_ref["svc"].on_order(trade, event)
        phone.on_order(trade, event, notify.day_pnl(rows_today()) if event.startswith("exit") else None)
    if paper:
        mb_cfg = cfg["megabull"]

        def dhan_lot(symbol):  # MegaBull's instrument file has no lot size: use Dhan's for the same index
            for exp in paper.option_expiries(symbol)[:1]:
                for r in paper.instrument_chain(symbol, exp):
                    leg = r.get("ce") or r.get("pe")
                    if leg and leg.get("lotSize"):
                        return leg["lotSize"]
            return None
        from strategy_books import StrategyBook
        books = {k: StrategyBook(k, paper, data_dir="data") for k in ("trend", "dharani", "rebound", "orb")}
        paper.books = list(books.values())
        accounts = [autopaper.TradingHubAccount(books["trend"], autopaper.TH),
                    autopaper.TradingHubAccount(books["dharani"], autopaper.DH),
                    autopaper.TradingHubAccount(books["rebound"], autopaper.RBK),
                    autopaper.TradingHubAccount(books["orb"], autopaper.OBK),
                    autopaper.TradingHubAccount(paper, autopaper.MANUAL),
                    autopaper.MegaBullAccount(lambda: MegaBullClient(cfg["keysFile"], request_log=megabull_logger(cfg["logDir"])),
                                              mb_cfg.get("enabled", False), mb_cfg.get("slLimitBufferPct", 2), lot_size=dhan_lot)]
        trader = autopaper.AutoTrader(cfg, accounts, alert=alert, on_order=on_order,
                                      state_path=os.path.join("data", "autopaper_state.json"))
    flow = None
    if paper:
        flow = orderflow.OrderFlowService(orderflow.OrderFlowStore("data"), paper.instruments.near_future)
        paper.orderflow = flow
    sources = sig_service.MarketSources(tracker, candles, get_expiries, lot_size, trending_oi_body, trader)
    svc = sig_service.SignalService(cfg, sources, trader, orderflow=flow, paper=paper)
    svc.phone, svc.rows_today = phone, rows_today
    if paper:
        paper.fill_listeners.append(notify.manual_fill_listener(phone, paper, trader, rows_today))
    svc_ref["svc"] = svc
    svc.selling = None
    if paper and cfg.get("selling", {}).get("enabled", False):  # Rs 10 lakh option SELLING paper book (owner 28-Oct-2026)
        import sell_desk

        def on_sell(trade, event):
            if journal is not None:
                journal.record(trade, event, tracker.clock())
            if event != "carry":
                phone.on_order(trade, event, notify.day_pnl(rows_today()) if event.startswith("exit") else None)
        svc.selling = sell_desk.SellDesk(cfg["selling"], paper, candles, on_event=on_sell, data_dir="data")
        paper.tick_listeners.append(svc.selling)
    return svc


def megabull_logger(log_dir):
    """One JSON line per MegaBull request / response (the key is never part of it)."""
    lock = threading.Lock()

    def write(entry):
        os.makedirs(log_dir, exist_ok=True)
        with lock, open(os.path.join(log_dir, f"megabull_requests_{datetime.now(IST).date()}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, default=str) + "\n")
    return write


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
    tracker = Tracker(client, store=store, each_side=a.strikes, force=a.force, opening_dir=a.data_dir)
    track = [s.strip().upper() for s in a.track.split(",") if s.strip()]
    paper = paper_api.PaperService(
        paper_store, DhanFeed(client.client_id, client.token),
        OptionInstruments(os.path.join(a.data_dir, "option_instruments.json")))
    try:
        signal_config = sig_service.load_config()
    except Exception as e:  # the dashboard still works without the watcher
        logging.getLogger("main").warning("signal watcher off: could not read autopaper.json: %s", e)
        signal_config = None
    from keep_awake import KeepAwake
    KeepAwake().start()  # Windows: no sleep until 16:00 IST while the backend runs (owner, 24-Oct-2026)
    uvicorn.run(create_app(tracker, track, paper=paper, signal_config=signal_config), host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
