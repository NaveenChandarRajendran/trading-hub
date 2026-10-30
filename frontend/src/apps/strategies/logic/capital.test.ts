// Capital and P&L since start (owner 30-Oct-2026). Hand-checked numbers.
import { describe, expect, it } from 'vitest';
import type { JTrade } from '../../paper-journal/logic/journal';
import type { MomState } from '../../today/logic/momentum';
import type { TodayRow } from '../../today/logic/today';
import { TOTAL_CAPITAL, sectionCapital, strategyByWho } from '../catalog';
import { allSections, moneyOf, moneyOfMomentum, returnPct, sectionMoney } from './capital';

const t = (strategy: string, netPnl: number, charges: number, status: 'open' | 'closed' = 'closed') =>
  ({ strategy, netPnl, charges, status, day: '2026-10-29' }) as unknown as JTrade;
const open = (who: string, pnl: number, capital: number) => ({ who, open: true, pnl, capital }) as unknown as TodayRow;

describe('capital split (owner 30-Oct-2026)', () => {
  it('₹23 lakh in all: buy 2, sell 10, momentum 10, scalping 1', () => {
    expect([sectionCapital('optionBuy'), sectionCapital('optionSell'), sectionCapital('momentum'), sectionCapital('scalping')])
      .toEqual([200000, 1000000, 1000000, 100000]);
    expect(TOTAL_CAPITAL).toBe(2300000);
  });
  it('the four timed straddles are one strategy', () => {
    expect(strategyByWho('Expiry Straddle 11:26 (sell)')?.name).toBe('Expiry Straddle');
    expect(strategyByWho('Expiry Straddle (sell)')?.capital).toBe(600000);
  });
});

describe('money of a strategy', () => {
  it('booked after charges, open now, brokerage ₹40 a trade, the rest taxes', () => {
    const m = moneyOf(['Rebound Call'], 50000, [t('Rebound Call', 1000, 60), t('Rebound Call', -400, 55), t('Manual', 99, 50)], [open('Rebound Call', 250, 9000)]);
    expect(m).toMatchObject({ booked: 600, running: 250, net: 850, brokerage: 80, taxes: 35, trades: 2, won: 1, lost: 1, inUse: 9000 });
    expect(returnPct(m)).toBe(1.7);
  });
  it('a section adds up its strategies, the straddle times together', () => {
    const s = sectionMoney('optionSell', [t('Expiry Straddle 9:40 (sell)', 500, 70), t('Expiry Straddle 12:24 (sell)', -100, 70)], [], undefined);
    expect(s.lines.find((l) => l.name === 'Expiry Straddle')?.m.net).toBe(400);
    expect(s.total.capital).toBe(1000000);
  });
  it('momentum: value − capital, delivery charges are taxes', () => {
    const st = { books: [{ key: 'momAll', capital: 500000, pnl: -1200, holdings: [{ value: 498000 }], trades: [{ side: 'BUY', charges: 300 }] }] } as unknown as MomState;
    expect(moneyOfMomentum('momAll', st)).toMatchObject({ net: -1200, inUse: 498000, brokerage: 0, taxes: 300, trades: 0 });
    expect(moneyOfMomentum('momSwitch', st)).toMatchObject({ capital: 500000, net: 0 });
  });
  it('all sections', () => {
    expect(allSections([], [], undefined).map((x) => x.total.capital)).toEqual([200000, 1000000, 1000000, 100000]);
  });
});
