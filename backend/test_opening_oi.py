from datetime import datetime

from chain_cache import ChainCache, OpeningOi, chain_response
from sig_indicators import IST


class FakeClient:
    def __init__(self):
        self.oi = 100

    def option_chain(self, symbol, expiry):
        self.oi += 10
        return {"spot": 22600.0, "oc": {22600.0: {"ce": {"oi": self.oi, "previous_oi": 50}, "pe": {"oi": 70, "previous_oi": 60}}}}


def at(hm):
    return datetime.fromisoformat(f"2026-10-26T{hm}:00").replace(tzinfo=IST)


def test_first_chain_from_0915_is_the_baseline_and_survives_a_restart(tmp_path):
    now = [at("09:10")]
    c = ChainCache(FakeClient(), clock=lambda: now[0], opening=OpeningOi(str(tmp_path)))
    e, _ = c.get("NIFTY", "2026-10-27", max_age=0)
    assert e.opening is None  # before 09:15
    now[0] = at("09:15")
    e, _ = c.get("NIFTY", "2026-10-27", max_age=0)
    assert e.opening[0] == "09:15:00" and e.opening[1][22600.0] == (120.0, 70.0)
    now[0] = at("10:00")
    e, _ = c.get("NIFTY", "2026-10-27", max_age=0)
    body = chain_response("NIFTY", "2026-10-27", e, False, 65, now[0], True, False)
    assert body["meta"]["openOiAt"] == "09:15:00"
    assert body["rows"][0]["ce"]["oi"] == 130 and body["rows"][0]["ce"]["open_oi"] == 120.0
    # restart: a new cache reads the saved morning baseline instead of taking a new one
    c2 = ChainCache(FakeClient(), clock=lambda: now[0], opening=OpeningOi(str(tmp_path)))
    e2, _ = c2.get("NIFTY", "2026-10-27", max_age=0)
    assert e2.opening[0] == "09:15:00"
