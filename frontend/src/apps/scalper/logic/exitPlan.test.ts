import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAIL, checkTrail, exitLots, exitTitle, parseTrail, trailLabel, trailStopNow } from './exitPlan';

describe('partial exit lots (same rule as the paper engine)', () => {
  it('rounded down, at least 1, never more than open', () => {
    const table = [1, 2, 3, 4, 8, 10].map((n) => [25, 50, 75, 100].map((p) => exitLots(n, p)));
    expect(table).toEqual([[1, 1, 1, 1], [1, 1, 1, 2], [1, 1, 2, 3], [1, 2, 3, 4], [2, 4, 6, 8], [2, 5, 7, 10]]);
  });

  it('the button says what it will do', () => {
    expect(exitTitle(4, 50)).toBe('Sell 50% · 2 of 4 lots at market');
    expect(exitTitle(1, 25)).toBe('Sell 25% · all 1 lot at market (closes the position)');
  });
});

describe('trailing stop', () => {
  it('labels and the stop it would set now', () => {
    expect(trailLabel(DEFAULT_TRAIL)).toBe('trail 10');
    expect(trailLabel({ distance: 5, step: 1, after: 8 })).toBe('trail 5 · after +8');
    expect(trailStopNow(106.37, 10)).toBeCloseTo(96.35, 6);
    expect(trailStopNow(100, 10)).toBeCloseTo(90, 6);
  });

  it('form checks', () => {
    expect(checkTrail({ distance: 10, step: 1, after: null }, 100)).toBe('');
    expect(checkTrail({ distance: 0, step: 1, after: null }, 100)).toMatch(/above 0/);
    expect(checkTrail({ distance: 2.03, step: 1, after: null }, 100)).toMatch(/0.05/);
    expect(checkTrail({ distance: 10, step: 0, after: null }, 100)).toMatch(/Step/);
    expect(checkTrail({ distance: 10, step: 1, after: -1 }, 100)).toMatch(/negative/);
    expect(checkTrail({ distance: 150, step: 1, after: null }, 100)).toMatch(/more than the price/);
  });

  it('remembered values, or the defaults', () => {
    expect(parseTrail(JSON.stringify({ distance: 5, step: 0.5, after: 3 }))).toEqual({ distance: 5, step: 0.5, after: 3 });
    expect(parseTrail('nope')).toEqual(DEFAULT_TRAIL);
    expect(parseTrail(JSON.stringify({ distance: -2, step: 1 }))).toEqual(DEFAULT_TRAIL);
    expect(parseTrail(null)).toEqual(DEFAULT_TRAIL);
  });
});
