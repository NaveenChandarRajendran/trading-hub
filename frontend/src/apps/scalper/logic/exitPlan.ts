// Partial exits and the trailing stop (pure). The backend's paper engine decides (paper_engine.py exit_partial /
// set_trail); these mirror its rules so the buttons can say what a click will do before it is clicked.

export const EXIT_PCTS = [25, 50, 75] as const; // 100 % is the ✕ / Exit button
export type ExitPct = (typeof EXIT_PCTS)[number] | 100;

/** Lots a pct exit sells: rounded down, at least 1, never more than open (paper_engine.partial_lots). */
export const exitLots = (openLots: number, pct: number) => Math.min(openLots, Math.max(1, Math.floor((openLots * pct) / 100)));

/** "Sell 50% · 2 of 4 lots at market" (or "… all 1 lot …" when it closes the position). */
export function exitTitle(openLots: number, pct: number): string {
  const n = exitLots(openLots, pct);
  if (n >= openLots) return `Sell ${pct}% · all ${openLots} lot${openLots === 1 ? '' : 's'} at market (closes the position)`;
  return `Sell ${pct}% · ${n} of ${openLots} lots at market`;
}

export interface Trail {
  distance: number; // points below the highest LTP
  step: number; // the stop moves only by at least this much
  after: number | null; // start once in this much profit (points); null = straight away
  high?: number | null; // highest LTP since it started (from the backend)
}

export const DEFAULT_TRAIL: Trail = { distance: 10, step: 1, after: null };

/** "trail 10" / "trail 10 · after +5" for the SL grip and the Trail button. */
export const trailLabel = (t: Trail) => `trail ${t.distance}${t.after != null ? ` · after +${t.after}` : ''}`;

const onTick = (v: number) => Math.abs(Math.round(v / 0.05) * 0.05 - v) < 1e-6;

/** Why the Trail form can't be sent, or ''. `ltp` guards a distance larger than the price. */
export function checkTrail(t: { distance: number; step: number; after: number | null }, ltp: number | null | undefined): string {
  if (!(t.distance > 0) || !onTick(t.distance)) return 'Distance must be above 0 and a multiple of 0.05.';
  if (!(t.step > 0)) return 'Step must be above 0.';
  if (t.after != null && !(t.after >= 0)) return 'Start-after profit can’t be negative.';
  if (ltp != null && t.distance >= ltp) return `Distance ${t.distance} is more than the price ${ltp}.`;
  return '';
}

/** The stop trailing would set right now: LTP − distance, down to the 0.05 tick. */
export const trailStopNow = (ltp: number, distance: number) => Math.floor(Math.round((ltp - distance) / 0.05 * 1e6) / 1e6) * 0.05;

/** Remembered Trail form values (this browser); anything odd falls back to the defaults. */
export function parseTrail(raw: string | null): Trail {
  try {
    const t = raw ? JSON.parse(raw) : null;
    if (t && checkTrail({ distance: t.distance, step: t.step, after: t.after ?? null }, null) === '') {
      return { distance: t.distance, step: t.step, after: t.after ?? null };
    }
  } catch { /* fall through */ }
  return DEFAULT_TRAIL;
}
