// Reference values: Naveen's Excel, BANKNIFTY 27-Oct-2026, spot 54,725.40 at 13:51 → 54,976.90 at 15:40 (+251.50).
// Fixtures hold those LTPs; bid / ask (for Mid) and OI are made up, so Mid expectations are worked by hand from them.
import { describe, expect, it } from 'vitest';
import rawA from './__fixtures__/banknifty-2026-10-21-1351.json?raw';
import rawB from './__fixtures__/banknifty-2026-10-21-1540.json?raw';
import { compareSnapshots, premium, sideChange, topMovers, type StrikeChange } from './premium';
import { parseSnapshot } from './snapshots';

const a = parseSnapshot(rawA);
const b = parseSnapshot(rawB);
const ltp = compareSnapshots(a, b, 'ltp');
const mid = compareSnapshots(a, b, 'mid');
const row = (c: typeof ltp, strike: number) => c.rows.find((r) => r.strike === strike)!;

describe('spot move', () => {
  it('is later minus earlier', () => {
    expect(ltp.spotMove).toBeCloseTo(251.5, 9);
  });
});

describe('LTP: the Excel reference values', () => {
  it('54,000 CE: 1765.65 → 1838.70, +73.05, +4.14%, ratio 3.44', () => {
    const s = row(ltp, 54000).ce;
    expect([s.premA, s.premB]).toEqual([1765.65, 1838.7]);
    expect(s.chg).toBeCloseTo(73.05, 9);
    expect(s.chgPct).toBeCloseTo(4.14, 2);
    expect(s.ratio).toBeCloseTo(3.44, 2);
    expect(s.efficiency).toBeCloseTo(73.05 / 251.5, 9);
  });

  it('54,000 PE: 532.15 → 490.80, −41.35, ratio 6.08 (ratio uses |chg|)', () => {
    const s = row(ltp, 54000).pe;
    expect(s.chg).toBeCloseTo(-41.35, 9);
    expect(s.ratio).toBeCloseTo(6.08, 2);
    expect(s.efficiency).toBeLessThan(0);
  });

  it('55,000 CE: 1110 → 1162, +52, ratio 4.84', () => {
    const s = row(ltp, 55000).ce;
    expect(s.chg).toBeCloseTo(52, 9);
    expect(s.ratio).toBeCloseTo(4.84, 2);
  });

  it('54,900 CE: 1184.30 → 1191.50, +7.20, ratio 34.93', () => {
    const s = row(ltp, 54900).ce;
    expect(s.chg).toBeCloseTo(7.2, 9);
    expect(s.ratio).toBeCloseTo(34.93, 2);
  });

  it('54,100 CE: 0 → 1706.70 is "No trades", nothing computed', () => {
    expect(row(ltp, 54100).ce).toEqual({ premA: null, premB: 1706.7, noTrades: true, chg: null, chgPct: null, ratio: null, efficiency: null });
  });
});

describe('Mid = (bid + ask) ÷ 2', () => {
  it('54,000 CE: (1760 + 1770) ÷ 2 = 1765 → (1835 + 1845) ÷ 2 = 1840, +75, ratio 251.5 ÷ 75', () => {
    const s = row(mid, 54000).ce;
    expect([s.premA, s.premB]).toEqual([1765, 1840]);
    expect(s.chg).toBe(75);
    expect(s.chgPct).toBeCloseTo((75 / 1765) * 100, 9);
    expect(s.ratio).toBeCloseTo(251.5 / 75, 9);
  });

  it('54,000 PE: 532.15 → 490.50, −41.65, ratio 6.04', () => {
    const s = row(mid, 54000).pe;
    expect(s.premB).toBe(490.5);
    expect(s.chg).toBeCloseTo(-41.65, 9);
    expect(s.ratio).toBeCloseTo(6.04, 2);
  });

  it('55,000 CE and 54,900 CE: mid equals LTP here, so the reference values hold', () => {
    expect(row(mid, 55000).ce.ratio).toBeCloseTo(4.84, 2);
    expect(row(mid, 54900).ce.ratio).toBeCloseTo(34.93, 2);
  });

  it('a missing bid or ask makes that side "No trades" for Mid only, per side', () => {
    expect(row(mid, 54100).ce.noTrades).toBe(true); // bid and ask 0 at 13:51
    expect(row(mid, 54100).pe.noTrades).toBe(true); // ask 0 at 15:40
    expect(row(ltp, 54100).pe.noTrades).toBe(false); // LTP 560 → 520 is fine
    expect(row(ltp, 54100).pe.chg).toBeCloseTo(-40, 9);
    expect(premium({ ltp: 10, bid: 9.5, ask: 0 }, 'mid')).toBeNull();
  });
});

describe('zero handling', () => {
  it('zero change: chg 0, chgPct 0, ratio "—" (null)', () => {
    const s = row(ltp, 54700).ce; // 1290 → 1290
    expect([s.chg, s.chgPct, s.ratio, s.efficiency]).toEqual([0, 0, null, 0]);
  });

  it('zero spot move: chg and chgPct kept, ratio and efficiency blank', () => {
    const s = sideChange({ ltp: 100, bid: 0, ask: 0 }, { ltp: 110, bid: 0, ask: 0 }, 'ltp', 0);
    expect([s.chg, s.chgPct, s.ratio, s.efficiency]).toEqual([10, 10, null, null]);
  });

  it('a strike missing from one snapshot is "No trades"', () => {
    expect(sideChange(null, { ltp: 5, bid: 4, ask: 6 }, 'ltp', 100).noTrades).toBe(true);
  });
});

describe('top movers', () => {
  it('Points: biggest gain first; 55,000 CE (+52) above 54,900 CE (+7.20); no trades and non-gainers left out', () => {
    const m = topMovers(ltp.rows, 'ce', 'points', 10);
    expect(m.map((x) => [x.rank, x.strike])).toEqual([[1, 54000], [2, 55000], [3, 54900]]); // 54,100 no trades, 54,700 unchanged
  });

  it('%: re-sorts by chg %', () => {
    // 55,000: 52 ÷ 1110 = 4.68%, 54,000: 73.05 ÷ 1765.65 = 4.14%, 54,900: 7.2 ÷ 1184.3 = 0.61%
    expect(topMovers(ltp.rows, 'ce', 'pct', 10).map((x) => x.strike)).toEqual([55000, 54000, 54900]);
  });

  it('a side with no gainers gives an empty list (every put fell as spot rose)', () => {
    expect(topMovers(ltp.rows, 'pe', 'points', 10)).toEqual([]);
  });

  it('ties go to the lower ratio, then the lower strike; n caps the list', () => {
    const side = (chg: number, ratio: number | null) =>
      ({ premA: 100, premB: 100 + chg, noTrades: false, chg, chgPct: chg, ratio, efficiency: null });
    const rows: StrikeChange[] = [
      { strike: 100, ce: side(10, 5), pe: side(-1, 1) },
      { strike: 200, ce: side(10, 3), pe: side(-1, 1) },
      { strike: 300, ce: side(10, 3), pe: side(-1, 1) },
      { strike: 400, ce: side(10, null), pe: side(-1, 1) },
      { strike: 500, ce: side(20, 9), pe: side(-1, 1) },
    ];
    expect(topMovers(rows, 'ce', 'points', 10).map((x) => x.strike)).toEqual([500, 200, 300, 100, 400]);
    expect(topMovers(rows, 'ce', 'points', 2).map((x) => x.rank)).toEqual([1, 2]);
  });
});
