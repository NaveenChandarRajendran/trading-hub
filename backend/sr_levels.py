"""
sr_levels.py - OI support / resistance levels with a stability rule, and their history. Pure: no network, no clock.

Raw ranking (same as OI Support & Resistance's topLevels in levels.ts, parity-tested):
    R: top 3 call-OI strikes with spot <= strike <= spot + range;  S: top 3 put-OI strikes with spot - range <= strike < spot.
    Ties keep the lower strike. R1 / S1 = nearest to spot.
Stability rule (per side, applied every refresh = every tracker minute):
    - A strike that is not a current level replaces the WEAKEST current level only when its OI is at least
      lead_pct % above that level's OI on `confirm` consecutive refreshes. A brief flip resets the count.
    - A level spot has moved through (crossed) or that left the range is replaced at once (reason "crossed" / "range").
    - Missing levels (fewer than 3 strikes in range) are filled at once.
OI is in units, as Dhan reports it (contracts = units / lot size).
"""
from dataclasses import dataclass, field

SIDES = ("R", "S")
DEFAULTS = {"leadPct": 10.0, "confirmRefreshes": 3, "range": 500}


def side_oi(oc, side):
    """{strike: OI} for one side of a Dhan chain ({strike: {"ce": {...}, "pe": {...}}}); R = calls, S = puts."""
    leg = "ce" if side == "R" else "pe"
    return {float(k): float((v.get(leg) or {}).get("oi") or 0) for k, v in oc.items()}


def in_range(side, strike, spot, range_pts):
    return spot <= strike <= spot + range_pts if side == "R" else spot - range_pts <= strike < spot


def rank_levels(oi, spot, side, range_pts, count=3):
    """Top `count` strikes by OI in the side's range, as [(strike, oi)] numbered nearest first (R1 / S1 first)."""
    picked = sorted((k for k in sorted(oi) if in_range(side, k, spot, range_pts)), key=lambda k: -oi[k])[:count]
    return [(k, oi[k]) for k in sorted(picked, reverse=(side == "S"))]


def number(side, strikes):
    """Nearest first: R ascending, S descending."""
    return sorted(strikes, reverse=(side == "S"))


@dataclass
class SideState:
    strikes: list = field(default_factory=list)  # accepted levels, nearest first
    challenger: float | None = None
    streak: int = 0


@dataclass
class LevelState:
    """Accepted levels for one (symbol, expiry) and the pending challengers."""
    sides: dict = field(default_factory=lambda: {s: SideState() for s in SIDES})
    started: bool = False  # the day's first refresh opens every slot

    @classmethod
    def from_slots(cls, slots):
        """Resume from the open history rows ({"R1": strike, ...}) after a backend restart."""
        st = cls(started=bool(slots))
        for side in SIDES:
            st.sides[side].strikes = number(side, [k for slot, k in slots.items() if slot[0] == side])
        return st

    def slots(self):
        return {f"{side}{i + 1}": k for side in SIDES for i, k in enumerate(self.sides[side].strikes)}

    def update(self, oc, spot, settings):
        """One refresh. Returns {slot: (strike, reason)} for every slot whose strike changed, with strike None for a slot
        that no longer has a level. The first call of the day opens every slot (reason "open")."""
        lead = 1 + float(settings.get("leadPct", DEFAULTS["leadPct"])) / 100
        confirm = int(settings.get("confirmRefreshes", DEFAULTS["confirmRefreshes"]))
        range_pts = float(settings.get("range", DEFAULTS["range"]))
        before = self.slots()
        added, gone = {}, {}  # strike -> why it came in / why it went out
        for side in SIDES:
            oi = side_oi(oc, side)
            s = self.sides[side]
            raw = rank_levels(oi, spot, side, range_pts)
            if not self.started:  # first refresh of the day
                s.strikes = [k for k, _ in raw]
                added.update({k: "open" for k in s.strikes})
                continue
            # a level spot moved through, or that is out of range now, goes at once
            kept = []
            for k in s.strikes:
                if in_range(side, k, spot, range_pts):
                    kept.append(k)
                else:
                    gone[k] = "crossed" if (k < spot if side == "R" else k >= spot) else "range"
            refill = next(iter(gone.values()), "fill")
            for k, _ in raw:  # refill from the raw ranking, strongest first
                if len(kept) >= 3:
                    break
                if k not in kept:
                    kept.append(k)
                    added[k] = refill
            # the strongest outsider against the weakest level: needs a lead of lead_pct % on `confirm` refreshes
            outsiders = [k for k, _ in raw if k not in kept]
            best = max(outsiders, key=lambda k: oi[k], default=None)
            weakest = min(kept, key=lambda k: oi.get(k, 0), default=None)
            if best is not None and len(kept) == 3 and oi[best] >= oi.get(weakest, 0) * lead:
                s.streak = s.streak + 1 if s.challenger == best else 1
                s.challenger = best
                if s.streak >= confirm:
                    kept[kept.index(weakest)] = best
                    added[best] = "oi"
                    s.challenger, s.streak = None, 0
            else:
                s.challenger, s.streak = None, 0
            s.strikes = number(side, kept)
        self.started = True
        after = self.slots()
        changes = {}
        for slot in sorted(set(before) | set(after)):
            new, old = after.get(slot), before.get(slot)
            if new != old:
                changes[slot] = (new, added.get(new) or gone.get(old) or "renumber")
        return changes


def apply_changes(open_rows, changes, at, oi_by_slot):
    """History bookkeeping. open_rows: {slot: row} (valid_to None). Returns (closed rows, new rows).
    A row: {"slot", "strike", "oi", "valid_from", "valid_to", "reason"}; times 'YYYY-MM-DD HH:MM' IST."""
    closed, opened = [], []
    for slot, (strike, reason) in changes.items():
        old = open_rows.get(slot)
        if old is not None:
            closed.append({**old, "valid_to": at})
        if strike is not None:
            opened.append({"slot": slot, "strike": strike, "oi": oi_by_slot.get(slot, 0.0), "valid_from": at,
                           "valid_to": None, "reason": reason})
    return closed, opened
