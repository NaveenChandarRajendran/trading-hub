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
