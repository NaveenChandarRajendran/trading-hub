"""
dhan_client.py - minimal Dhan Data API client (option chain + expiry list).

One request at a time, at least 3.1 seconds apart (Dhan limits /optionchain to ~1 request / 3 s).
Credentials come from DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN (or set_token() at runtime).
"""
import os
import threading
import time

import requests

BASE = "https://api.dhan.co/v2"
SEGMENT = "IDX_I"
SCRIP = {"NIFTY": 13, "BANKNIFTY": 25}
STRIKE_STEP = {"NIFTY": 50, "BANKNIFTY": 100}
MIN_GAP_SECONDS = 3.1
QUOTE_GAP_SECONDS = 1.1
HISTORY_GAP_SECONDS = 0.25  # data API: about 4 requests / second


class DhanError(Exception):
    pass


class TokenExpired(DhanError):
    pass


class DhanClient:
    def __init__(self, client_id=None, token=None, session=None):
        self.client_id = client_id or os.getenv("DHAN_CLIENT_ID", "")
        self.token = token or os.getenv("DHAN_ACCESS_TOKEN", "")
        self.token_expired = False
        self.session = session or requests.Session()
        self._lock = threading.Lock()
        self._last_call = 0.0

    def set_token(self, token):
        self.token = token.strip()
        self.token_expired = False

    def _post(self, path, body, gap=MIN_GAP_SECONDS):
        if not self.client_id or not self.token:
            raise DhanError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set")
        with self._lock:  # serialises calls and enforces the gap
            wait = gap - (time.monotonic() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            try:
                r = self.session.post(
                    BASE + path,
                    json=body,
                    headers={"access-token": self.token, "client-id": self.client_id, "Content-Type": "application/json"},
                    timeout=20,
                )
            except requests.RequestException as e:
                raise DhanError(f"network error: {e}") from e
            finally:
                self._last_call = time.monotonic()
        if r.status_code == 401 or "DH-901" in r.text:
            self.token_expired = True
            raise TokenExpired("Dhan access token expired or invalid (DH-901). Generate a new one.")
        if r.status_code == 429 or r.status_code >= 500:
            raise DhanError(f"Dhan HTTP {r.status_code}: {r.text[:200]}")
        if not r.ok:
            raise DhanError(f"Dhan HTTP {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError as e:
            raise DhanError("Dhan returned non-JSON") from e

    def expiries(self, symbol):
        """List of expiry dates as 'YYYY-MM-DD' strings, nearest first."""
        body = {"UnderlyingScrip": SCRIP[symbol], "UnderlyingSeg": SEGMENT}
        payload = self._post("/optionchain/expirylist", body)
        data = payload.get("data", payload) if isinstance(payload, dict) else payload
        if not isinstance(data, list):
            raise DhanError(f"unexpected expirylist response: {str(payload)[:200]}")
        return sorted(str(x) for x in data)

    def option_chain(self, symbol, expiry):
        """Returns {"spot": float, "oc": {strike(float): {"ce": {...}|None, "pe": {...}|None}}}."""
        return parse_chain(self.option_chain_raw(symbol, expiry))

    def option_chain_raw(self, symbol, expiry):
        """Dhan's /optionchain response as sent (capture_chain.py saves it as a test fixture)."""
        body = {"UnderlyingScrip": SCRIP[symbol], "UnderlyingSeg": SEGMENT, "Expiry": expiry}
        return self._post("/optionchain", body)

    def ohlc(self, security_ids):
        """Live prices for NSE equities: {"1333": {"ltp": 711.65}, ...}.
        Only last_price is used. ohlc.close / net_change equal today's close after market hours,
        so the previous close comes from historical candles instead (see historical()).
        Market quote allows 1 request / second and up to 1000 instruments per request."""
        payload = self._post("/marketfeed/ohlc", {"NSE_EQ": [int(i) for i in security_ids]}, gap=QUOTE_GAP_SECONDS)
        return parse_ohlc(payload)

    def historical(self, security_id, from_date, to_date):
        """Daily candles for one NSE stock: {"timestamp": [epoch seconds at 00:00 IST, ...], "close": [...]}.
        One request per stock (there is no batch version). Dates are 'YYYY-MM-DD'."""
        body = {"securityId": str(security_id), "exchangeSegment": "NSE_EQ", "instrument": "EQUITY",
                "expiryCode": 0, "oi": False, "fromDate": from_date, "toDate": to_date}
        payload = self._post("/charts/historical", body, gap=HISTORY_GAP_SECONDS)
        ts, close = (payload or {}).get("timestamp"), (payload or {}).get("close")
        if not isinstance(ts, list) or not isinstance(close, list):
            raise DhanError(f"unexpected historical response: {str(payload)[:200]}")
        return {"timestamp": ts, "close": close}

    def intraday(self, symbol, from_dt, to_dt, interval=1, future_id=None, option_id=None):
        """1-minute (or 5/15/25/60) candles: {"timestamp": [epoch s], "open": [...], ..., "volume": [...]}.
        The index by default (no volume); with future_id, that index future (NSE_FNO / FUTIDX, with volume); with
        option_id, that index option (NSE_FNO / OPTIDX: premiums for replays). Market data only, no orders.
        from_dt / to_dt are 'YYYY-MM-DD HH:MM:SS' (IST). Same data-API limit as historical()."""
        if option_id:
            sid, seg, inst = option_id, "NSE_FNO", "OPTIDX"
        elif future_id:
            sid, seg, inst = future_id, "NSE_FNO", "FUTIDX"
        else:
            sid, seg, inst = SCRIP[symbol], SEGMENT, "INDEX"
        body = {"securityId": str(sid), "exchangeSegment": seg, "instrument": inst,
                "interval": str(interval), "oi": False, "fromDate": from_dt, "toDate": to_dt}
        payload = self._post("/charts/intraday", body, gap=HISTORY_GAP_SECONDS)
        if not isinstance(payload, dict) or not isinstance(payload.get("timestamp"), list):
            raise DhanError(f"unexpected intraday response: {str(payload)[:200]}")
        return payload


def parse_ohlc(payload):
    data = ((payload or {}).get("data") or {}).get("NSE_EQ") or {}
    out = {}
    for sid, v in data.items():
        try:
            ltp = float((v or {}).get("last_price") or 0)
        except (TypeError, ValueError):
            continue
        if ltp > 0:
            out[str(sid)] = {"ltp": ltp}
    return out


def parse_chain(payload):
    data = payload.get("data", payload) if isinstance(payload, dict) else None
    if not isinstance(data, dict) or "oc" not in data:
        raise DhanError(f"unexpected optionchain response: {str(payload)[:200]}")
    oc = {}
    for key, legs in (data.get("oc") or {}).items():
        try:
            strike = float(key)
        except ValueError:
            continue
        oc[strike] = {"ce": (legs or {}).get("ce") or None, "pe": (legs or {}).get("pe") or None}
    if not oc:
        raise DhanError("option chain came back empty")
    return {"spot": float(data.get("last_price") or 0), "oc": oc}
