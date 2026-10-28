"""
builder.py - Strategy Builder drafts: a named design (index, multiplier, up to 8 legs) saved per user
(docs/features/strategy-builder.md). Designs only: nothing here places an order.

Rules
- Drafts are private: someone else's draft is "not found" (404), like one that doesn't exist.
- name 1-60 characters; symbol NIFTY | BANKNIFTY; multiplier 1-50; at most 8 legs, each with side B | S, type CE | PE,
  expiry YYYY-MM-DD, strike > 0, lots 1-100, include true | false and priceOverride null or >= 0 (null = live price).
"""
import re

from strategies import NotFound, Refused

SYMBOLS = ("NIFTY", "BANKNIFTY")
NAME_MAX = 60
MAX_LEGS = 8


def public_draft(d):
    return {"id": d["id"], "name": d["name"], "symbol": d["symbol"], "multiplier": d["multiplier"], "legs": d["legs"],
            "createdAt": d["created_at"], "updatedAt": d["updated_at"]}


class Drafts:
    def __init__(self, store, clock):
        self.store, self.clock = store, clock

    def list(self, user):
        return sorted(self.store.builder_drafts(user.id), key=lambda d: (d["updated_at"], d["id"]), reverse=True)  # newest first

    def get(self, user, did):
        d = self.store.builder_draft(int(did)) if str(did).isdigit() else None
        if not d or d["user_id"] != user.id:
            raise NotFound(did)
        return d

    def create(self, user, name, symbol, multiplier, legs):
        return self.store.add_builder_draft(user.id, self._name(name), self._symbol(symbol), self._multiplier(multiplier),
                                            self._legs(legs), self.clock())

    def update(self, user, did, name=None, symbol=None, multiplier=None, legs=None):
        d = self.get(user, did)
        fields = {}
        if name is not None:
            fields["name"] = self._name(name)
        if symbol is not None:
            fields["symbol"] = self._symbol(symbol)
        if multiplier is not None:
            fields["multiplier"] = self._multiplier(multiplier)
        if legs is not None:
            fields["legs"] = self._legs(legs)
        return self.store.update_builder_draft(d["id"], self.clock(), **fields) if fields else d

    def delete(self, user, did):
        self.store.delete_builder_draft(self.get(user, did)["id"])

    # ------------------------------------------------------------------ checks
    @staticmethod
    def _name(v):
        v = " ".join(str(v or "").split())
        if not v or len(v) > NAME_MAX:
            raise Refused(f"Give the draft a name (at most {NAME_MAX} characters).", 400)
        return v

    @staticmethod
    def _symbol(v):
        v = str(v or "").upper()
        if v not in SYMBOLS:
            raise Refused("Index must be NIFTY or BANKNIFTY.", 400)
        return v

    @staticmethod
    def _multiplier(v):
        try:
            v = int(v)
        except (TypeError, ValueError):
            raise Refused("Multiplier must be a whole number.", 400) from None
        if not 1 <= v <= 50:
            raise Refused("Multiplier must be between 1 and 50.", 400)
        return v

    @staticmethod
    def _legs(legs):
        if not isinstance(legs, list) or len(legs) > MAX_LEGS:
            raise Refused(f"A draft has at most {MAX_LEGS} legs.", 400)
        out = []
        for i, leg in enumerate(legs, 1):
            try:
                side, typ, expiry = leg["side"], leg["type"], str(leg["expiry"])
                strike, lots = float(leg["strike"]), int(leg["lots"])
                price = leg.get("priceOverride")
                price = None if price is None else float(price)
            except (KeyError, TypeError, ValueError):
                raise Refused(f"Leg {i}: needs side, type, expiry, strike and lots.", 400) from None
            if side not in ("B", "S") or typ not in ("CE", "PE") or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiry):
                raise Refused(f"Leg {i}: side B / S, type CE / PE, expiry YYYY-MM-DD.", 400)
            if strike <= 0 or not 1 <= lots <= 100 or (price is not None and price < 0):
                raise Refused(f"Leg {i}: strike above 0, lots 1-100, price 0 or more.", 400)
            out.append({"side": side, "type": typ, "expiry": expiry, "strike": strike, "lots": lots,
                        "include": bool(leg.get("include", True)), "priceOverride": price})
        return out
