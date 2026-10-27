"""
strategies.py - a user's strategies (User -> Strategy -> paper trades; docs/users-and-strategies.md).

Every call takes the signed-in user and checks ownership first: someone else's strategy is "not found" (404), the same
as one that doesn't exist, so ids of other users' strategies reveal nothing. This is the only way the API reaches a
strategy.

Rules
- Names: 1-60 characters, unique per user ignoring case (archived strategies count, so history keeps its name).
- Capital: 10,000 .. 10,00,00,000 rupees. "Set capital" changes the open period's starting capital; "Reset capital"
  closes the period and opens a new one (old orders, trades and P&L stay with the old period). Both need a flat book
  today (no open position, no pending order), like the Paper Trading and Scalper capital rules.
- Archive: manual strategies only, flat book; archived = read-only (no edits, no orders) until unarchived.
- Algo strategies ("OI Breakout Algo", created by the data migration) can't be created, archived or re-capitalised
  here: the algo owns them. Their name, description and notes can be edited.
"""
from datetime import timedelta, timezone

from paper_api import DEFAULT_CAPITAL, MAX_CAPITAL, MIN_CAPITAL
from store import DuplicateName

IST = timezone(timedelta(hours=5, minutes=30))
NAME_MAX = 60
DESCRIPTION_MAX = 300
NOTES_MAX = 20_000


class NotFound(Exception):
    """No such strategy for this user (also: it belongs to someone else)."""


class Refused(Exception):
    """A valid request the strategy's state doesn't allow (status 409) or bad input (status 400)."""

    def __init__(self, message, status=409):
        super().__init__(message)
        self.message, self.status = message, status


def public(st):
    """What the browser sees (no user or account ids)."""
    return {"id": st["id"], "name": st["name"], "description": st["description"], "notes": st["notes"],
            "capital": st["capital"], "kind": st["kind"], "createdAt": st["created_at"], "updatedAt": st["updated_at"],
            "archivedAt": st["archived_at"]}


class Strategies:
    def __init__(self, store, clock):
        self.store, self.clock = store, clock

    # ------------------------------------------------------------------ read
    def list(self, user, archived=False):
        """Newest activity first. archived=False: active only; True: archived only."""
        rows = [s for s in self.store.strategies(user.id) if bool(s["archived_at"]) == archived]
        return sorted(rows, key=lambda s: s["updated_at"] or "", reverse=True)

    def get(self, user, sid):
        st = self.store.strategy(int(sid)) if str(sid).isdigit() else None
        if not st or st["user_id"] != user.id:
            raise NotFound(sid)
        return st

    def tradable(self, user, sid):
        """A strategy the tools (Paper Trading, Power Scalper) may place orders into."""
        st = self.get(user, sid)
        if st["archived_at"]:
            raise Refused("This strategy is archived. Unarchive it to trade into it.")
        if st["kind"] != "manual":
            raise Refused("Manual orders can't go into an algo strategy.")
        return st

    # ------------------------------------------------------------------ write
    def create(self, user, name, description="", capital=None):
        name, description = self._name(name), self._text(description, DESCRIPTION_MAX, "description")
        capital = self._capital(DEFAULT_CAPITAL if capital is None else capital)
        return self._dup(lambda: self.store.create_strategy(user.id, name, description, capital, "manual", self.clock()),
                         name)

    def edit(self, user, sid, name=None, description=None, notes=None):
        st = self._writable(user, sid)
        fields = {}
        if name is not None:
            fields["name"] = self._name(name)
        if description is not None:
            fields["description"] = self._text(description, DESCRIPTION_MAX, "description")
        if notes is not None:
            fields["notes"] = self._text(notes, NOTES_MAX, "notes", strip=False)
        if not fields:
            return st
        return self._dup(lambda: self.store.update_strategy(st["id"], self.clock(), **fields), fields.get("name", ""))

    def set_capital(self, user, sid, capital):
        st = self._money_ok(user, sid)
        return self.store.strategy_set_capital(st["id"], self._capital(capital), self.clock())

    def reset(self, user, sid, capital=None):
        st = self._money_ok(user, sid)
        return self.store.strategy_reset(st["id"], self._capital(st["capital"] if capital is None else capital),
                                         self.clock())

    def archive(self, user, sid):
        st = self._writable(user, sid)
        if st["kind"] != "manual":
            raise Refused("The algo's strategy can't be archived.")
        self._flat(st, "archiving")
        return self.store.update_strategy(st["id"], self.clock(), archived_at=self.clock())

    def unarchive(self, user, sid):
        st = self.get(user, sid)
        if not st["archived_at"]:
            return st
        return self.store.update_strategy(st["id"], self.clock(), archived_at=None)

    # ------------------------------------------------------------------ checks
    def _writable(self, user, sid):
        st = self.get(user, sid)
        if st["archived_at"]:
            raise Refused("Archived strategies are read-only. Unarchive it first.")
        return st

    def _money_ok(self, user, sid):
        st = self._writable(user, sid)
        if st["kind"] != "manual":
            raise Refused("The algo's capital can't be changed here.")
        self._flat(st, "changing capital")
        return st

    def _flat(self, st, doing):
        day = self.clock().astimezone(IST).date().isoformat()
        if st["account_id"] and self.store.book_open(st["account_id"], day):
            raise Refused(f"Exit open positions and cancel pending orders before {doing}.")

    @staticmethod
    def _name(name):
        name = " ".join(str(name or "").split())
        if not name:
            raise Refused("Give the strategy a name.", 400)
        if len(name) > NAME_MAX:
            raise Refused(f"Names can be at most {NAME_MAX} characters.", 400)
        return name

    @staticmethod
    def _text(text, limit, what, strip=True):
        text = str(text or "")
        text = text.strip() if strip else text
        if len(text) > limit:
            raise Refused(f"The {what} can be at most {limit:,} characters.", 400)
        return text

    @staticmethod
    def _capital(capital):
        try:
            capital = float(capital)
        except (TypeError, ValueError):
            raise Refused("Capital must be a number.", 400) from None
        if not MIN_CAPITAL <= capital <= MAX_CAPITAL:
            raise Refused(f"Capital must be between ₹{MIN_CAPITAL:,} and ₹{MAX_CAPITAL:,}.", 400)
        return capital

    @staticmethod
    def _dup(fn, name):
        try:
            return fn()
        except DuplicateName:
            raise Refused(f"You already have a strategy named “{name}” (archived ones count too).") from None
