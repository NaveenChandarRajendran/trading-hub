// S/R levels with paper positions (backend paper_levels.py): the entry zone (level nearest spot when the opening BUY
// was placed) and level shifts near it while the position is open. Information only: nothing here exits a position.
import { inr } from '../../../shared/grid';

export interface EntryZone {
  slot: string; // "S1"
  strike: number;
  symbol: string;
  expiry: string; // the expiry whose levels were used
  spot: number;
  at: string; // "2026-10-21 10:00" IST, the level refresh used
  orderId: string;
}

export interface LevelShift {
  id: string; // "S1|2026-10-21 10:47", stable per shift
  at: string;
  slot: string;
  from: number;
  to: number | null; // null: the slot emptied
  reason: string;
}

interface WithZone {
  security_id: number;
  name: string;
  open_qty: number;
  entryZone?: EntryZone | null;
  levelShifts?: LevelShift[];
}

const strike = (n: number) => inr(Number.isInteger(n) ? 0 : 2)(n);

/** "Zone S1 22,900 · 10:00" */
export const zoneText = (z: EntryZone) => `Zone ${z.slot} ${strike(z.strike)} · ${z.at.slice(11, 16)}`;

/** "Level shifted → 22,800" (the newest shift) */
export const shiftText = (s: LevelShift) => `Level shifted → ${s.to == null ? 'removed' : strike(s.to)}`;

/** Shifts on open positions not yet announced (oldest first), each with its notice text and a per-position key. */
export function unseenShifts(positions: WithZone[], seen: ReadonlySet<string>) {
  const out: { key: string; text: string }[] = [];
  for (const p of positions) {
    if (p.open_qty <= 0 || !p.entryZone) continue;
    for (const s of [...(p.levelShifts ?? [])].reverse()) {
      const key = `${p.security_id}|${s.id}`;
      if (seen.has(key)) continue;
      out.push({
        key,
        text: `${p.name}: ${s.slot} ${strike(s.from)} → ${s.to == null ? 'removed' : strike(s.to)} at ${s.at.slice(11, 16)}, `
          + `near your entry zone ${p.entryZone.slot} ${strike(p.entryZone.strike)}. The position is unchanged.`,
      });
    }
  }
  return out;
}
