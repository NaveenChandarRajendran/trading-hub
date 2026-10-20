"""instruments.py option list, on real rows copied from Dhan's api-scrip-master.csv (20-Oct-2026)."""
from instruments import OptionInstruments, parse_index_options

HEADER = ("SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,"
          "SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,"
          "SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME")
ROWS = [
    "NSE,D,35000,OPTIDX,0,BANKNIFTY-Dec2026-69400-CE,30.0,BANKNIFTY 29 DEC 69400 CALL,2026-12-29 14:30:00,69400.00000,CE,5.0000,M,OP,,",
    "NSE,D,35008,OPTIDX,0,NIFTY-Nov2026-17350-CE,65.0,NIFTY 09 NOV 17350 CALL,2026-11-09 14:30:00,17350.00000,CE,5.0000,W,OP,,",
    "NSE,D,35009,OPTIDX,0,NIFTY-Nov2026-17350-PE,65.0,NIFTY 09 NOV 17350 PUT,2026-11-09 14:30:00,17350.00000,PE,5.0000,W,OP,,",
    "NSE,D,35010,OPTIDX,0,FINNIFTY-Nov2026-20000-CE,65.0,FINNIFTY 24 NOV 20000 CALL,2026-11-24 14:30:00,20000.00000,CE,5.0000,M,OP,,",
    "NSE,E,1333,EQUITY,0,HDFCBANK,1.0,HDFC Bank,,,,5.0000,,ES,EQ,HDFC BANK LTD",
]
CSV = "\n".join([HEADER, *ROWS])


def test_parse_index_options():
    r = parse_index_options(CSV)
    assert set(r) == {"35000", "35008", "35009"}  # FINNIFTY and equities left out
    assert r["35000"] == {"securityId": 35000, "symbol": "BANKNIFTY", "expiry": "2026-12-29", "strike": 69400.0,
                          "optionType": "CE", "lotSize": 30, "tickSize": 0.05, "name": "BANKNIFTY 29 DEC 69400 CALL"}


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
