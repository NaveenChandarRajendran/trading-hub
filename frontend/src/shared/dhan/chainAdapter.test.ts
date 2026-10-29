import { describe, expect, it } from 'vitest';
import type { ChainResponse } from './api';
import { isoFromIst, nseDate, nseTimestamp, toLeg, toOptionChain, toSbSnapshot } from './chainAdapter';
import niftyJson from './__fixtures__/nifty-2026-10-21.json';
import bankJson from './__fixtures__/banknifty-2026-10-21.json';

// Real GET /api/option-chain bodies, captured 21-Oct-2026 after the close with backend/capture_chain.py.
// Expected values below are worked by hand from the raw numbers in these files.
const nifty = niftyJson as unknown as ChainResponse;
const bank = bankJson as unknown as ChainResponse;

describe('date formats', () => {
  it('converts Dhan dates to the NSE format the paste apps use', () => {
    expect(nseDate('2026-10-27')).toBe('27-Oct-2026');
    expect(nseTimestamp('2026-10-21 16:48:20')).toBe('21-Oct-2026 16:48:20');
    expect(isoFromIst('2026-10-21 09:15:00')).toBe('2026-10-21T03:45:00.000Z');
  });
});

describe('toOptionChain (NSE model, OI in contracts)', () => {
  const chain = toOptionChain(nifty, ['2026-10-27', '2026-11-03']);

  it('fills the header fields', () => {
    expect(chain.symbol).toBe('NIFTY');
    expect(chain.expiry).toBe('27-Oct-2026');
    expect(chain.timestamp).toBe('21-Oct-2026 16:48:20');
    expect(chain.underlying).toBe(22811.35);
    expect(chain.atmStrike).toBe(22800); // nearest strike to 22,811.35
    expect(chain.expiryDates).toEqual(['27-Oct-2026', '03-Nov-2026']);
    expect(chain.strikes).toHaveLength(261);
  });

  it('maps NIFTY 22800 by hand: units / 65', () => {
    const s = chain.strikes.find((x) => x.strike === 22800)!;
    // ce oi 7,844,655 / 65; (7,844,655 - previous_oi 2,397,200) / 65
    expect(s.ce!.openInterest).toBe(120687);
    expect(s.ce!.changeInOpenInterest).toBe(83807);
    expect(s.ce!.pChangeInOpenInterest).toBeCloseTo((5447455 / 2397200) * 100, 9);
    expect(s.ce!.ltp).toBe(135.95);
    expect(s.ce!.change).toBeCloseTo(135.95 - 225.3, 9);
    expect(s.ce!.iv).toBeCloseTo(9.1786, 4);
    expect([s.ce!.bidPrice, s.ce!.bidQty, s.ce!.askPrice, s.ce!.askQty]).toEqual([135.4, 195, 135.95, 130]);
    // pe oi 5,286,840 / 65; (5,286,840 - 4,289,285) / 65
    expect(s.pe!.openInterest).toBe(81336);
    expect(s.pe!.changeInOpenInterest).toBe(15347);
  });

  it('maps BANKNIFTY 55000 by hand: units / 30, including a fall in OI', () => {
    const b = toOptionChain(bank);
    const s = b.strikes.find((x) => x.strike === 55000)!;
    expect(b.atmStrike).toBe(55000); // spot 54,976.90
    expect(s.ce!.openInterest).toBe(42195); // 1,265,850 / 30
    expect(s.ce!.changeInOpenInterest).toBe(13338); // (1,265,850 - 865,710) / 30
    expect(s.pe!.openInterest).toBe(42121); // 1,263,630 / 30
    expect(s.pe!.changeInOpenInterest).toBe(-95); // (1,263,630 - 1,266,480) / 30
    expect(s.ce!.change).toBeCloseTo(417.5 - 807.55, 9);
  });

  it('every OI is a whole number of contracts and totals are the sum over all strikes', () => {
    expect(chain.strikes.every((s) => Number.isInteger(s.ce!.openInterest) && Number.isInteger(s.pe!.openInterest))).toBe(true);
    const ceUnits = nifty.rows.reduce((t, r) => t + (r.ce?.oi ?? 0), 0);
    expect(chain.totals.ce.oi).toBe(ceUnits / 65);
  });

  it('an untraded leg (SENSEX 77,200 CE, 29-Oct: OI 0, volume 0, base price 548.50) shows no price or IV', () => {
    const leg = toLeg({ oi: 0, previous_oi: 0, last_price: 548.5, previous_close_price: 548.5, volume: 0, implied_volatility: 37.6, top_bid_price: 0, top_bid_quantity: 0, top_ask_price: 0, top_ask_quantity: 0 }, 20)!;
    expect([leg.ltp, leg.iv, leg.change, leg.openInterest]).toEqual([0, 0, 0, 0]);
  });

  it('a missing leg stays null and fields Dhan lacks are 0', () => {
    expect(toLeg(null, 65)).toBeNull();
    expect(chain.strikes[0].ce!.totalBuyQty).toBe(0);
  });
});

describe('toSbSnapshot (Sensibull model, OI in units)', () => {
  const snap = toSbSnapshot(nifty);

  it('uses previous-day OI as "from" and current OI as "to", in units', () => {
    const s = snap.strikes.find((x) => x.strike === 22800)!;
    expect(s).toEqual({ strike: 22800, fromCallOi: 2397200, fromPutOi: 4289285, toCallOi: 7844655, toPutOi: 5286840 });
  });

  it('fills the header fields', () => {
    expect(snap.symbol).toBe('NIFTY');
    expect(snap.expiry).toBe('27-Oct-2026');
    expect(snap.spot).toBe(22811.35);
    expect(snap.atmStrike).toBe(22800);
    expect(snap.fromTime).toBe('2026-10-21T03:45:00.000Z'); // 09:15 IST
    expect(snap.toTime).toBe('2026-10-21T11:18:20.000Z'); // 16:48:20 IST
    expect(snap.strikes).toHaveLength(261);
  });
});
