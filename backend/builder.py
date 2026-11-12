"""
builder.py - Strategy Builder drafts: a named design (index, multiplier, up to 8 legs) saved per user
(docs/features/strategy-builder.md), the user's rules ("Save as weekly rule", th_builder_rules) and the Review
step's check thresholds (th_user_prefs). Designs only: nothing here places an order.

Rules
- Drafts are private: someone else's draft is "not found" (404), like one that doesn't exist.
- name 1-60 characters; symbol NIFTY | BANKNIFTY | SENSEX; multiplier 1-50; at most 8 legs, each with side B | S, type CE | PE,
  expiry YYYY-MM-DD, strike > 0, lots 1-100, include true | false and priceOverride null or >= 0 (null = live price).
"""
import json
import re

from strategies import NotFound, Refused

SYMBOLS = ("NIFTY", "BANKNIFTY", "SENSEX")
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
            raise Refused("Index must be NIFTY, BANKNIFTY or SENSEX.", 400)
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


# ====================================================================== weekly / monthly rules (th_builder_rules)
# A rule is a template with its numbers, saved from the Builder's Review step ("Save as weekly rule"). Strategy Lab will
# run them later; today they are listed under "My rules". The spec says how the strikes, wings and expiry are found:
#   strikeMode  "pct": shortPutPct (% from spot, below 0) rounded putRound, shortCallPct (above 0) rounded callRound
#               "delta": the strikes with |delta| closest to deltaTarget, allowed deltaMin..deltaMax
#   wingMode    "pct": wingPct of spot rounded to wingRoundTo points (null = the strike step) | "points": wingPoints
#   expiryMode  "nextWeekly" | "nextMonthly";  lots;  targetPct, timeExitDays, minCreditPct (null = none)
RULE_TEMPLATES = ("iron-condor-a", "iron-condor-b", "ic-monthly-delta", "iron-condor")
ROUNDING = ("down", "up", "nearest")


def public_rule(r):
    return {"id": r["id"], "name": r["name"], "symbol": r["symbol"], "spec": r["spec"], "createdAt": r["created_at"],
            "updatedAt": r["updated_at"]}


def _num(spec, key, lo, hi, *, null=False, whole=False):
    v = spec.get(key)
    if v is None:
        if null:
            return None
        raise Refused(f"Rule: {key} is needed.", 400)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise Refused(f"Rule: {key} must be a number.", 400)
    if whole and v != int(v):
        raise Refused(f"Rule: {key} must be a whole number.", 400)
    if not lo <= v <= hi:
        raise Refused(f"Rule: {key} must be between {lo:g} and {hi:g}.", 400)
    return int(v) if whole else float(v)


def rule_spec(spec):
    """A validated copy of a rule spec (Refused 400 with the reason)."""
    if not isinstance(spec, dict):
        raise Refused("Rule: the spec is missing.", 400)
    out = {}
    if spec.get("template") not in RULE_TEMPLATES:
        raise Refused(f"Rule: template must be one of {', '.join(RULE_TEMPLATES)}.", 400)
    out["template"] = spec["template"]
    mode = spec.get("strikeMode")
    if mode == "pct":
        out["shortPutPct"] = _num(spec, "shortPutPct", -20, 0)
        out["shortCallPct"] = _num(spec, "shortCallPct", 0, 20)
        for k in ("putRound", "callRound"):
            if spec.get(k) not in ROUNDING:
                raise Refused(f"Rule: {k} must be down, up or nearest.", 400)
            out[k] = spec[k]
    elif mode == "delta":
        for k in ("deltaTarget", "deltaMin", "deltaMax"):
            out[k] = _num(spec, k, 0.01, 0.5)
        if not out["deltaMin"] <= out["deltaTarget"] <= out["deltaMax"]:
            raise Refused("Rule: deltaMin <= deltaTarget <= deltaMax.", 400)
    else:
        raise Refused("Rule: strikeMode must be pct or delta.", 400)
    out["strikeMode"] = mode
    wing = spec.get("wingMode")
    if wing == "pct":
        out["wingPct"] = _num(spec, "wingPct", 0.05, 20)
        out["wingRoundTo"] = _num(spec, "wingRoundTo", 1, 5000, null=True)
    elif wing == "points":
        out["wingPoints"] = _num(spec, "wingPoints", 1, 20000)
    else:
        raise Refused("Rule: wingMode must be pct or points.", 400)
    out["wingMode"] = wing
    if spec.get("expiryMode") not in ("nextWeekly", "nextMonthly"):
        raise Refused("Rule: expiryMode must be nextWeekly or nextMonthly.", 400)
    out["expiryMode"] = spec["expiryMode"]
    out["lots"] = _num(spec, "lots", 1, 100, whole=True)
    out["targetPct"] = _num(spec, "targetPct", 1, 100, null=True)
    out["timeExitDays"] = _num(spec, "timeExitDays", 0, 60, null=True, whole=True)
    out["minCreditPct"] = _num(spec, "minCreditPct", 0, 5, null=True)
    return out


class Rules:
    """The user's saved rules (private, like drafts: someone else's is "not found")."""

    def __init__(self, store, clock):
        self.store, self.clock = store, clock

    def list(self, user):
        return sorted(self.store.builder_rules(user.id), key=lambda r: (r["updated_at"], r["id"]), reverse=True)

    def get(self, user, rid):
        r = self.store.builder_rule(int(rid)) if str(rid).isdigit() else None
        if not r or r["user_id"] != user.id:
            raise NotFound(rid)
        return r

    def create(self, user, name, symbol, spec):
        return self.store.add_builder_rule(user.id, Drafts._name(name), Drafts._symbol(symbol), rule_spec(spec), self.clock())

    def update(self, user, rid, name=None, spec=None):
        r = self.get(user, rid)
        fields = {}
        if name is not None:
            fields["name"] = Drafts._name(name)
        if spec is not None:
            fields["spec"] = rule_spec(spec)
        return self.store.update_builder_rule(r["id"], self.clock(), **fields) if fields else r

    def delete(self, user, rid):
        self.store.delete_builder_rule(self.get(user, rid)["id"])


# ====================================================================== the Review step's check thresholds (th_user_prefs)
CHECK_PREF = "builder.checks"
CHECK_DEFAULTS = {"maxLossToProfit": 2.0, "maxDeltaPerUnit": 0.10, "maxLossPct": 6.0, "maxCombinedPct": 10.0}
CHECK_LIMITS = {"maxLossToProfit": (0.1, 20), "maxDeltaPerUnit": (0.01, 1), "maxLossPct": (0.1, 100), "maxCombinedPct": (0.1, 100)}


def check_thresholds(store, user):
    raw = store.user_pref(user.id, CHECK_PREF)
    try:
        saved = json.loads(raw) if raw else {}
    except ValueError:
        saved = {}
    return {k: float(saved.get(k, v)) for k, v in CHECK_DEFAULTS.items()}


def save_check_thresholds(store, user, values):
    cur = check_thresholds(store, user)
    if not isinstance(values, dict):
        raise Refused("Send the check settings as an object.", 400)
    for k, v in values.items():
        if k not in CHECK_DEFAULTS:
            raise Refused(f"Unknown check setting {k}.", 400)
        lo, hi = CHECK_LIMITS[k]
        cur[k] = _num({k: v}, k, lo, hi)
    store.set_user_pref(user.id, CHECK_PREF, json.dumps(cur))
    return cur
