"""Quotes endpoint: symbols -> Dhan security IDs -> live prices (fake Dhan, no network)."""
import shutil
import tempfile

from fastapi.testclient import TestClient

from dhan_client import DhanError, TokenExpired, parse_ohlc
from instruments import SecurityIds, parse_csv
from main import create_app
from tracker import Tracker

CSV = """SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME
NSE,E,1333,EQUITY,0,HDFCBANK,1.0,HDFC Bank,,,,5.0000,NA,ES,EQ,HDFC BANK LTD
NSE,E,20753,EQUITY,0,771HDFCB33,1.0,HDFCBK-7.71%-20122033-NCD,,,,1.0000,NA,DEB,N0,HDFC BANK 7.71% 2033 SR1
NSE,E,11536,EQUITY,0,TCS,1.0,Tata Consultancy Services,,,,10.0000,NA,ES,EQ,TATA CONSULTANCY SERV LT
BSE,E,500180,EQUITY,0,HDFCBANK,1.0,HDFC Bank,,,,5.0000,NA,ES,A,HDFC BANK LTD
"""

# real response shape from Dhan
RESP = {"data": {"NSE_EQ": {
    "1333": {"last_price": 711.65, "ohlc": {"open": 733.4, "close": 728.85, "high": 733.4, "low": 711.1}},
    "11536": {"last_price": 2462.3, "ohlc": {"open": 2458, "close": 2465, "high": 2497, "low": 2432.1}}}}, "status": "success"}


class FakeIds:
    def resolve(self, symbols):
        known = {"HDFCBANK": 1333, "TCS": 11536}
        return {s: known[s] for s in symbols if s in known}, [s for s in symbols if s not in known]


class FakeClient:
    client_id, token, token_expired = "x", "y" * 30, False

    def __init__(self):
        self.calls, self.error, self.hist_calls, self.hist_error = 0, None, 0, None

    def expiries(self, symbol):
        return ["2026-10-27"]

    def historical(self, security_id, from_date, to_date):
        self.hist_calls += 1
        self.last_hist = (security_id, from_date, to_date)
        if self.hist_error:
            raise self.hist_error
        return {"timestamp": [1791743400, 1791829800], "close": [704.9, 714.0]}

    def ohlc(self, ids):
        self.calls += 1
        if self.error:
            raise self.error
        return parse_ohlc(RESP)


def make(tmp):
    fake = FakeClient()
    return fake, TestClient(create_app(Tracker(fake, data_dir=tmp), security_ids=FakeIds()))


def test_parse_ohlc_and_csv():
    assert parse_ohlc(RESP)["1333"] == {"ltp": 711.65}  # ohlc.close is NOT used
    assert parse_csv(CSV) == {"HDFCBANK": 1333, "TCS": 11536}  # no bonds, no BSE rows


def test_quotes_endpoint_and_cache():
    tmp = tempfile.mkdtemp()
    try:
        fake, c = make(tmp)
        r = c.get("/api/quotes?symbols=hdfcbank,TCS,NOPE").json()
        assert r["ids"] == {"HDFCBANK": 1333, "TCS": 11536}
        assert r["unknown"] == ["NOPE"]
        assert r["quotes"]["1333"] == {"ltp": 711.65}
        c.get("/api/quotes?symbols=HDFCBANK,TCS")
        assert fake.calls == 1  # second call served from the 2-second cache
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_errors():
    tmp = tempfile.mkdtemp()
    try:
        fake, c = make(tmp)
        assert c.get("/api/quotes").status_code == 400
        assert c.get("/api/quotes?symbols=" + ",".join(f"S{i}" for i in range(101))).status_code == 400
        fake.error = TokenExpired("expired")
        assert c.get("/api/quotes?symbols=TCS").status_code == 401
        fake.error = DhanError("boom")
        assert c.get("/api/quotes?symbols=HDFCBANK").status_code == 502
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_security_ids_cache_survives_offline():
    tmp = tempfile.mkdtemp()
    try:
        class Resp:
            ok, text = True, CSV
            def raise_for_status(self): pass
        class Sess:
            def __init__(self, fail): self.fail = fail
            def get(self, url, timeout):
                if self.fail: raise OSError("offline")
                return Resp()
        path = tmp + "/ids.json"
        assert SecurityIds(path, session=Sess(False)).resolve(["TCS", "X"]) == ({"TCS": 11536}, ["X"])
        again = SecurityIds(path, session=Sess(True))  # restart with no internet: cache is used
        assert again.resolve(["HDFCBANK"]) == ({"HDFCBANK": 1333}, [])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_history_endpoint_cache_and_errors():
    tmp = tempfile.mkdtemp()
    try:
        fake, c = make(tmp)
        r = c.get("/api/history?symbol=hdfcbank").json()
        assert r["symbol"] == "HDFCBANK" and r["id"] == 1333 and r["close"] == [704.9, 714.0]
        sid, frm, to = fake.last_hist
        assert sid == 1333 and frm < to  # ten-day window ending today (IST)
        c.get("/api/history?symbol=HDFCBANK")
        assert fake.hist_calls == 1  # second request comes from the cache
        assert c.get("/api/history?symbol=NOPE").status_code == 404
        assert c.get("/api/history").status_code == 400
        fake.hist_error = DhanError("boom")
        assert c.get("/api/history?symbol=TCS").status_code == 502
        fake.hist_error = None
        assert c.get("/api/history?symbol=TCS").status_code == 200  # the failure was not cached
        fake.hist_error = TokenExpired("expired")
        assert c.get("/api/history?symbol=HDFCBANK").status_code == 200  # cached before the token expired
        assert fake.hist_calls == 3
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
