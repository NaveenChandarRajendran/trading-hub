"""
instruments.py - maps NSE stock symbols (HDFCBANK) to Dhan security IDs (1333).

Downloads Dhan's instrument CSV once a day and keeps a small cache in data/security_ids.json,
so there is nothing to build by hand. If Dhan is unreachable, the last cache is used.
"""
import csv
import io
import json
import os
import logging
import threading
import time

import requests

CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
MAX_AGE_SECONDS = 24 * 3600
RETRY_UNKNOWN_SECONDS = 3600  # an unknown symbol triggers a re-download at most once an hour


def parse_csv(text):
    """NSE cash-market equities only: {"HDFCBANK": 1333, ...}."""
    ids = {}
    for row in csv.DictReader(io.StringIO(text)):
        if (row.get("SEM_EXM_EXCH_ID") == "NSE" and row.get("SEM_SEGMENT") == "E"
                and row.get("SEM_INSTRUMENT_NAME") == "EQUITY" and row.get("SEM_SERIES") == "EQ"):
            try:
                ids[row["SEM_TRADING_SYMBOL"]] = int(row["SEM_SMST_SECURITY_ID"])
            except (KeyError, ValueError):
                continue
    return ids


class SecurityIds:
    def __init__(self, cache_path="data/security_ids.json", session=None, url=CSV_URL):
        self.cache_path = cache_path
        self.session = session or requests.Session()
        self.url = url
        self._lock = threading.Lock()
        self._ids, self._fetched = {}, 0.0
        self._load_cache()

    def _load_cache(self):
        try:
            with open(self.cache_path, encoding="utf-8") as f:
                d = json.load(f)
            self._ids, self._fetched = d["ids"], float(d["fetched"])
        except (OSError, ValueError, KeyError):
            pass

    def _download(self):
        r = self.session.get(self.url, timeout=90)
        r.raise_for_status()
        ids = parse_csv(r.text)
        if not ids:
            raise ValueError("instrument file had no NSE equities")
        self._ids, self._fetched = ids, time.time()
        os.makedirs(os.path.dirname(self.cache_path) or ".", exist_ok=True)
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump({"fetched": self._fetched, "ids": ids}, f)

    def resolve(self, symbols):
        """-> (ids {symbol: id}, unknown [symbols])"""
        with self._lock:
            age = time.time() - self._fetched
            missing = any(s not in self._ids for s in symbols)
            if not self._ids or age > MAX_AGE_SECONDS or (missing and age > RETRY_UNKNOWN_SECONDS):
                try:
                    self._download()
                except Exception:  # keep serving the old cache; the caller sees unknown symbols if any
                    if not self._ids:
                        raise
            ids = {s: self._ids[s] for s in symbols if s in self._ids}
            return ids, [s for s in symbols if s not in self._ids]


# ---------------------------------------------------------------- index options (paper trading)
log = logging.getLogger("instruments")

OPTION_UNDERLYINGS = ("NIFTY", "BANKNIFTY", "SENSEX")
EXCHANGE_OF = {"NIFTY": "NSE", "BANKNIFTY": "NSE", "SENSEX": "BSE"}  # where each index's options trade
SEGMENT_OF_EXCHANGE = {"NSE": "NSE_FNO", "BSE": "BSE_FNO"}  # Dhan exchange segment of those options
CACHE_VERSION = 2  # 2: SENSEX (BSE) options and a segment per option; an older cache is downloaded again


def segment_of(inst):
    """Dhan exchange segment of an option (rows cached before SENSEX have none: NSE)."""
    return (inst or {}).get("segment") or "NSE_FNO"


def parse_index_options(text, underlyings=OPTION_UNDERLYINGS):
    """Index options from Dhan's instrument CSV (NIFTY / BANKNIFTY on NSE, SENSEX on BSE): {"35000": {"securityId": 35000,
    "symbol": "BANKNIFTY", "segment": "NSE_FNO", "expiry": "2026-12-29", "strike": 69400.0, "optionType": "CE",
    "lotSize": 30, "tickSize": 0.05, "name": "BANKNIFTY 29 DEC 69400 CALL"}}. Lot sizes always come from this file,
    never from code. Security IDs are per exchange; everything here keys options by ID alone, so a BSE option whose ID
    is also an NSE option is left out (logged) rather than mixed up with it."""
    out, clashes = {}, 0
    for row in sorted(csv.DictReader(io.StringIO(text)), key=lambda r: r.get("SEM_EXM_EXCH_ID") != "NSE"):  # NSE first
        if row.get("SEM_INSTRUMENT_NAME") != "OPTIDX":
            continue
        symbol = (row.get("SEM_TRADING_SYMBOL") or "").split("-")[0]
        if symbol not in underlyings or row.get("SEM_EXM_EXCH_ID") != EXCHANGE_OF.get(symbol):
            continue
        try:
            sid = int(row["SEM_SMST_SECURITY_ID"])
            if str(sid) in out:
                clashes += 1
                continue
            out[str(sid)] = {
                "securityId": sid, "symbol": symbol, "segment": SEGMENT_OF_EXCHANGE[EXCHANGE_OF[symbol]],
                "expiry": row["SEM_EXPIRY_DATE"][:10],
                "strike": float(row["SEM_STRIKE_PRICE"]), "optionType": row["SEM_OPTION_TYPE"],
                "lotSize": int(float(row["SEM_LOT_UNITS"])),
                "tickSize": round(float(row.get("SEM_TICK_SIZE") or 5) / 100, 2),  # the CSV gives paise
                "name": row.get("SEM_CUSTOM_SYMBOL") or row["SEM_TRADING_SYMBOL"],
            }
        except (KeyError, ValueError):
            continue
    if clashes:
        log.warning("instrument list: %d option IDs appear on both NSE and BSE; the BSE ones were left out", clashes)
    return out


def parse_index_futures(text, underlyings=("NIFTY", "BANKNIFTY")):
    """NSE index futures from the same CSV: [{"securityId": 52162, "symbol": "NIFTY", "expiry": "2026-10-27",
    "lotSize": 65, "name": "NIFTY OCT FUT"}] (the Dashboard shows their volume, an index has none)."""
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("SEM_EXM_EXCH_ID") != "NSE" or row.get("SEM_INSTRUMENT_NAME") != "FUTIDX":
            continue
        symbol = (row.get("SEM_TRADING_SYMBOL") or "").split("-")[0]
        if symbol not in underlyings:
            continue
        try:
            out.append({"securityId": int(row["SEM_SMST_SECURITY_ID"]), "symbol": symbol,
                        "expiry": row["SEM_EXPIRY_DATE"][:10], "lotSize": int(float(row["SEM_LOT_UNITS"])),
                        "name": row.get("SEM_CUSTOM_SYMBOL") or row["SEM_TRADING_SYMBOL"]})
        except (KeyError, ValueError):
            continue
    return sorted(out, key=lambda f: (f["symbol"], f["expiry"]))


class OptionInstruments:
    """Security ID -> option details (lot size, name, expiry), plus the index futures (kept apart from the options so
    the option chain never sees them). Downloaded once per IST day and cached in data/option_instruments.json; if Dhan
    is unreachable the last cache is used."""

    def __init__(self, cache_path="data/option_instruments.json", session=None, url=CSV_URL, today=None):
        self.cache_path = cache_path
        self.session = session or requests.Session()
        self.url = url
        self._today = today or (lambda: time.strftime("%Y-%m-%d", time.gmtime(time.time() + 19800)))  # IST date
        self._lock = threading.Lock()
        self._rows, self._day, self._tried_unknown = {}, "", 0.0
        self._futures = []
        try:
            with open(cache_path, encoding="utf-8") as f:
                d = json.load(f)
            self._rows, self._day = d["rows"], d["day"] if d.get("version") == CACHE_VERSION else ""
            self._futures = d.get("futures", [])  # caches written before futures were kept have none
        except (OSError, ValueError, KeyError):
            pass

    def _download(self):
        r = self.session.get(self.url, timeout=90)
        r.raise_for_status()
        rows = parse_index_options(r.text)
        if not rows:
            raise ValueError("instrument file had no NIFTY / BANKNIFTY options")
        self._rows, self._day, self._futures = rows, self._today(), parse_index_futures(r.text)
        os.makedirs(os.path.dirname(self.cache_path) or ".", exist_ok=True)
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump({"version": CACHE_VERSION, "day": self._day, "rows": rows, "futures": self._futures}, f)

    def _fresh(self, unknown_key=None):
        """Downloads when there is no cache, the cache is from an earlier IST day, or an unknown ID was asked for
        (at most once an hour). Call with self._lock held."""
        stale = self._day != self._today()
        unknown = (unknown_key is not None and unknown_key not in self._rows
                   and time.time() - self._tried_unknown > RETRY_UNKNOWN_SECONDS)
        if not self._rows or stale or unknown:
            if unknown:
                self._tried_unknown = time.time()
            try:
                self._download()
            except Exception:
                if not self._rows:
                    raise

    def near_future(self, symbol, today=None):
        """The nearest index future that hasn't expired: expiry on or after today, so it rolls the day after expiry.
        None if the instrument list has none."""
        today = today or self._today()
        with self._lock:
            missing = not self._futures and time.time() - self._tried_unknown > RETRY_UNKNOWN_SECONDS
            if missing:  # an older cache without futures: fetch once (at most hourly)
                self._tried_unknown = time.time()
                try:
                    self._download()
                except Exception:
                    pass
            else:
                self._fresh()
            live = [f for f in self._futures if f["symbol"] == symbol and f["expiry"] >= today]
            return min(live, key=lambda f: f["expiry"]) if live else None

    def future_ids(self):
        """Security IDs of the cached index futures (never downloads: called for every feed packet)."""
        return {f["securityId"] for f in self._futures}

    def get(self, security_id):
        """Option details, or None if the ID is not a NIFTY / BANKNIFTY / SENSEX option."""
        key = str(int(security_id))
        with self._lock:
            self._fresh(key)
            return self._rows.get(key)

    def expiries(self, symbol, today=None):
        """Expiry dates ('YYYY-MM-DD') from today on, nearest first."""
        today = today or self._today()
        with self._lock:
            self._fresh()
            return sorted({r["expiry"] for r in self._rows.values() if r["symbol"] == symbol and r["expiry"] >= today})

    def chain(self, symbol, expiry):
        """[{"strike", "ce": {...} | None, "pe": {...} | None}] ascending, for one symbol and expiry."""
        with self._lock:
            self._fresh()
            rows = {}
            for r in self._rows.values():
                if r["symbol"] == symbol and r["expiry"] == expiry:
                    rows.setdefault(r["strike"], {"strike": r["strike"], "ce": None, "pe": None})[r["optionType"].lower()] = r
            return [rows[k] for k in sorted(rows)]
