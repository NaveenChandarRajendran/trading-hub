import { describe, expect, it } from 'vitest';
import rawA from './__fixtures__/banknifty-2026-10-21-1351.json?raw';
import rawB from './__fixtures__/banknifty-2026-10-21-1540.json?raw';
import { ChainParseError, pairError, parseSnapshot, snapTime } from './snapshots';

const a = parseSnapshot(rawA);
const b = parseSnapshot(rawB);

describe('parseSnapshot', () => {
  it('reads time, spot, expiry, ATM and per-strike LTP / bid / ask', () => {
    expect([a.symbol, a.expiry, a.timestamp, snapTime(a), a.spot]).toEqual(['BANKNIFTY', '27-Oct-2026', '21-Oct-2026 13:51:00', '13:51', 54725.4]);
    expect([a.atmStrike, b.atmStrike]).toEqual([54700, 55000]);
    expect(a.strikes.find((s) => s.strike === 54000)!.ce).toEqual({ ltp: 1765.65, bid: 1760, ask: 1770 });
  });

  it('PCR = total put OI ÷ total call OI (B: 8,000 ÷ 6,500)', () => {
    expect(b.pcr).toBeCloseTo(8000 / 6500, 9);
  });

  it('reads the older bidprice / askPrice names too', () => {
    const old = JSON.parse(rawA);
    for (const r of old.records.data) {
      for (const leg of [r.CE, r.PE]) {
        leg.bidprice = leg.buyPrice1;
        leg.askPrice = leg.sellPrice1;
        delete leg.buyPrice1;
        delete leg.sellPrice1;
      }
    }
    expect(parseSnapshot(JSON.stringify(old)).strikes).toEqual(a.strikes);
  });

  it('gives a readable error for bad input', () => {
    expect(() => parseSnapshot('')).toThrow(ChainParseError);
    expect(() => parseSnapshot('<html>')).toThrow(/web page/);
    const noTime = JSON.parse(rawA);
    delete noTime.records.timestamp;
    expect(() => parseSnapshot(JSON.stringify(noTime))).toThrow(/snapshot time/);
  });
});

describe('pairError', () => {
  it('accepts the same symbol and expiry with B later than A', () => {
    expect(pairError(a, b)).toBeNull();
  });

  it('rejects a different expiry', () => {
    expect(pairError(a, { ...b, expiry: '24-Nov-2026' })).toBe(
      'Snapshot B is BANKNIFTY 24-Nov-2026 but A is 27-Oct-2026. Paste two snapshots of the same expiry.',
    );
  });

  it('rejects a different index', () => {
    expect(pairError(a, { ...b, symbol: 'NIFTY' })).toMatch(/B is NIFTY but A is BANKNIFTY/);
  });

  it('rejects B earlier than or at the same time as A', () => {
    expect(pairError(b, a)).toMatch(/must be later than A/);
    expect(pairError(a, a)).toMatch(/must be later than A/);
  });
});
