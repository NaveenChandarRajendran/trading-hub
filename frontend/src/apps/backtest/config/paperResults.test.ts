// The Backtest page cards (owner 5-Nov-2026): same totals as the results page.
import { describe, expect, it } from 'vitest';
import { RESULTS, lakhText, summarize } from './paperResults';

const by = (id: string) => summarize(RESULTS.find((r) => r.id === id)!);

describe('paper strategy results', () => {
  it('rupee cards add their years up from zero', () => {
    expect(lakhText(by('ladder').total, true)).toBe('+₹12.18L');
    expect(lakhText(by('weekly').total, true)).toBe('+₹7.37L');
    expect(lakhText(by('fear').total, true)).toBe('+₹6.99L');
    expect(lakhText(by('box').total, true)).toBe('−₹4.45L');
    expect(by('ladder').perYear).toBe(243650);
    expect(by('breakout').perYearPct).toBe(21);
    expect(by('ladder').points[0]).toEqual({ year: '2020', value: 0 });
  });
  it('stock cards compound the yearly growth on ₹5 lakh', () => {
    expect(lakhText(by('momSwitch').end)).toBe('₹11.49L');
    expect(lakhText(by('momAll').end)).toBe('₹17.96L');
    expect(lakhText(by('clenow').end)).toBe('₹11.21L');
    expect(by('clenow').perYearPct).toBe(18);
  });
  it('only the paper strategies, 11 up and 1 down', () => {
    expect(RESULTS).toHaveLength(12);
    expect(RESULTS.filter((r) => summarize(r).total > 0)).toHaveLength(11);
  });
});
