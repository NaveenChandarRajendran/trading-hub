from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

import builder_store
from sig_indicators import IST


def client(tmp_path):
    app = FastAPI()
    builder_store.register(app, builder_store.BuilderStore(str(tmp_path), clock=lambda: datetime(2026, 10, 30, 11, 5, tzinfo=IST)))
    return TestClient(app)


STRADDLE = {"name": "Sensibull straddle", "group": "My learning", "symbol": "NIFTY", "expiry": "2026-11-04", "lot": 65,
            "spot": 24000, "legs": [{"side": "CE", "strike": 24000, "short": True, "lots": 1, "price": 120},
                                    {"side": "PE", "strike": 24000, "short": True, "lots": 1, "price": 110}]}


def test_save_rename_close_delete(tmp_path):
    c = client(tmp_path)
    item = c.post("/api/builder/saved", json=STRADDLE).json()
    assert item["created"] == "2026-10-30 11:05" and item["closed"] is None
    assert c.put(f"/api/builder/saved/{item['id']}", json={"name": "Straddle A", "group": "Sensibull"}).json()["group"] == "Sensibull"
    done = c.put(f"/api/builder/saved/{item['id']}", json={"close": [100, 90]}).json()
    assert done["pnl"] == (20 + 20) * 65 and done["closed"]  # both sold legs fell by 20
    assert c.put(f"/api/builder/saved/{item['id']}", json={"close": [1, 1]}).status_code == 400
    assert c.get("/api/builder/saved").json()["rows"][0]["name"] == "Straddle A"
    assert c.delete(f"/api/builder/saved/{item['id']}").json() == {"ok": True}
    assert c.get("/api/builder/saved").json()["rows"] == []


def test_bad_input(tmp_path):
    c = client(tmp_path)
    assert c.post("/api/builder/saved", json={**STRADDLE, "legs": []}).status_code == 422
    assert c.post("/api/builder/saved", json={**STRADDLE, "symbol": "SENSEX"}).status_code == 422
    item = c.post("/api/builder/saved", json=STRADDLE).json()
    assert c.put(f"/api/builder/saved/{item['id']}", json={"close": [1]}).status_code == 400
    assert c.delete("/api/builder/saved/nope").status_code == 404


def test_bought_leg_pnl():
    item = {"lot": 30, "legs": [{"short": False, "lots": 2, "price": 100, "exitPrice": 150}]}
    assert builder_store.pnl(item) == 3000
