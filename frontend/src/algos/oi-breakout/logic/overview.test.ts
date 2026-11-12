import { describe, expect, it } from 'vitest';
import type { ComparisonRow } from './api';
import { comparisonRows, showEod, stateTone } from './overview';

describe('OI Breakout overview', () => {
  it('state tones', () => {
    expect(stateTone('in trade')).toBe('accent');
    expect(stateTone('stopped')).toBe('down');
    expect(stateTone('Breakout CE armed (2/6)')).toBe('up');
    expect(stateTone('watching')).toBe('neutral');
  });
  it('end-of-day card from the summary time on; variants A-D', () => {
    expect(showEod('2026-11-12 15:34:59', '15:35')).toBe(false);
    expect(showEod('2026-11-12 15:35:00', '15:35')).toBe(true);
    expect(showEod(undefined, '15:35')).toBe(false);
    const row = (variant: 'A' | 'B' | 'C' | 'D'): ComparisonRow => ({ variant, isLive: variant === 'B', signals: 0, entries: 0, wins: 0, losses: 0, points: 0, netPnl: null });
    expect(comparisonRows([row('D'), row('B'), row('A')]).map((r) => r.variant)).toEqual(['A', 'B', 'D']);
  });
});
