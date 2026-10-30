"""
builder_store.py - the owner's saved test strategies from the Option Sell page's strategy builder (owner 30-Oct-2026:
"if I create a test strategy using builder, can I also track the P&L of those ... a name and a sub name").

PAPER ONLY: a saved strategy is a note of legs and the prices they were "taken" at. Nothing is ever ordered; the page
works out the running P&L from the live option chain. Stored in data/builder_saved.json.

Endpoints: GET /api/builder/saved, POST /api/builder/saved, PUT /api/builder/saved/{id}, DELETE /api/builder/saved/{id}.
"""
import json
import os
import threading
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

from sig_indicators import IST


class Leg(BaseModel):
    side: str = Field(pattern="^(CE|PE)$")
    strike: float
    short: bool
    lots: int = Field(ge=1, le=100)
    price: float = Field(ge=0)  # the price it was taken at
    exitPrice: Optional[float] = None  # set when the strategy is closed


class NewSaved(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    group: str = Field(default="My learning", max_length=80)  # the sub name (portfolio), e.g. "Sensibull ideas"
    symbol: str = Field(pattern="^(NIFTY|BANKNIFTY)$")
    expiry: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    lot: int = Field(ge=1)
    spot: Optional[float] = None
    legs: List[Leg] = Field(min_length=1, max_length=12)


class EditSaved(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    group: Optional[str] = Field(default=None, max_length=80)
    note: Optional[str] = Field(default=None, max_length=500)
    close: Optional[List[float]] = None  # exit price per leg, in the legs' order: closes the strategy and locks its P&L


def pnl(item, prices=None):
    """Rupees: sold legs gain when the price falls. prices = exit or current price per leg (default: the saved exits)."""
    total = 0.0
    for i, lg in enumerate(item["legs"]):
        now = (prices[i] if prices is not None else lg.get("exitPrice"))
        if now is None:
            return None
        qty = lg["lots"] * item["lot"]
        total += (lg["price"] - now) * qty if lg["short"] else (now - lg["price"]) * qty
    return round(total, 2)


class BuilderStore:
    def __init__(self, data_dir="data", clock=lambda: datetime.now(IST)):
        self.path = os.path.join(data_dir, "builder_saved.json")
        self.clock = clock
        self.lock = threading.Lock()

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return []

    def save(self, items):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=1)
        os.replace(tmp, self.path)

    def add(self, body: NewSaved):
        now = self.clock()
        item = {**body.model_dump(), "id": uuid.uuid4().hex[:10], "created": now.strftime("%Y-%m-%d %H:%M"),
                "closed": None, "pnl": None, "note": ""}
        with self.lock:
            items = self.load()
            items.append(item)
            self.save(items)
        return item

    def edit(self, sid, body: EditSaved):
        with self.lock:
            items = self.load()
            item = next((x for x in items if x["id"] == sid), None)
            if item is None:
                raise HTTPException(404, "No saved strategy with that id")
            for k in ("name", "group", "note"):
                v = getattr(body, k)
                if v is not None:
                    item[k] = v.strip() if k != "note" else v
            if body.close is not None:
                if item["closed"]:
                    raise HTTPException(400, "Already closed")
                if len(body.close) != len(item["legs"]) or any(p < 0 for p in body.close):
                    raise HTTPException(400, "Give one exit price (0 or more) per leg")
                for lg, p in zip(item["legs"], body.close):
                    lg["exitPrice"] = p
                item["closed"] = self.clock().strftime("%Y-%m-%d %H:%M")
                item["pnl"] = pnl(item)
            self.save(items)
        return item

    def delete(self, sid):
        with self.lock:
            items = self.load()
            left = [x for x in items if x["id"] != sid]
            if len(left) == len(items):
                raise HTTPException(404, "No saved strategy with that id")
            self.save(left)
        return {"ok": True}


def register(app, store: BuilderStore):
    @app.get("/api/builder/saved")
    def saved():
        return {"rows": store.load()}

    @app.post("/api/builder/saved")
    def add(body: NewSaved):
        return store.add(body)

    @app.put("/api/builder/saved/{sid}")
    def edit(sid: str, body: EditSaved):
        return store.edit(sid, body)

    @app.delete("/api/builder/saved/{sid}")
    def delete(sid: str):
        return store.delete(sid)
