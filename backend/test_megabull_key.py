import json

from megabull_client import load_key


def test_key_file_written_by_windows_powershell_with_a_bom_is_read(tmp_path):
    # Start_Trading_Day (PowerShell 5, Set-Content -Encoding UTF8) writes a byte-order mark; the owner's key failed on it
    p = tmp_path / "megabull.json"
    p.write_bytes(b"\xef\xbb\xbf" + json.dumps({"apiKey": "test-key-not-real", "createdOn": "2026-10-23"}).encode())
    key, created = load_key(str(p))
    assert key == "test-key-not-real"
    assert str(created) == "2026-10-23"


class _Resp:
    def __init__(self, text, status=200):
        self.text, self.status_code, self.ok = text, status, status < 400
        self.content = text.encode()


class _Session:
    def __init__(self, csv_text):
        self.csv_text, self.calls = csv_text, []

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append((url, headers))
        return _Resp('{"downloadUrl":"https://example-bucket.s3.amazonaws.com/Instrument-default.csv"}')

    def get(self, url, timeout=None, headers=None):
        self.calls.append((url, headers))
        return _Resp(self.csv_text)


def test_instrument_list_follows_the_download_link_without_sending_the_key(tmp_path):
    p = tmp_path / "megabull.json"
    p.write_text(json.dumps({"apiKey": "test-key-not-real", "createdOn": "2026-10-23"}))
    from megabull_client import MegaBullClient
    s = _Session("instrumentToken,name,expiry,strike,instrumentType,lotSize\n123,NIFTY,2026-10-27,25000,CE,75\n")
    c = MegaBullClient(str(p), session=s)
    c._last = -10
    assert c.instruments_csv().startswith("instrumentToken")
    assert s.calls[1][0].endswith("Instrument-default.csv") and not s.calls[1][1]  # no api-key on the file download
    assert c.instruments()[0]["token"] == "123"


def test_megabull_instrument_file_layout_seen_on_23_oct():
    from megabull_client import parse_instruments
    text = ('"tradingSymbol","instrumentName","instrumentToken"\n"NIFTY 50","NIFTY 50","256265"\n'
            '"NIFTY26OCTFUT","NIFTY 27 OCT  FUT","12468226"\n"NIFTY26OCT22900CE","NIFTY 27 OCT 22900 CE","13145090"\n'
            '"NIFTY26N0322900PE","NIFTY 03 NOV 22900 PE","1"\n"BANKNIFTY26NOV52000CE","BANKNIFTY 23 NOV 52000 CE","2"\n')
    rows = parse_instruments(text)
    assert [(r["symbol"], r["expiry"], r["strike"], r["optionType"], r["token"]) for r in rows] == [
        ("NIFTY", "2026-10-27", 22900.0, "CE", "13145090"), ("NIFTY", "2026-11-03", 22900.0, "PE", "1"),
        ("BANKNIFTY", "2026-11-23", 52000.0, "CE", "2")]


def test_megabull_lot_size_comes_from_dhan_with_a_fallback():
    from autopaper import MegaBullAccount
    assert MegaBullAccount(None, True, 2, lot_size=lambda s: 75)._lot("NIFTY") == 75
    assert MegaBullAccount(None, True, 2, lot_size=lambda s: 1 / 0)._lot("BANKNIFTY") == 30


def test_order_status_reads_megabulls_open_and_executed_lists():
    """/api/order/my answers {"open": [...], "executed": [...]} (real response, 26-Oct-2026)."""
    from megabull_client import MegaBullClient

    c = MegaBullClient.__new__(MegaBullClient)
    c._call = lambda method, path, body=None: {
        "open": [{"id": 9, "status": "TRIGGER PENDING", "price": 140.0}],
        "executed": [{"id": 817389, "instrumentName": "NIFTY 27 OCT 22450 CE", "qty": 65, "type": "BUY",
                      "price": 166.25, "status": "COMPLETE"}]}
    assert c.order_status("817389")["status"] == "COMPLETE" and c.order_status(817389)["avgPrice"] == 166.25
    assert c.order_status("9")["status"] == "TRIGGER PENDING"
    assert c.order_status("1") is None


def test_cancel_sends_a_plain_list_of_numeric_ids():
    """MegaBull refuses {"orderIds": [...]} with HTTP 400; a plain list works (26-Oct-2026 test order)."""
    from megabull_client import MegaBullClient

    sent = []
    c = MegaBullClient.__new__(MegaBullClient)
    c._call = lambda method, path, body=None: sent.append((method, path, body))
    c.cancel(["817533"])
    assert sent == [("PUT", "/api/order/bulk/cancel", [817533])]
