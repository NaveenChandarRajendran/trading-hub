import { describe, expect, it } from 'vitest';
import { dayTime, fillAction, monthLabel, winLoss } from './report';

const f = (side: 'BUY' | 'SELL', kind: string) => ({ time: '', side, strike: 22350, optionType: 'PE' as const, qty: 65, price: 1, kind, realized: 0, charges: 0 });

describe('report labels', () => {
  it('months and times', () => {
    expect(monthLabel('2026-11')).toBe('Nov 2026');
    expect(monthLabel('2027-01')).toBe('Jan 2027');
    expect(dayTime('2026-10-28T10:00:05+05:30')).toBe('28 Oct 10:00');
    expect(dayTime(null)).toBe('–');
  });

  it('what a fill did', () => {
    expect([fillAction(f('SELL', 'open')), fillAction(f('BUY', 'open'))]).toEqual(['Sell', 'Buy']);
    expect([fillAction(f('BUY', 'close')), fillAction(f('SELL', 'close')), fillAction(f('BUY', 'settle'))])
      .toEqual(['Bought back', 'Sold (exit)', 'Settled']);
  });

  it('wins and losses of finished trades', () => {
    expect(winLoss(3, 4)).toBe('3 W · 1 L');
    expect(winLoss(0, 0)).toBe('–');
  });
});
