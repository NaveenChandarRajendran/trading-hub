import { describe, expect, it } from 'vitest';
import { banner, distance, minutesToExit, tick, type Check, type RuleResult } from './signals';

const check = (state: Check['state']): Check => ({ id: 'x', label: 'x', detail: '', state, must: false, exempt: false });

describe('signals helpers', () => {
  it('minutes left to the 15:15 exit, in IST', () => {
    expect(minutesToExit(new Date('2026-10-23T14:50:12+05:30'))).toBe(25);
    expect(minutesToExit(new Date('2026-10-23T15:20:00+05:30'))).toBe(0);
    expect(minutesToExit(new Date('2026-10-23T09:15:00+05:30'))).toBe(360);
  });

  it('banner and ticks', () => {
    const r = { go: true, grade: 'B' } as RuleResult;
    expect(banner(r)).toBe('GO · GRADE B');
    expect(banner({ ...r, go: false })).toBe('NO GO');
    expect(banner({ ...r, grade: null })).toBe('GO');
    expect(tick(check('pass'))).toEqual({ text: 'Yes', tone: 'up' });
    expect(tick(check('notChecked')).text).toBe('Not checked');
    expect(tick(check('borderline')).tone).toBe('warn');
  });

  it('distance from spot', () => {
    expect(distance(54500, 54030)).toBe(470);
    expect(distance(54000, 54030)).toBe(30);
  });
});
