import { describe, expect, it } from 'vitest';
import { atmStrike, change, dayRange, keyAction, placeOn, protectionFor, stepStrike, totals } from './tradeWindow';

const STRIKES = [54300, 54400, 54500, 54600, 54700];
const t = (day: string, hm: string) => Math.floor(Date.parse(`${day}T${hm}:00+05:30`) / 1000);
const c = (time: number, low: number, high: number, close: number) => ({ time, open: close, high, low, close });

describe('strikes', () => {
  it('ATM and ± stepping, staying put at the ends', () => {
    expect(atmStrike(STRIKES, 54555.85)).toBe(54600);
    expect(atmStrike([], 1)).toBeNull();
    expect(stepStrike(STRIKES, 54500, 1)).toBe(54600);
    expect(stepStrike(STRIKES, 54500, -1)).toBe(54400);
    expect(stepStrike(STRIKES, 54700, 1)).toBe(54700);
    expect(stepStrike(STRIKES, 54300, -1)).toBe(54300);
  });
});

describe('day range', () => {
  const candles = [c(t('2026-10-28', '15:29'), 54200, 54300, 54267.4), c(t('2026-10-29', '09:15'), 54047.9, 54400, 54350),
    c(t('2026-10-29', '13:17'), 54500, 54653.55, 54560)];
  it('the latest session low / high with the live LTP, the previous close', () => {
    expect(dayRange(candles, 54555.85)).toEqual({ low: 54047.9, high: 54653.55, prevClose: 54267.4 });
    expect(dayRange(candles, 54700).high).toBe(54700);
    expect(dayRange([], 100)).toEqual({ low: 100, high: 100, prevClose: null });
  });
  it('a marker between low and high; the change', () => {
    expect(placeOn(100, 200, 150)).toBe(50);
    expect(placeOn(100, 200, 250)).toBe(100);
    expect(placeOn(100, 100, 100)).toBeNull();
    expect(change(1014, 938.6)?.pct).toBeCloseTo(8.033, 2);
    expect(change(1, 0)).toBeNull();
  });
});

describe('orders and positions', () => {
  it('SL / target points from the fill, on the 0.05 grid', () => {
    expect(protectionFor(100.05, 20, 40.02)).toEqual({ stop: 80.05, target: 140.05 });
    expect(protectionFor(5, 10, null)).toEqual({ stop: 0.05, target: null }); // never below one tick
    expect(protectionFor(null, 10, 10)).toEqual({ stop: null, target: null });
  });

  it('totals: bought / sold / open, booked + live unbooked', () => {
    const ps = [{ open_qty: 30, buy_qty: 60, sell_qty: 30, avg_buy: 100, realized: 300 },
      { open_qty: 0, buy_qty: 65, sell_qty: 65, avg_buy: 50, realized: -130 }];
    expect(totals(ps, (p) => (p.open_qty ? 110 : null))).toEqual({ bought: 125, sold: 95, open: 30, realized: 170, unrealized: 300, pnl: 470 });
  });

  it('F6 / F7 only outside fields and without modifiers', () => {
    const k = (key: string, more = {}) => ({ key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: { tagName: 'DIV' }, ...more });
    expect(keyAction(k('F6'))).toBe('closeAll');
    expect(keyAction(k('F7'))).toBe('cancelAll');
    expect(keyAction(k('F6', { target: { tagName: 'INPUT' } }))).toBeNull();
    expect(keyAction(k('F6', { repeat: true }))).toBeNull();
    expect(keyAction(k('F6', { ctrlKey: true }))).toBeNull();
    expect(keyAction(k('F5'))).toBeNull();
  });
});
