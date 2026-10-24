import { describe, expect, it } from 'vitest';
import { currentLevels, istEpoch, type SrHistory, type SrRow } from './levelHistory';

const row = (slot: SrRow['slot'], strike: number, from: string, to: string | null): SrRow =>
  ({ slot, strike, oi: 65000, valid_from: `2026-10-22 ${from}`, valid_to: to ? `2026-10-22 ${to}` : null, reason: 'open' });

describe('current levels', () => {
  const h = {
    current: { R: [row('R1', 23000, '09:16', null)], S: [row('S1', 22800, '10:47', null), row('S2', 22700, '10:47', null)] },
  } as unknown as SrHistory;

  it('current levels in OI S&R form, OI converted to contracts', () => {
    expect(currentLevels(h, 65)).toEqual({ R: [{ strike: 23000, oi: 1000 }], S: [{ strike: 22800, oi: 1000 }, { strike: 22700, oi: 1000 }] });
    expect(currentLevels(null)).toBeNull();
    expect(currentLevels({ current: { R: [], S: [] } } as unknown as SrHistory)).toBeNull();
  });

  it('IST times to epoch seconds', () => {
    expect(istEpoch('2026-10-22 10:47')).toBe(Date.parse('2026-10-22T10:47:00+05:30') / 1000);
  });
});
