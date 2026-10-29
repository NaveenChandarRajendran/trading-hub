"""instruments.py option list, on real rows copied from Dhan's api-scrip-master.csv (20-Oct-2026)."""
import json

from instruments import OptionInstruments, parse_index_futures, parse_index_options

HEADER = ("SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,"
          "SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,"
          "SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME")
ROWS = [
    "NSE,D,35000,OPTIDX,0,BANKNIFTY-Dec2026-69400-CE,30.0,BANKNIFTY 29 DEC 69400 CALL,2026-12-29 14:30:00,69400.00000,CE,5.0000,M,OP,,",
    "NSE,D,35008,OPTIDX,0,NIFTY-Nov2026-17350-CE,65.0,NIFTY 09 NOV 17350 CALL,2026-11-09 14:30:00,17350.00000,CE,5.0000,W,OP,,",
    "NSE,D,35009,OPTIDX,0,NIFTY-Nov2026-17350-PE,65.0,NIFTY 09 NOV 17350 PUT,2026-11-09 14:30:00,17350.00000,PE,5.0000,W,OP,,",
    "NSE,D,35010,OPTIDX,0,FINNIFTY-Nov2026-20000-CE,65.0,FINNIFTY 24 NOV 20000 CALL,2026-11-24 14:30:00,20000.00000,CE,5.0000,M,OP,,",
    "NSE,E,1333,EQUITY,0,HDFCBANK,1.0,HDFC Bank,,,,5.0000,,ES,EQ,HDFC BANK LTD",
    "NSE,D,52162,FUTIDX,0,NIFTY-Oct2026-FUT,65.0,NIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,10.0000,M,FUTIDX,,",
    "NSE,D,52170,FUTIDX,0,NIFTY-Nov2026-FUT,65.0,NIFTY NOV FUT,2026-11-24 14:30:00,-0.01000,XX,10.0000,M,FUTIDX,,",
    "NSE,D,52175,FUTIDX,0,BANKNIFTY-Oct2026-FUT,30.0,BANKNIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,20.0000,M,FUTIDX,,",
    "NSE,D,52180,FUTIDX,0,FINNIFTY-Oct2026-FUT,65.0,FINNIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,10.0000,M,FUTIDX,,",
    # BSE (29-Oct-2026): SENSEX options are kept (BSE_FNO), BANKEX left out; a made-up SENSEX row reusing an NSE ID
    # (35009) is dropped by the clash guard, before or after the NSE row in the file
    "BSE,D,1100742,OPTIDX,0,SENSEX-Nov2026-70800-PE,20.0,SENSEX 26 NOV 70800 PUT,2026-11-26 15:30:00,70800.00000,PE,5.0000,M,OPTIDX,,BSXOPT",
    "BSE,D,1100897,OPTIDX,0,BANKEX-Nov2026-70400-CE,30.0,BANKEX 26 NOV 70400 CALL,2026-11-26 15:30:00,70400.00000,CE,5.0000,M,OPTIDX,,BKXOPT",
    "BSE,D,35009,OPTIDX,0,SENSEX-Nov2026-70900-CE,20.0,SENSEX 26 NOV 70900 CALL,2026-11-26 15:30:00,70900.00000,CE,5.0000,M,OPTIDX,,BSXOPT",
]
CSV = "\n".join([HEADER, *ROWS])


def test_parse_index_options():
    r = parse_index_options(CSV)
    assert set(r) == {"35000", "35008", "35009", "1100742"}  # FINNIFTY, BANKEX and equities left out
    assert r["35000"] == {"securityId": 35000, "symbol": "BANKNIFTY", "segment": "NSE_FNO", "expiry": "2026-12-29",
                          "strike": 69400.0, "optionType": "CE", "lotSize": 30, "tickSize": 0.05,
                          "name": "BANKNIFTY 29 DEC 69400 CALL"}
    assert r["1100742"] == {"securityId": 1100742, "symbol": "SENSEX", "segment": "BSE_FNO", "expiry": "2026-11-26",
                            "strike": 70800.0, "optionType": "PE", "lotSize": 20, "tickSize": 0.05,
                            "name": "SENSEX 26 NOV 70800 PUT"}
    assert r["35009"]["symbol"] == "NIFTY"  # the clashing BSE row never replaces the NSE option


def test_clash_guard_keeps_nse_wherever_the_bse_row_sits():
    reordered = "\n".join([HEADER, ROWS[-1], *ROWS[:-1]])  # the clashing SENSEX row first
    assert parse_index_options(reordered)["35009"]["symbol"] == "NIFTY"


def test_a_cache_from_before_sensex_is_downloaded_again(tmp_path):
    path = tmp_path / "opts.json"
    path.write_text(json.dumps({"day": "2026-10-20", "rows": {"35000": {"securityId": 35000, "symbol": "BANKNIFTY"}}}))
    s = FakeSession()
    inst = OptionInstruments(str(path), session=s, today=lambda: "2026-10-20")  # same day, but no version 2
    assert inst.get(1100742)["segment"] == "BSE_FNO" and s.calls == 1
    assert json.loads(path.read_text())["version"] == 2


class FakeSession:
    def __init__(self):
        self.calls = 0

    def get(self, url, timeout):
        self.calls += 1

        class R:
            text = CSV

            def raise_for_status(self):
                pass
        return R()


def test_cached_per_ist_day(tmp_path):
    day = ["2026-10-21"]
    s = FakeSession()
    inst = OptionInstruments(str(tmp_path / "opt.json"), session=s, today=lambda: day[0])
    assert inst.get(35008)["lotSize"] == 65
    assert inst.get(35009)["optionType"] == "PE" and s.calls == 1
    assert OptionInstruments(str(tmp_path / "opt.json"), session=s, today=lambda: day[0]).get(35000) and s.calls == 1
    day[0] = "2026-10-22"
    inst.get(35008)
    assert s.calls == 2  # new IST day -> fresh download


def test_expiries_and_chain(tmp_path):
    inst = OptionInstruments(str(tmp_path / "opt.json"), session=FakeSession(), today=lambda: "2026-10-21")
    assert inst.expiries("NIFTY") == ["2026-11-09"]
    assert inst.expiries("NIFTY", today="2026-11-10") == []
    [row] = inst.chain("NIFTY", "2026-11-09")
    assert row["strike"] == 17350.0 and row["ce"]["securityId"] == 35008 and row["pe"]["securityId"] == 35009


def test_parse_index_futures_kept_apart_from_options():
    f = parse_index_futures(CSV)
    assert [x["securityId"] for x in f] == [52175, 52162, 52170]  # BANKNIFTY, then NIFTY by expiry; FINNIFTY left out
    assert f[1] == {"securityId": 52162, "symbol": "NIFTY", "expiry": "2026-10-27", "lotSize": 65, "name": "NIFTY OCT FUT"}
    assert "52162" not in parse_index_options(CSV)  # never part of the option list / chain


def test_near_future_rolls_the_day_after_expiry(tmp_path):
    day = ["2026-10-21"]
    inst = OptionInstruments(str(tmp_path / "opt.json"), session=FakeSession(), today=lambda: day[0])
    assert inst.near_future("NIFTY")["securityId"] == 52162
    day[0] = "2026-10-27"  # expiry day: still the October future
    assert inst.near_future("NIFTY")["securityId"] == 52162
    day[0] = "2026-10-28"  # the day after: November
    assert inst.near_future("NIFTY")["securityId"] == 52170
    assert inst.near_future("BANKNIFTY") is None  # no November BANKNIFTY future in this file
    assert inst.future_ids() == {52162, 52170, 52175}


def test_old_cache_without_futures_downloads_once(tmp_path):
    path = tmp_path / "opt.json"
    path.write_text(json.dumps({"day": "2026-10-21", "rows": parse_index_options(CSV)}))  # written before futures
    s = FakeSession()
    inst = OptionInstruments(str(path), session=s, today=lambda: "2026-10-21")
    assert inst.future_ids() == set() and s.calls == 0  # future_ids never downloads
    assert inst.near_future("NIFTY")["securityId"] == 52162 and s.calls == 1
    inst.near_future("NIFTY")
    assert s.calls == 1
