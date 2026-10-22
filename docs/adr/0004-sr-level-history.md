# ADR 0004: S/R levels decided and recorded on the backend, with a stability rule

Date: 2026-10-22 · Status: accepted

## Context
S1–S3 / R1–R3 were the top call / put OI strikes near spot, re-ranked in the browser on every chain. Two strikes with
similar OI swapped places from one minute to the next, so the lines jumped, earlier lines disappeared from the chart,
and the Dashboard (hourly), OI S&R Live (per refresh) and any paper trade could each show different levels.

## Decision
- **The backend decides the levels** (`sr_levels.py`), on the tracker's minute poll of each tracked expiry, and every
  page reads them. The ranking is a Python port of the frontend's `topLevels`, parity-tested on the same fixture.
- **Stability rule:** a new strike replaces the weakest level of its side only when its OI leads by 10 % for 3
  refreshes in a row (both configurable, shared by all browsers via `/api/sr/settings`). A level spot crosses, or one
  that leaves the range, is replaced at once, since a crossed support is no longer a support.
- **History is stored as change rows** (`sr_levels`: slot, strike, valid_from, valid_to, reason), written only when a
  slot's strike changes, so the chart can draw each level over the time it was in effect and list the changes.
- **Per-browser view options** (history / morning toggles, morning time, pinned set) stay in localStorage; only the
  rule itself is shared.
- **Paper orders keep the levels at order time** (`pt_order_levels`), so a position's entry zone does not move when
  levels change. A shift near the zone is a warning only; it never exits a position.
- The hourly level refresh on the Dashboard is dropped: the stability rule replaces it.

## Consequences
- The Dashboard, OI S&R Live and Paper Trading agree on the levels at any minute.
- Levels exist only for tracked expiries and while the backend runs (no backfill); before the first poll of the day the
  pages fall back to the raw ranking and say so.
- A real move in OI shows up 3 minutes later (by default); crossing is immediate.
- OI S&R Live's local range setting only applies when nothing is recorded; otherwise the shared range is used.
