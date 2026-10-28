import { describe, expect, it } from 'vitest';
import type { ChargeRates } from '../../paper-trade/logic/api';
import type { Leg } from './payoff';
import { basketCharges, summarize } from './summary';

// paper_charges.py RATES (28-Oct-2026)
const RATES: ChargeRates = { brokeragePerOrder: 20, sttSell: 0.0015, transaction: 0.0003503, sebi: 10 / 1e7, stampBuy: 0.00003, gst: 0.18 };
let n = 0;
const leg = (side: 'B' | 'S', strike: number, type: 'CE' | 'PE', price: number, expiry = '2026-11-03'): Leg =>
  ({ id: `L${++n}`, include: true, side, type, expiry, strike, lots: 1, lotSize: 65, price, iv: 12 });
const IC = [leg('S', 21950, 'PE', 19.2), leg('S', 23800, 'CE', 4.4), leg('B', 21700, 'PE', 8.85), leg('B', 24050, 'CE', 2.85)];
const NOW = Date.parse('2026-10-28T10:00:00+05:30');

describe('summary of iron condor A', () => {
  const s = summarize(IC, 22900, 1, 12, NOW, RATES)!;

  it('the Dhan figures, reward : risk and breakevens as % from spot', () => {
    expect(s.net).toBeCloseTo(773.5, 6);
    expect(s.maxProfit).toBeCloseTo(773.5, 6);
    expect(s.maxLoss).toBeCloseTo(-15476.5, 6);
    expect(s.riskPerReward).toBeCloseTo(15476.5 / 773.5, 8); // ≈ 1 : 20
    expect(s.breakevens.map((b) => +b.level.toFixed(2))).toEqual([21938.1, 23811.9]);
    expect(s.breakevens[0].pct).toBeCloseTo(((21938.1 - 22900) / 22900) * 100, 8);
    expect(s.expiry).toBe('2026-11-03');
  });

  it('POP between 0 and 1; none without IV, spot or time', () => {
    expect(s.pop!).toBeGreaterThan(0.8);
    expect(s.pop!).toBeLessThan(1);
    expect(summarize(IC, 22900, 1, null, NOW, RATES)!.pop).toBeNull();
    expect(summarize(IC, 22900, 1, 12, Date.parse('2026-11-04T10:00:00+05:30'), RATES)!.pop).toBeNull();
  });

  it('charges: each leg in and out (8 orders): 8 × ₹20 brokerage + GST and the small fees', () => {
    // per order: 20 brokerage + premium x (txn + sebi) + GST 18 % of those; sells add STT 0.15 %, buys stamp 0.003 %
    expect(s.charges).toBeCloseTo(basketCharges(IC, RATES), 6);
    expect(s.charges!).toBeGreaterThan(8 * 20 * 1.18);
    expect(s.charges!).toBeLessThan(8 * 20 * 1.18 + 10);
    expect(summarize(IC, 22900, 1, 12, NOW, null)!.charges).toBeNull();
  });

  it('nothing to summarise without a ticked leg; the nearest expiry wins', () => {
    expect(summarize(IC.map((l) => ({ ...l, include: false })), 22900, 1, 12, NOW, RATES)).toBeNull();
    expect(summarize([leg('B', 23000, 'CE', 100, '2026-11-10'), leg('S', 23200, 'CE', 50)], 22900, 1, 12, NOW, RATES)!.expiry).toBe('2026-11-03');
  });
});
