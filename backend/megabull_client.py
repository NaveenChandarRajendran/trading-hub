"""
megabull_client.py - MegaBull PAPER trading API (https://api.megabull.in). PAPER ONLY: MegaBull is a virtual-trading
platform; nothing here can reach a broker.

Key: read from a private JSON file OUTSIDE the Trading Journey folder and outside git (default
~/TradingHubKeys/megabull.json):  {"apiKey": "...", "createdOn": "2026-10-23"}
The key is sent only in the `api-key` header. It is never logged, printed or stored anywhere else.
MegaBull keys expire after a month: key_age_days() feeds the startup warning (older than 25 days).

Endpoints used (owner's brief, 23-Oct-2026):
    GET  /api/user/my                      account check
    GET  /api/marketwatch/instruments      CSV of instrument tokens (re-downloaded daily, never hard-coded)
    GET  /api/marketwatch/ltp/{token}
    POST /api/order/buysell                {instrumentToken, qty, type BUY|SELL, duration MIS, orderType LIMIT|MKT|SL,
                                            price, triggerPrice}   (no "id" in the body)
    PUT  /api/order/buysell/{orderId}      modify
    PUT  /api/order/bulk/cancel
    GET  /api/order/my, GET /api/position/my, GET /api/report/monthly/day/{date}

NOT VERIFIED YET (no MegaBull access from the build machine): the instrument CSV's column names, the order / position
response fields and the bulk-cancel body. The parsers below look for the usual names and fail loudly otherwise.
Run `python megabull_client.py check` once: it calls only read-only endpoints and writes what it found (field names,
no key) to megabull_check.txt, so the parsers can be confirmed before Auto sends MegaBull orders.
"""
import csv
import io
import json
import logging
import os
import sys
import threading
import time
from datetime import date, datetime

import requests

log = logging.getLogger("megabull")
BASE = "https://api.megabull.in"
DEFAULT_KEYS_FILE = os.path.join("~", "TradingHubKeys", "megabull.json")
MIN_GAP_SECONDS = 0.35


class MegaBullError(Exception):
    pass


def load_key(path=DEFAULT_KEYS_FILE):
    """(api key, created-on date | None). Raises MegaBullError if the file is missing or has no key."""
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        raise MegaBullError(f"MegaBull key file not found: {p}")
    try:
        d = json.load(open(p, encoding="utf-8-sig"))  # utf-8-sig: Windows PowerShell 5 writes a BOM
    except ValueError as e:
        raise MegaBullError(f"MegaBull key file is not valid JSON: {p}") from e
    key = str(d.get("apiKey") or "").strip()
    if not key:
        raise MegaBullError(f"No apiKey in {p}")
    created = None
    try:
        created = date.fromisoformat(str(d.get("createdOn")))
    except ValueError:
        pass
    return key, created


def key_age_days(created, today=None):
    if created is None:
        return None
    return ((today or date.today()) - created).days


def _pick(d, *names):
    for n in names:
        for k in d:
            if k.lower() == n.lower():
                return d[k]
    return None


def _rows(payload):
    """A list of dicts from a MegaBull response, whatever the wrapper ({data: [...]}, {orders: [...]}, [...])."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("data", "orders", "positions", "result", "items"):
            v = payload.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                return _rows(v)
    return []


def parse_instruments(text):
    """MegaBull's instrument CSV -> option rows {token, symbol, expiry, strike, optionType, lotSize}.
    Column names are matched loosely (see module doc). Raises MegaBullError if the needed columns are missing."""
    reader = csv.DictReader(io.StringIO(text))
    cols = {c.lower().replace(" ", "").replace("_", ""): c for c in (reader.fieldnames or [])}

    def col(*names):
        for n in names:
            if n in cols:
                return cols[n]
        return None

    c_token = col("instrumenttoken", "token", "securityid")
    c_sym = col("name", "symbol", "underlying", "tradingsymbol")
    c_exp = col("expiry", "expirydate")
    c_strike = col("strike", "strikeprice")
    c_type = col("instrumenttype", "optiontype", "type")
    c_lot = col("lotsize", "lot")
    if not (c_token and c_sym and c_exp and c_strike and c_type):
        raise MegaBullError(f"MegaBull instrument CSV columns not recognised: {reader.fieldnames}")
    out = []
    for r in reader:
        typ = (r.get(c_type) or "").upper()
        typ = "CE" if typ in ("CE", "CALL") else "PE" if typ in ("PE", "PUT") else typ
        if typ not in ("CE", "PE"):
            continue
        sym = (r.get(c_sym) or "").upper().replace(" ", "")
        try:
            strike = float(r.get(c_strike) or 0)
            exp = _iso_date(r.get(c_exp) or "")
        except ValueError:
            continue
        if strike <= 0 or not exp:
            continue
        out.append({"token": str(r.get(c_token)).strip(), "symbol": sym, "expiry": exp, "strike": strike,
                    "optionType": typ, "lotSize": int(float(r.get(c_lot) or 0)) if c_lot and r.get(c_lot) else None})
    return out


def _download_url(text):
    """The downloadUrl of a {"downloadUrl": "https://..."} answer, or None (plain CSV)."""
    t = (text or "").strip()
    if not t.startswith("{"):
        return None
    try:
        url = json.loads(t).get("downloadUrl")
    except (ValueError, AttributeError):
        return None
    return url if isinstance(url, str) and url.startswith("https://") else None


def _iso_date(s):
    s = s.strip()[:10]
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d-%b-%Y", "%d/%m/%Y", "%d%b%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


class MegaBullClient:
    def __init__(self, keys_file=DEFAULT_KEYS_FILE, base=BASE, session=None, request_log=None):
        self.keys_file = keys_file
        self.base = base.rstrip("/")
        self.session = session or requests.Session()
        self.request_log = request_log  # callable(dict) that writes one request/response line (never the key)
        self._lock = threading.Lock()
        self._last = 0.0
        self._instruments = None  # (IST date, rows)
        self.key, self.created = load_key(keys_file)

    def key_age_days(self, today=None):
        return key_age_days(self.created, today)

    def _call(self, method, path, body=None, expect_json=True):
        url = self.base + path
        with self._lock:
            wait = MIN_GAP_SECONDS - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            started = datetime.now()
            try:
                r = self.session.request(method, url, json=body, headers={"api-key": self.key, "Accept": "application/json"}, timeout=20)
            except requests.RequestException as e:
                self._log(method, path, body, None, f"network error: {e}", started)
                raise MegaBullError(f"MegaBull network error: {e}") from e
            finally:
                self._last = time.monotonic()
        text = r.text
        self._log(method, path, body, r.status_code, text[:2000], started)
        if r.status_code in (401, 403):
            raise MegaBullError(f"MegaBull refused the API key (HTTP {r.status_code}). It may have expired.")
        if not r.ok:
            raise MegaBullError(f"MegaBull HTTP {r.status_code}: {text[:200]}")
        if not expect_json:
            return text
        try:
            return r.json()
        except ValueError as e:
            raise MegaBullError("MegaBull returned non-JSON") from e

    def _log(self, method, path, body, status, response, started):
        if self.request_log:
            try:
                self.request_log({"time": started.isoformat(timespec="seconds"), "method": method, "path": path,
                                  "body": body, "status": status, "response": response})
            except Exception:
                log.exception("could not write the MegaBull request log")

    # ---------- read ----------
    def me(self):
        return self._call("GET", "/api/user/my")

    def instruments_csv(self):
        """The instrument CSV text. MegaBull answers /api/marketwatch/instruments with {"downloadUrl": ...} (a public
        file, seen 23-Oct-2026); that file is fetched WITHOUT the API key."""
        text = self._call("GET", "/api/marketwatch/instruments", expect_json=False)
        url = _download_url(text)
        if not url:
            return text
        try:
            r = self.session.get(url, timeout=60)
        except requests.RequestException as e:
            raise MegaBullError(f"MegaBull instrument file download failed: {e}") from e
        if not r.ok:
            raise MegaBullError(f"MegaBull instrument file HTTP {r.status_code}")
        return r.content.decode("utf-8-sig", errors="replace")

    def instruments(self):
        today = date.today().isoformat()
        if not self._instruments or self._instruments[0] != today:
            self._instruments = (today, parse_instruments(self.instruments_csv()))
        return self._instruments[1]

    def find_option(self, symbol, expiry, strike, option_type):
        for r in self.instruments():
            if r["symbol"] == symbol and r["expiry"] == expiry and abs(r["strike"] - strike) < 1e-6 and r["optionType"] == option_type:
                return r
        return None

    def ltp(self, token):
        p = self._call("GET", f"/api/marketwatch/ltp/{token}")
        v = _pick(p if isinstance(p, dict) else {}, "ltp", "lastPrice", "last_price")
        if v is None and isinstance(p, dict) and isinstance(p.get("data"), dict):
            v = _pick(p["data"], "ltp", "lastPrice", "last_price")
        try:
            return float(v)
        except (TypeError, ValueError):
            raise MegaBullError(f"MegaBull LTP response not understood: {str(p)[:200]}")

    def orders(self):
        return _rows(self._call("GET", "/api/order/my"))

    def positions(self):
        return _rows(self._call("GET", "/api/position/my"))

    def day_report(self, day):
        return self._call("GET", f"/api/report/monthly/day/{day}")

    # ---------- orders (paper) ----------
    def place(self, token, qty, side, order_type, price=0.0, trigger_price=0.0):
        body = {"instrumentToken": token, "qty": int(qty), "type": side, "duration": "MIS", "orderType": order_type,
                "price": float(price or 0), "triggerPrice": float(trigger_price or 0)}
        p = self._call("POST", "/api/order/buysell", body)
        oid = _pick(p if isinstance(p, dict) else {}, "orderId", "id", "order_id")
        if oid is None and isinstance(p, dict) and isinstance(p.get("data"), dict):
            oid = _pick(p["data"], "orderId", "id", "order_id")
        if oid is None:
            raise MegaBullError(f"MegaBull order response has no order id: {str(p)[:200]}")
        return str(oid)

    def modify(self, order_id, **fields):
        return self._call("PUT", f"/api/order/buysell/{order_id}", fields)

    def cancel(self, order_ids):
        return self._call("PUT", "/api/order/bulk/cancel", {"orderIds": [str(o) for o in order_ids]})

    def order_status(self, order_id):
        """{status, avgPrice} for one of today's orders, or None if MegaBull does not list it (status unknown)."""
        for o in self.orders():
            if str(_pick(o, "orderId", "id", "order_id")) == str(order_id):
                st = str(_pick(o, "status", "orderStatus") or "").upper()
                avg = _pick(o, "avgPrice", "averagePrice", "tradedPrice", "price")
                try:
                    avg = float(avg) if avg is not None else None
                except (TypeError, ValueError):
                    avg = None
                return {"status": st, "avgPrice": avg, "raw": o}
        return None


def _check(keys_file=DEFAULT_KEYS_FILE):
    """Read-only check: writes field names and counts (never the key) to megabull_check.txt."""
    lines = []
    try:
        c = MegaBullClient(keys_file)
        lines.append(f"Key file OK. Key age: {c.key_age_days()} days (warning after 25).")
        me = c.me()
        lines.append(f"/api/user/my fields: {sorted(me.keys()) if isinstance(me, dict) else type(me).__name__}")
        text = c.instruments_csv()
        all_lines = text.splitlines()
        os.makedirs("data", exist_ok=True)  # public file (no key): saved so its layout can be read
        open(os.path.join("data", "megabull_instruments.csv"), "w", encoding="utf-8").write(text)
        head = all_lines[:4]
        lines.append(f"Instrument CSV: {len(all_lines)} lines")
        lines.append(f"Instrument CSV header: {head[0] if head else '(empty)'}")
        lines += [f"  sample: {h}" for h in head[1:]]
        idx = [h for h in all_lines if ("NIFTY" in h.upper()) and (",CE" in h.upper() or ",PE" in h.upper() or "CE," in h.upper() or "PE," in h.upper())]
        lines += [f"  index option sample: {h}" for h in idx[:3]]
        bn = [h for h in idx if "BANKNIFTY" in h.upper()]
        lines += [f"  banknifty sample: {h}" for h in bn[:2]]
        try:
            rows = parse_instruments(text)
            lines.append(f"Options parsed: {len(rows)} (NIFTY {sum(r['symbol'] == 'NIFTY' for r in rows)}, "
                         f"BANKNIFTY {sum(r['symbol'] == 'BANKNIFTY' for r in rows)})")
        except MegaBullError as e:
            lines.append(f"PARSER NEEDS A FIX: {e}")
        for name, fn in (("orders", c.orders), ("positions", c.positions)):
            rows = fn()
            lines.append(f"/api/{name}: {len(rows)} rows; fields: {sorted(rows[0].keys()) if rows and isinstance(rows[0], dict) else '-'}")
    except Exception as e:
        lines.append(f"FAILED: {e}")
    out = "\n".join(lines)
    open("megabull_check.txt", "w", encoding="utf-8").write(out + "\n")
    print(out)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        _check(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_KEYS_FILE)
    else:
        print("usage: python megabull_client.py check [keys-file]")
