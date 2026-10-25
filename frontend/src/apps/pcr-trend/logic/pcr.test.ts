// PCR Trend Analysis against the real 23-Oct-2026 BANKNIFTY pastes (expiry 27-Oct-2026, 15:40 IST, spot 54,287.35),
// the same day and expiry as the father's Excel sheet. Rule agreed with him on 2026-10-25:
//   today's OI = yesterday's OI + today's change; strike PCR = PE today's OI ÷ CE today's OI.
// Expected totals summed by hand from the two fixtures over 53,300–55,300.
import { describe, expect, it } from 'vitest';
import sbRaw from './__fixtures__/sensibull-banknifty-2026-10-23.json?raw';
import nseRaw from './__fixtures__/nse-banknifty-2026-10-23.json?raw';
import { SbParseError } from '../../sensibull-oi/logic/sensibull';
import { ChainParseError } from '../../option-strategy/logic/optionChain';
import { istLabel, LotSizeError, nseTime, readNse, readSensibull, sensibullTime, type PcrSource, type PcrStrike } from './sources';
import {
  analyzeSource, atmNote, checkSources, finalPcr, nearestStrike, round2, sinceWarning, sourceCsv, strikeRow, strikeStep, verdict,
} from './pcr';

const TH = { down: 0.9, up: 1.1 };
const sb = readSensibull(sbRaw);
const nse = readNse(nseRaw);
const W = Array.from({ length: 21 }, (_, i) => 53300 + i * 100);
const lakh = (v: number) => v / 1e5;

describe('parsing the real pastes', () => {
  it('Sensibull: today OI = to_*_oi, change = to − from, time capped at 15:40 IST, change since 09:15', () => {
    expect([sb.symbol, sb.expiry, sb.spot, sb.lot]).toEqual(['BANKNIFTY', '27-Oct-2026', 54287.35, 1]);
    expect(sb.strikes.find((s) => s.strike === 54500)).toEqual({ strike: 54500, ceOi: 580050, ceChg: 355560, peOi: 492480, peChg: -194880 });
    expect(istLabel(sb.at)).toBe('23 Oct 15:40'); // to_time is 19:30 IST, the data ends 15:40
    expect(istLabel(sb.since!)).toBe('23 Oct 09:15');
    expect(sinceWarning(sb)).toBe('');
  });

  it('NSE: openInterest / changeinOpenInterest in contracts × 30 (BANKNIFTY lot) = units', () => {
    expect([nse.symbol, nse.expiry, nse.spot, nse.lot]).toEqual(['BANKNIFTY', '27-Oct-2026', 54287.35, 30]);
    // NSE shows 19,335 / 11,852 / 16,416 / −6,496 contracts
    expect(nse.strikes.find((s) => s.strike === 54500)).toEqual({ strike: 54500, ceOi: 580050, ceChg: 355560, peOi: 492480, peChg: -194880 });
    expect(istLabel(nse.at)).toBe('23 Oct 15:40');
  });

  it('Sensibull and NSE are the same numbers at every strike of the window', () => {
    const a = analyzeSource(sb, 10).rows;
    const b = analyzeSource(nse, 10).rows;
    expect(a.map((r) => r.strike)).toEqual(W);
    expect(a).toEqual(b);
  });

  it('an index without a known lot size is refused; parser errors keep their messages', () => {
    const chain = JSON.parse(nseRaw);
    for (const r of chain.records.data) for (const leg of [r.CE, r.PE]) if (leg) leg.underlying = 'FINNIFTY';
    expect(() => readNse(JSON.stringify(chain))).toThrow(LotSizeError);
    expect(() => readSensibull('')).toThrow(SbParseError);
    expect(() => readSensibull('{"payload":{}}')).toThrow(/per_strike_data/);
    expect(() => readNse('<html>')).toThrow(ChainParseError);
    expect(() => readNse('not json')).toThrow(/Not valid JSON/);
  });
});

describe('the Excel sheet (Sensibull block, lakhs) matches the paste, apart from its typing slips', () => {
  // Rows "OI" (= yesterday's OI) and "OI Chang" exactly as typed in the sheet for 53,300 … 55,300.
  const CE_YEST = [0.02, 0.013, 0.186, 1.37, 0.07, 0.06, 0.10, 1.49, 0.15, 0.40, 0.46, 0.45, 2.240, 0.814, 1.60, 2.65, 2.44, 11.87, 1.57, 2.45, 2.72];
  const CE_CHG = [0.006, 0.022, 0.145, -0.36, 0.14, 0.30, 0.34, 2.03, 1.09, 2.03, 1.86, 1.610, 3.560, 0.893, 0.74, 1.48, 0.83, 1.95, 0.69, 0.30, 0.79];
  const PE_YEST = [1.68, 1.140, 4.510, 1.81, 1.13, 1.95, 1.20, 7.68, 1.23, 1.95, 1.47, 1.60, 6.870, 1.730, 1.60, 2.83, 2.27, 11.12, 1.04, 1.33, 1.87];
  const PE_CHG = [0.659, 0.573, -0.156, -0.16, 0.16, -0.65, -0.08, -0.40, 0.07, 0.41, 0.55, -0.256, -1.950, 0.473, 0.74, -0.53, -0.21, -2.72, -0.22, -0.19, -0.19];
  const rows = analyzeSource(sb, 10).rows;
  const off = (typed: number[], key: 'ceYest' | 'ceChg' | 'peYest' | 'peChg') =>
    W.filter((_, i) => Math.abs(typed[i] - lakh(rows[i][key])) > 0.01); // more than the sheet's 2-decimal rounding (55,100: 0.69 for 0.6987)

  it('only the known slips differ: 53,600 CE (PE numbers), 54,600 PE chg (sign), 54,700 PE (CE numbers)', () => {
    expect(off(CE_YEST, 'ceYest')).toEqual([53600]);
    expect(off(CE_CHG, 'ceChg')).toEqual([53600]);
    expect(off(PE_YEST, 'peYest')).toEqual([53600, 54700]);
    expect(off(PE_CHG, 'peChg')).toEqual([53600, 54600, 54700]);
  });

  it('the sheet strike PCRs where its inputs are right: 54,500 → 0.85, 55,000 → 0.61', () => {
    expect(round2(rows[W.indexOf(54500)].pcr!)).toBe(0.85);
    expect(round2(rows[W.indexOf(55000)].pcr!)).toBe(0.61);
  });
});

describe('window: ATM ± 10 strikes', () => {
  it('ATM 54,300, step 100, 53,300–55,300 (21 strikes) in both', () => {
    for (const src of [sb, nse]) {
      const r = analyzeSource(src, 10);
      expect([r.step, r.atm, r.rows.length, r.rows[0].strike, r.rows.at(-1)!.strike, r.below, r.above]).toEqual([100, 54300, 21, 53300, 55300, 10, 10]);
      expect(r.missing).toEqual([]);
    }
  });

  it('step from the data: 100 for BANKNIFTY, 50 for NIFTY, ignoring the wide far strikes', () => {
    expect(strikeStep([47000, 47500, 48000, 48700, 48800, 48900, 49000, 49100])).toBe(100);
    expect(strikeStep([24000, 24050, 24100, 24150, 24500, 25000])).toBe(50);
  });

  it('nearest strike to spot, lower one on an exact tie', () => {
    expect(nearestStrike(54287.35, [54200, 54300, 54400])).toBe(54300);
    expect(nearestStrike(54250, [54200, 54300])).toBe(54200);
  });

  const chain = (from: number, to: number): PcrSource => ({
    source: 'nse', symbol: 'NIFTY', expiry: '27-Oct-2026', at: 0, since: null, spot: 0, lot: 65,
    strikes: Array.from({ length: (to - from) / 50 + 1 }, (_, i) => ({ strike: from + i * 50, ceOi: 10, ceChg: 0, peOi: 10, peChg: 0 })),
  });

  it('at the low edge of the chain only the strikes that exist are used', () => {
    const r = analyzeSource({ ...chain(24000, 25000), spot: 24110 }, 10); // ATM 24,100: two strikes below
    expect([r.atm, r.below, r.above, r.rows[0].strike, r.rows.at(-1)!.strike, r.missing]).toEqual([24100, 2, 10, 24000, 24600, []]);
  });

  it('at the high edge too', () => {
    const r = analyzeSource({ ...chain(24000, 25000), spot: 24990 }, 10);
    expect([r.atm, r.below, r.above, r.rows[0].strike, r.rows.at(-1)!.strike]).toEqual([25000, 10, 0, 24500, 25000]);
  });

  it('a hole inside the chain is reported and left out of the totals', () => {
    const src = chain(24000, 25000);
    src.strikes = src.strikes.filter((s) => s.strike !== 24550);
    const r = analyzeSource({ ...src, spot: 24500 }, 2);
    expect([r.rows.map((x) => x.strike), r.missing, r.totals.ceOi]).toEqual([[24400, 24450, 24500, 24600], [24550], 40]);
  });

  it('the strike count is configurable', () => {
    expect(analyzeSource(sb, 5).rows.map((r) => r.strike)).toEqual([53800, 53900, 54000, 54100, 54200, 54300, 54400, 54500, 54600, 54700, 54800]);
  });
});

describe('strike rows: today = yesterday + change', () => {
  it('54,500: CE 2,24,490 + 3,55,560 = 5,80,050; PE 6,87,360 − 1,94,880 = 4,92,480; PCR 0.85', () => {
    const r = analyzeSource(nse, 10).rows.find((x) => x.strike === 54500)!;
    expect([r.ceYest, r.ceChg, r.ceOi, r.peYest, r.peChg, r.peOi]).toEqual([224490, 355560, 580050, 687360, -194880, 492480]);
    expect(round2(r.pcr!)).toBe(0.85);
  });

  it('55,000: CE 13,81,260, PE 8,40,390, PCR 0.61', () => {
    const r = analyzeSource(sb, 10).rows.find((x) => x.strike === 55000)!;
    expect([r.ceYest, r.ceOi, r.peYest, r.peOi]).toEqual([1186530, 1381260, 1111890, 840390]);
    expect(round2(r.pcr!)).toBe(0.61);
  });

  it('strike PCR is "—" (null) when CE today OI is 0', () => {
    const s: PcrStrike = { strike: 54000, ceOi: 0, ceChg: -120, peOi: 300, peChg: 0 };
    expect(strikeRow(s)).toMatchObject({ ceYest: 120, peYest: 300, pcr: null });
  });
});

describe('totals and PCR', () => {
  const totals = { ceYest: 3182430, ceChg: 2083230, ceOi: 5265660, peYest: 5807670, peChg: -694500, peOi: 5113170 };

  it('Sensibull and NSE totals are identical: PCR 51,13,170 ÷ 52,65,660 = 0.97', () => {
    for (const src of [sb, nse]) {
      const r = analyzeSource(src, 10);
      expect(r.totals).toEqual(totals);
      expect(round2(r.pcr!)).toBe(0.97);
    }
  });

  it('Final PCR = average of the two → 0.97, Sideways', () => {
    const f = finalPcr(analyzeSource(sb, 10).pcr, analyzeSource(nse, 10).pcr)!;
    expect(round2(f)).toBe(0.97);
    expect(verdict(f, TH)).toBe('sideways');
    expect(finalPcr(1.2, null)).toBeNull();
    expect(finalPcr(0.8, 1.0)).toBeCloseTo(0.9);
  });

  it('a source with Σ CE today OI of 0 has no PCR', () => {
    const src: PcrSource = { ...nse, strikes: nse.strikes.map((s) => ({ ...s, ceOi: 0, ceChg: 0 })) };
    expect(analyzeSource(src, 10).pcr).toBeNull();
  });
});

describe('verdict boundaries', () => {
  it('below 0.9 Down side, above 1.1 Up side, 0.9 and 1.1 themselves Sideways', () => {
    expect([0.89, 0.8999, 0.9, 1.0, 1.1, 1.1001, 1.11].map((v) => verdict(v, TH))).toEqual(
      ['down', 'sideways', 'sideways', 'sideways', 'sideways', 'sideways', 'up'],
    );
    // 0.8999 and 1.1001 show as 0.90 / 1.10, so they get the verdict of the number on screen
    expect([0.894, 0.895, 1.104, 1.105].map((v) => verdict(v, TH))).toEqual(['down', 'sideways', 'sideways', 'up']);
  });

  it('thresholds from Settings', () => {
    expect(verdict(0.97, { down: 0.8, up: 0.95 })).toBe('up');
    expect(verdict(0.97, { down: 1.0, up: 1.2 })).toBe('down');
  });
});

describe('checks between the two pastes', () => {
  it('the real pastes match: same index, expiry and time', () => {
    expect(checkSources(sb, nse, 5)).toEqual({ errors: [], warnings: [] });
    expect(atmNote(analyzeSource(sb, 10), analyzeSource(nse, 10))).toBe('');
  });

  it('different index or expiry is an error', () => {
    const c = checkSources(sb, { ...nse, symbol: 'NIFTY', expiry: '23-Nov-2026' }, 5);
    expect(c.errors).toHaveLength(2);
    expect(c.errors[0]).toMatch(/Sensibull is BANKNIFTY, NSE is NIFTY/);
    expect(c.errors[1]).toMatch(/Sensibull is 27-Oct-2026, NSE is 23-Nov-2026/);
  });

  it('more than 5 minutes apart only warns', () => {
    expect(checkSources(sb, { ...nse, at: nse.at - 5 * 60_000 }, 5).warnings).toEqual([]);
    const w = checkSources(sb, { ...nse, at: nse.at - 6 * 60_000 }, 5);
    expect([w.errors, w.warnings[0]]).toEqual([[], expect.stringMatching(/6 min apart/)]);
    expect(checkSources(sb, { ...nse, at: nse.at - 95 * 60_000 }, 5).warnings[0]).toMatch(/1 h 35 min apart/);
  });

  it('a Sensibull chart that does not start at 09:15 is flagged (its change is then not since yesterday)', () => {
    expect(sinceWarning({ ...sb, since: Date.parse('2026-10-23T14:30:00+05:30') })).toMatch(/starts at 14:30/);
    expect(sinceWarning(nse)).toBe('');
  });

  it('a different ATM gets a note', () => {
    expect(atmNote(analyzeSource(sb, 10), analyzeSource({ ...nse, spot: 54360 }, 10))).toMatch(/Sensibull 54300 .* NSE 54400/);
  });
});

describe('times', () => {
  it('NSE IST stamps and Sensibull UTC times', () => {
    expect(nseTime('23-Oct-2026 15:40:00')).toBe(Date.parse('2026-10-23T15:40:00+05:30'));
    expect(nseTime('garbage')).toBeNaN();
    expect(sensibullTime('2026-10-23T05:00:00Z')).toBe(Date.parse('2026-10-23T10:30:00+05:30')); // during market: as is
    expect(sensibullTime('2026-10-23T14:00:00Z')).toBe(Date.parse('2026-10-23T15:40:00+05:30')); // after close: 15:40
  });
});

describe('CSV', () => {
  it('strikes as columns, Total last, raw units', () => {
    const lines = sourceCsv(analyzeSource(nse, 1)).trim().split('\n');
    expect(lines[0]).toBe('Row (units),54200,54300,54400,Total');
    expect(lines).toHaveLength(8);
    expect(lines[3].startsWith('CE today OI,243210,231750,205950,')).toBe(true);
    expect(lines[4].startsWith('Strike PCR,')).toBe(true);
  });
});
