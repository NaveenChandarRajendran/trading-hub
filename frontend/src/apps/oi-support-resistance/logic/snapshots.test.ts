// src/apps/oi-support-resistance/logic/snapshots.test.ts
import { describe, it, expect } from 'vitest';
import type { Snapshot } from './levels';
import { checkPaste, dayKey } from './snapshots';

const snap = (nse: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  t: 0, nse, symbol: 'NIFTY', expiry: '27-Oct-2026', spot: 25000, rows: { 25000: [10, 20] }, ...extra,
});

describe('checkPaste', () => {
  it('first paste of the day is accepted (becomes the baseline)', () => {
    expect(checkPaste([], snap('20-Oct-2026 09:30:00'))).toEqual({ ok: true });
  });
  it('a newer paste is accepted', () => {
    expect(checkPaste([snap('20-Oct-2026 09:30:00')], snap('20-Oct-2026 10:00:00')).ok).toBe(true);
  });
  it('rejects another expiry than the baseline', () => {
    const r = checkPaste([snap('20-Oct-2026 09:30:00')], snap('20-Oct-2026 10:00:00', { expiry: '03-Nov-2026' }));
    expect(r.ok).toBe(false);
  });
  it('rejects data older than the last paste', () => {
    const list = [snap('20-Oct-2026 09:30:00'), snap('20-Oct-2026 11:00:00')];
    expect(checkPaste(list, snap('20-Oct-2026 10:00:00')).ok).toBe(false);
  });
  it('rejects the same NSE timestamp as the last paste', () => {
    expect(checkPaste([snap('20-Oct-2026 09:30:00')], snap('20-Oct-2026 09:30:00')).ok).toBe(false);
  });
  it('without NSE time, rejects identical OI', () => {
    expect(checkPaste([snap('')], snap('')).ok).toBe(false);
    expect(checkPaste([snap('')], snap('', { rows: { 25000: [11, 20] } })).ok).toBe(true);
  });
});

describe('dayKey', () => {
  it('one list per index + expiry + day', () => {
    expect(dayKey('BANKNIFTY', '27-Oct-2026', new Date(2026, 9, 5))).toBe('snaps.BANKNIFTY.27-Oct-2026.2026-10-05');
  });
});
