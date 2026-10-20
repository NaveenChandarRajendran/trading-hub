// src/apps/oi-support-resistance/logic/snapshots.ts
// Rules for keeping one list of pastes per index + expiry + day. The first paste of the day is the baseline.
import { parseNseTime, type Snapshot } from './levels';

export type PasteCheck = { ok: true } | { ok: false; message: string };

/** Rejects a paste for another expiry, older than the last paste, or identical to it. */
export function checkPaste(list: Snapshot[], cur: Snapshot): PasteCheck {
  const base = list[0];
  const last = list[list.length - 1];
  if (base && base.expiry && cur.expiry && base.expiry !== cur.expiry) {
    return { ok: false, message: `This paste is for expiry ${cur.expiry} but today's baseline is ${base.expiry}. It was not saved.` };
  }
  if (last) {
    const a = parseNseTime(cur.nse);
    const b = parseNseTime(last.nse);
    if (a && b && a < b) return { ok: false, message: `This data is older than your last paste (${last.nse}). It was not saved.` };
    if ((a && b && a === b) || (!a && JSON.stringify(last.rows) === JSON.stringify(cur.rows))) {
      return { ok: false, message: 'This is the same data as your last paste. Copy a fresh response and try again. It was not saved.' };
    }
  }
  return { ok: true };
}

/** Local calendar date, "2026-10-20". */
export const isoDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Storage key suffix for one day's pastes: "snaps.BANKNIFTY.27-Oct-2026.2026-10-20". */
export const dayKey = (symbol: string, expiry: string, d = new Date()) => `snaps.${symbol}.${expiry}.${isoDay(d)}`;
