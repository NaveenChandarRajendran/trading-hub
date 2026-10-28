import { describe, expect, it } from 'vitest';
import type { Order } from './api';
import { openingTime, zoneBands } from './zones';

describe('zone bands', () => {
  it('reward up to the target, risk down to the stop', () => {
    expect(zoneBands(100, 120, 90)).toEqual([{ hi: 120, lo: 100, tone: 'reward' }, { hi: 100, lo: 90, tone: 'risk' }]);
  });

  it('a stop above the entry (trailed) is locked profit; only what is set shows', () => {
    expect(zoneBands(100, 120, 104)).toEqual([{ hi: 120, lo: 100, tone: 'reward' }, { hi: 104, lo: 100, tone: 'locked' }]);
    expect(zoneBands(100, null, 90)).toEqual([{ hi: 100, lo: 90, tone: 'risk' }]);
    expect(zoneBands(100, 120, null)).toEqual([{ hi: 120, lo: 100, tone: 'reward' }]);
    expect(zoneBands(100, null, null)).toEqual([]);
    expect(zoneBands(100, null, 100)).toEqual([]); // stop at cost: nothing to shade
  });
});

describe('opening time of the position held now', () => {
  let n = 0;
  const fill = (side: 'BUY' | 'SELL', qty: number, at: string, securityId = 7, status = 'FILLED'): Order =>
    ({ id: `PT${++n}`, security_id: securityId, side, qty, status, filled_at: `2026-10-28T${at}:00+05:30` }) as unknown as Order;
  const t = (at: string) => Math.floor(Date.parse(`2026-10-28T${at}:00+05:30`) / 1000);

  it('the buy that opened it, not later adds', () => {
    expect(openingTime([fill('BUY', 65, '10:00'), fill('BUY', 65, '10:05')], 7)).toBe(t('10:00'));
  });

  it('after a round trip, the new opening buy; partial sells keep the old one', () => {
    const orders = [fill('BUY', 130, '09:30'), fill('SELL', 65, '09:40'), fill('SELL', 65, '09:45'), fill('BUY', 65, '10:10'),
      fill('SELL', 0, '10:11', 7, 'CANCELLED'), fill('BUY', 65, '10:20', 8)];
    expect(openingTime(orders, 7)).toBe(t('10:10'));
    expect(openingTime([fill('BUY', 130, '09:30'), fill('SELL', 65, '09:40')], 7)).toBe(t('09:30'));
  });

  it('flat or unknown: none', () => {
    expect(openingTime([fill('BUY', 65, '09:30'), fill('SELL', 65, '09:40')], 7)).toBeNull();
    expect(openingTime([], 7)).toBeNull();
  });
});
