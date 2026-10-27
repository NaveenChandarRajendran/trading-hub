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
    def __init__(self, store, clock, books=None):
        """books: paper_api.PaperService (busy(strategy) from its live engines; reload(strategy) after a capital
        change, reset or archive). Without it (tests of the rules alone) the store's view of today is used."""
        self.store, self.clock, self.books = store, clock, books

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
        return self._reloaded(self.store.strategy_set_capital(st["id"], self._capital(capital), self.clock()))

    def reset(self, user, sid, capital=None):
        st = self._money_ok(user, sid)
        return self._reloaded(self.store.strategy_reset(
            st["id"], self._capital(st["capital"] if capital is None else capital), self.clock()))

    def archive(self, user, sid):
        st = self._writable(user, sid)
        if st["kind"] != "manual":
            raise Refused("The algo's strategy can't be archived.")
        self._flat(st, "archiving")
        return self._reloaded(self.store.update_strategy(st["id"], self.clock(), archived_at=self.clock()))

    def unarchive(self, user, sid):
        st = self.get(user, sid)
        if not st["archived_at"]:
            return st
        return self._reloaded(self.store.update_strategy(st["id"], self.clock(), archived_at=None))

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
        if self.books is not None:
            busy = self.books.busy(st)
        else:
            day = self.clock().astimezone(IST).date().isoformat()
            busy = bool(st["account_id"]) and self.store.book_open(st["account_id"], day)
        if busy:
            raise Refused(f"Exit open positions and cancel pending orders before {doing}.")

    def _reloaded(self, st):
        if self.books is not None:
            self.books.reload(st)
        return st

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


OWNER = ("naveen", "Naveen")  # owns the algo's strategy (docs/users-and-strategies.md)
ALGO_NAME, ALGO_ACCOUNT = "OI Breakout Algo", "Algo"


def bootstrap(pg, capital, now, log=print):
    """First start on users and strategies (Postgres, main.py): user naveen (no password until
    scripts/create_user.py sets one) and his algo strategy "OI Breakout Algo" on the 'Algo' paper account. Paper
    accounts without a strategy left by the code before users existed are removed when empty; one with orders or
    fills stops the start (nothing is deleted). Running it again changes nothing. Returns True when naveen has no
    password yet."""
    with pg._cursor() as cur:
        cur.execute("INSERT INTO th_users (username, display_name) VALUES (%s, %s) ON CONFLICT (username) DO NOTHING",
                    OWNER)
        cur.execute("SELECT id, password_hash IS NULL FROM th_users WHERE username=%s", (OWNER[0],))
        uid, no_password = cur.fetchone()
        cur.execute("SELECT id FROM th_strategies WHERE kind='algo' ORDER BY id LIMIT 1")
        row = cur.fetchone()
        if row is None:
            cur.execute("INSERT INTO th_strategies (user_id, name, capital, kind, created_at, updated_at) "
                        "VALUES (%s, %s, %s, 'algo', %s, %s) RETURNING id", (uid, ALGO_NAME, capital, now, now))
            algo_sid = cur.fetchone()[0]
            log(f"Created the algo's strategy “{ALGO_NAME}” for {OWNER[0]}")
        else:
            algo_sid = row[0]
        cur.execute("SELECT id FROM pt_accounts WHERE strategy_id=%s AND archived_at IS NULL", (algo_sid,))
        if cur.fetchone() is None:
            cur.execute("SELECT id FROM pt_accounts WHERE name=%s AND strategy_id IS NULL AND archived_at IS NULL "
                        "ORDER BY id DESC LIMIT 1", (ALGO_ACCOUNT,))
            acc = cur.fetchone()
            if acc:
                cur.execute("UPDATE pt_accounts SET strategy_id=%s WHERE id=%s", (algo_sid, acc[0]))
            else:
                cur.execute("INSERT INTO pt_accounts (capital, created_at, name, strategy_id) VALUES (%s, %s, %s, %s)",
                            (capital, now, ALGO_ACCOUNT, algo_sid))
        cur.execute("SELECT a.id, a.name, (SELECT count(*) FROM pt_orders o WHERE o.account_id = a.id) "
                    "+ (SELECT count(*) FROM pt_trades t WHERE t.account_id = a.id) FROM pt_accounts a "
                    "WHERE a.strategy_id IS NULL")
        orphans = cur.fetchall()
        used = [(i, n) for i, n, rows in orphans if rows]
        if used:
            raise SystemExit(f"Paper accounts {used} have orders but no strategy. Nothing was changed; "
                             "see docs/users-and-strategies.md.")
        for i, _n, _rows in orphans:
            for t in ("pt_order_levels", "pt_positions", "scalper_daily_summary", "pt_daily_summary"):
                cur.execute(f"DELETE FROM {t} WHERE account_id=%s", (i,))
            cur.execute("DELETE FROM pt_accounts WHERE id=%s", (i,))
        if orphans:
            log(f"Removed {len(orphans)} empty paper account(s) from before users and strategies")
    return no_password
