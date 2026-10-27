"""DhanClient.check_token: read-only GET /profile, run at startup and 09:00 by the algo."""
import requests

from dhan_client import DhanClient


class Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.text = body if isinstance(body, str) else str(body)
        self.ok = status < 400

    def json(self):
        if isinstance(self._body, str):
            raise ValueError("not json")
        return self._body


class Session:
    def __init__(self, resp):
        self.resp, self.calls = resp, []

    def get(self, url, headers=None, timeout=None):
        self.calls.append((url, headers))
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp

    def post(self, *a, **k):  # pragma: no cover - check_token must never POST
        raise AssertionError("check_token must not POST")


def client(resp):
    return DhanClient("CID", "TOKEN", session=Session(resp))


def test_valid_token():
    c = client(Resp(200, {"dhanClientId": "CID", "tokenValidity": "27/10/2026 08:30"}))
    assert c.check_token() == (True, "valid until 27/10/2026 08:30") and not c.token_expired
    url, headers = c.session.calls[0]
    assert url == "https://api.dhan.co/v2/profile" and headers["access-token"] == "TOKEN" and headers["client-id"] == "CID"


def test_expired_token_sets_token_expired():
    for resp in (Resp(401, "Unauthorized"), Resp(400, '{"errorCode": "DH-901", "errorMessage": "Invalid token"}')):
        c = client(resp)
        assert c.check_token() == (False, "Dhan access token expired or invalid (DH-901)") and c.token_expired


def test_dhan_down_or_network_error_is_unknown_not_invalid():
    c = client(Resp(502, "<html>502 Bad Gateway</html>"))
    ok, msg = c.check_token()
    assert ok is None and msg.startswith("Dhan HTTP 502") and not c.token_expired
    c = client(requests.ConnectionError("no route"))
    assert c.check_token()[0] is None and not c.token_expired


def test_missing_credentials(monkeypatch):
    monkeypatch.delenv("DHAN_CLIENT_ID", raising=False)
    monkeypatch.delenv("DHAN_ACCESS_TOKEN", raising=False)
    assert DhanClient("", "", session=Session(Resp(200, {}))).check_token() == (False, "DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set")
