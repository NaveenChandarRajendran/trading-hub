"""
instruments.py - maps NSE stock symbols (HDFCBANK) to Dhan security IDs (1333).

Downloads Dhan's instrument CSV once a day and keeps a small cache in data/security_ids.json,
so there is nothing to build by hand. If Dhan is unreachable, the last cache is used.
"""
import csv
import io
import json
import os
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
OPTION_UNDERLYINGS = ("NIFTY", "BANKNIFTY")


def parse_index_options(text, underlyings=OPTION_UNDERLYINGS):
    """NSE index options from Dhan's instrument CSV: {"35000": {"securityId": 35000, "symbol": "BANKNIFTY",
    "expiry": "2026-12-29", "strike": 69400.0, "optionType": "CE", "lotSize": 30, "tickSize": 0.05,
    "name": "BANKNIFTY 29 DEC 69400 CALL"}}. Lot sizes always come from this file, never from code."""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("SEM_EXM_EXCH_ID") != "NSE" or row.get("SEM_INSTRUMENT_NAME") != "OPTIDX":
            continue
        symbol = (row.get("SEM_TRADING_SYMBOL") or "").split("-")[0]
        if symbol not in underlyings:
            continue
        try:
            sid = int(row["SEM_SMST_SECURITY_ID"])
            out[str(sid)] = {
                "securityId": sid, "symbol": symbol, "expiry": row["SEM_EXPIRY_DATE"][:10],
                "strike": float(row["SEM_STRIKE_PRICE"]), "optionType": row["SEM_OPTION_TYPE"],
                "lotSize": int(float(row["SEM_LOT_UNITS"])),
                "tickSize": round(float(row.get("SEM_TICK_SIZE") or 5) / 100, 2),  # the CSV gives paise
                "name": row.get("SEM_CUSTOM_SYMBOL") or row["SEM_TRADING_SYMBOL"],
            }
        except (KeyError, ValueError):
            continue
    return out


class OptionInstruments:
    """Security ID -> option details (lot size, name, expiry). Downloaded once per IST day and cached in
    data/option_instruments.json; if Dhan is unreachable the last cache is used."""

    def __init__(self, cache_path="data/option_instruments.json", session=None, url=CSV_URL, today=None):
        self.cache_path = cache_path
        self.session = session or requests.Session()
        self.url = url
        self._today = today or (lambda: time.strftime("%Y-%m-%d", time.gmtime(time.time() + 19800)))  # IST date
        self._lock = threading.Lock()
        self._rows, self._day, self._tried_unknown = {}, "", 0.0
        try:
            with open(cache_path, encoding="utf-8") as f:
                d = json.load(f)
            self._rows, self._day = d["rows"], d["day"]
        except (OSError, ValueError, KeyError):
            pass

    def _download(self):
        r = self.session.get(self.url, timeout=90)
        r.raise_for_status()
        rows = parse_index_options(r.text)
        if not rows:
            raise ValueError("instrument file had no NIFTY / BANKNIFTY options")
        self._rows, self._day = rows, self._today()
        os.makedirs(os.path.dirname(self.cache_path) or ".", exist_ok=True)
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump({"day": self._day, "rows": rows}, f)

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

    def get(self, security_id):
        """Option details, or None if the ID is not a NIFTY / BANKNIFTY option."""
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
