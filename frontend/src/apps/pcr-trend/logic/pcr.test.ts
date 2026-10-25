// PCR Trend Analysis against the real 23-Oct-2026 BANKNIFTY pastes (expiry 23-Nov-2026, 15:40 IST, spot 54,287.35).
// Expected values summed by hand from the two fixtures (per_strike_data / records.data) over 53,300–55,300.
import { describe, expect, it } from 'vitest';
import sbRaw from './__fixtures__/sensibull-banknifty-2026-10-23.json?raw';
import nseRaw from './__fixtures__/nse-banknifty-2026-10-23.json?raw';
import { SbParseError } from '../../sensibull-oi/logic/sensibull';
import { ChainParseError } from '../../option-strategy/logic/optionChain';
import { istLabel, nseTime, readNse, readSensibull, sensibullTime, type PcrSource, type PcrStrike } from './sources';
import {
  analyzeSource, atmNote, checkSources, finalPcr, nearestStrike, round2, sourceCsv, strikeRow, strikeStep, verdict,
} from './pcr';

const TH = { down: 0.9, up: 1.1 };
const sb = readSensibull(sbRaw);
const nse = readNse(nseRaw);

describe('parsing the real pastes', () => {
  it('Sensibull: index, expiry, spot, OI = to_*_oi, chg = to − from, time capped at 15:40 IST', () => {
    expect([sb.symbol, sb.expiry, sb.spot, sb.unit]).toEqual(['BANKNIFTY', '23-Nov-2026', 54287.35, 'units']);
    expect(sb.strikes.find((s) => s.strike === 54500)).toEqual({ strike: 54500, ceOi: 191520, ceChg: 146670, peOi: 244740, peChg: 96090 });
    expect(istLabel(sb.at)).toBe('23 Oct 15:40'); // to_time is 19:30 IST, the data ends 15:40
    expect(istLabel(sb.since!)).toBe('23 Oct 09:15');
  });

  it('NSE: index, expiry, spot, openInterest / changeinOpenInterest, timestamp in IST', () => {
    expect([nse.symbol, nse.expiry, nse.spot, nse.unit]).toEqual(['BANKNIFTY', '23-Nov-2026', 54287.35, 'contracts']);
    expect(nse.strikes.find((s) => s.strike === 54500)).toEqual({ strike: 54500, ceOi: 6384, ceChg: 4889, peOi: 8158, peChg: 3203 });
    expect(istLabel(nse.at)).toBe('23 Oct 15:40');
    expect(nse.since).toBeNull();
  });

  it('the two sources are the same data in different units: Sensibull = NSE × 30 (BANKNIFTY lot) across the window', () => {
    const a = analyzeSource(sb, 10).rows;
    const b = analyzeSource(nse, 10).rows;
    expect(a.map((r) => r.strike)).toEqual(b.map((r) => r.strike));
    a.forEach((r, i) => expect([r.ceOi, r.ceChg, r.peOi, r.peChg]).toEqual([b[i].ceOi, b[i].ceChg, b[i].peOi, b[i].peChg].map((v) => v * 30)));
  });

  it('parser errors come through with their readable messages', () => {
    expect(() => readSensibull('')).toThrow(SbParseError);
    expect(() => readSensibull('{"payload":{}}')).toThrow(/per_strike_data/);
    expect(() => readNse('<html>')).toThrow(ChainParseError);
    expect(() => readNse('not json')).toThrow(/Not valid JSON/);
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
    source: 'nse', symbol: 'NIFTY', expiry: '27-Oct-2026', at: 0, since: null, spot: 0, unit: 'contracts',
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

describe('strike rows', () => {
  it('Sensibull 54,500 and 55,000', () => {
    const r = analyzeSource(sb, 10).rows;
    const s545 = r.find((x) => x.strike === 54500)!;
    expect([s545.ceSum, s545.peSum, round2(s545.pcr!)]).toEqual([338190, 340830, 1.01]); // 1,91,520 + 1,46,670 · 2,44,740 + 96,090
    const s550 = r.find((x) => x.strike === 55000)!;
    expect([s550.ceSum, s550.peSum, round2(s550.pcr!)]).toEqual([708210, 617460, 0.87]);
  });

  it('NSE 54,500 and 55,000', () => {
    const r = analyzeSource(nse, 10).rows;
    const s545 = r.find((x) => x.strike === 54500)!;
    expect([s545.ceSum, s545.peSum, round2(s545.pcr!)]).toEqual([11273, 11361, 1.01]);
    const s550 = r.find((x) => x.strike === 55000)!;
    expect([s550.ceSum, s550.peSum, round2(s550.pcr!)]).toEqual([23607, 20582, 0.87]);
  });

  it('strike PCR is "—" (null) when CE OI + chg is 0', () => {
    const s: PcrStrike = { strike: 54000, ceOi: 120, ceChg: -120, peOi: 300, peChg: 0 };
    expect(strikeRow(s)).toMatchObject({ ceSum: 0, peSum: 300, pcr: null });
  });
});

describe('totals and PCR', () => {
  it('Sensibull totals (units): PCR 1.07', () => {
    const r = analyzeSource(sb, 10);
    expect(r.totals).toEqual({ ceOi: 1207200, ceChg: 603390, ceSum: 1810590, peOi: 1540530, peChg: 402870, peSum: 1943400 });
    expect(round2(r.pcr!)).toBe(1.07);
  });

  it('NSE totals (contracts): PCR 1.07', () => {
    const r = analyzeSource(nse, 10);
    expect(r.totals).toEqual({ ceOi: 40240, ceChg: 20113, ceSum: 60353, peOi: 51351, peChg: 13429, peSum: 64780 });
    expect(round2(r.pcr!)).toBe(1.07);
  });

  it('Final PCR = average of the two → 1.07, Sideways', () => {
    const f = finalPcr(analyzeSource(sb, 10).pcr, analyzeSource(nse, 10).pcr)!;
    expect(round2(f)).toBe(1.07);
    expect(verdict(f, TH)).toBe('sideways');
    expect(finalPcr(1.2, null)).toBeNull();
    expect(finalPcr(0.8, 1.0)).toBeCloseTo(0.9);
  });

  it('a source with Σ CE OI + chg of 0 has no PCR', () => {
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
    expect(verdict(1.07, { down: 0.8, up: 1.05 })).toBe('up');
    expect(verdict(1.07, { down: 1.08, up: 1.2 })).toBe('down');
  });
});

describe('checks between the two pastes', () => {
  it('the real pastes match: same index, expiry and time', () => {
    expect(checkSources(sb, nse, 5)).toEqual({ errors: [], warnings: [], notes: [] });
    expect(atmNote(analyzeSource(sb, 10), analyzeSource(nse, 10))).toBe('');
  });

  it('different index or expiry is an error', () => {
    const c = checkSources(sb, { ...nse, symbol: 'NIFTY', expiry: '27-Oct-2026' }, 5);
    expect(c.errors).toHaveLength(2);
    expect(c.errors[0]).toMatch(/Sensibull is BANKNIFTY, NSE is NIFTY/);
    expect(c.errors[1]).toMatch(/Sensibull is 23-Nov-2026, NSE is 27-Oct-2026/);
  });

  it('more than 5 minutes apart only warns', () => {
    expect(checkSources(sb, { ...nse, at: nse.at - 4 * 60_000 }, 5).warnings).toEqual([]);
    expect(checkSources(sb, { ...nse, at: nse.at - 5 * 60_000 }, 5).warnings).toEqual([]);
    const w = checkSources(sb, { ...nse, at: nse.at - 6 * 60_000 }, 5);
    expect([w.errors, w.warnings[0]]).toEqual([[], expect.stringMatching(/6 min apart/)]);
    expect(checkSources(sb, { ...nse, at: nse.at - 95 * 60_000 }, 5).warnings[0]).toMatch(/1 h 35 min apart/);
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
  it('strikes as columns, Total last, raw numbers', () => {
    const lines = sourceCsv(analyzeSource(nse, 1)).trim().split('\n');
    expect(lines[0]).toBe('Row (contracts),54200,54300,54400,Total');
    expect(lines).toHaveLength(8);
    expect(lines[4].startsWith('Strike PCR,')).toBe(true);
  });
});
