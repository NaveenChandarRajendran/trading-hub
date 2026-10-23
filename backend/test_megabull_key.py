import json

from megabull_client import load_key


def test_key_file_written_by_windows_powershell_with_a_bom_is_read(tmp_path):
    # Start_Trading_Day (PowerShell 5, Set-Content -Encoding UTF8) writes a byte-order mark; the owner's key failed on it
    p = tmp_path / "megabull.json"
    p.write_bytes(b"\xef\xbb\xbf" + json.dumps({"apiKey": "test-key-not-real", "createdOn": "2026-10-23"}).encode())
    key, created = load_key(str(p))
    assert key == "test-key-not-real"
    assert str(created) == "2026-10-23"
