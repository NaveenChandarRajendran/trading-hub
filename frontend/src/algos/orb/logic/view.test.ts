import { describe, expect, it } from 'vitest';
import { orFilter, orWindow } from './view';

describe('ORB overview', () => {
  it('OR filter text both ways', () => {
    expect(orFilter(60, 0.625, 0.5)).toEqual({ text: '60m Breakout: needs > 0.5% · passes', ok: true });
    expect(orFilter(60, 0.5, 0.5)).toEqual({ text: '60m Breakout: needs > 0.5% · filtered out', ok: false });
    expect(orFilter(30, 0.5, 0.5)).toEqual({ text: '30m Retest: needs ≤ 0.5% · passes', ok: true });
    expect(orFilter(30, 0.62, 0.5).ok).toBe(false);
    expect(orFilter(30, null, 0.5)).toEqual({ text: '30m Retest: needs ≤ 0.5%', ok: null });
    expect(orFilter(5, 1.2, 0.5).ok).toBe(true);
  });
  it('OR windows', () => {
    expect(orWindow(5)).toBe('09:15–09:19');
    expect(orWindow(30)).toBe('09:15–09:44');
    expect(orWindow(60)).toBe('09:15–10:14');
  });
});
