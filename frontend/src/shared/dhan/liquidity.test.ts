import { describe, expect, it } from 'vitest';
import { illiquidReason, outwardStrike, untraded } from './liquidity';

// SENSEX 5 Nov 2026 CE, as Dhan sent them on 29-Oct after the close (bid / ask 0 on every strike then)
const SX: Record<number, { oi: number; volume: number; last_price: number; bid: number; ask: number }> = {
  77000: { oi: 237540, volume: 757700, last_price: 18.3, bid: 0, ask: 0 },
  77100: { oi: 0, volume: 0, last_price: 573.65, bid: 0, ask: 0 }, // = previous close: the base price
  77200: { oi: 0, volume: 0, last_price: 548.5, bid: 0, ask: 0 },
  77300: { oi: 3320, volume: 10500, last_price: 13.75, bid: 0, ask: 0 },
};

describe('untraded strikes', () => {
  it('volume 0 and OI 0 is untraded; either one traded is not', () => {
    expect(untraded(SX[77200])).toBe(true);
    expect(untraded(SX[77300])).toBe(false);
    expect(untraded({ oi: 500, volume: 0 })).toBe(false); // open from earlier days, nothing traded yet today
    expect(untraded({ oi: 0, volume: 20 })).toBe(false);
    expect(untraded(null)).toBe(true);
  });

  it('liquid: thresholds, and a live bid / ask only while the market is open', () => {
    expect(illiquidReason(SX[77200], false)).toBe('untraded');
    expect(illiquidReason(SX[77300], false)).toBe(''); // closed: no quote needed
    expect(illiquidReason(SX[77300], true)).toBe('illiquid'); // open with no bid / ask
    expect(illiquidReason({ ...SX[77300], bid: 13.7, ask: 13.8 }, true)).toBe('');
    expect(illiquidReason(SX[77300], false, { minOi: 5000, minVolume: 1, needQuote: true })).toBe('illiquid');
    expect(illiquidReason({ oi: 500, volume: 0, bid: 5, ask: 5.1 }, true)).toBe('illiquid'); // no trade today yet
    expect(illiquidReason({ oi: 500, volume: 0, bid: 5, ask: 5.1 }, true, { minOi: 1, minVolume: 0, needQuote: true })).toBe('');
  });

  it('outward to the nearest liquid strike: calls up, puts down', () => {
    const strikes = Object.keys(SX).map(Number);
    const why = (k: number) => illiquidReason(SX[k], false);
    expect(outwardStrike(strikes, 77200, 'CE', why)).toBe(77300);
    expect(outwardStrike(strikes, 77100, 'CE', why)).toBe(77300);
    expect(outwardStrike(strikes, 77000, 'CE', why)).toBe(77000); // already liquid
    expect(outwardStrike(strikes, 77200, 'PE', why)).toBe(77000); // a put moves down
    expect(outwardStrike([77100, 77200], 77100, 'CE', why)).toBeNull();
  });
});
