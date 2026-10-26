import { describe, expect, it } from 'vitest';
import { CHART_PRESETS, cell, openTrade, score, tradeMarks, votesText, putShare } from './board';
import type { AutoStatus, AutoTrade, Check, OiView, RuleResult } from './signals';

const ck = (state: Check['state'], exempt = false): Check => ({ id: 'x', label: 'x', detail: '', state, must: false, exempt });
const rule = (over: Partial<RuleResult>): RuleResult => ({ rule: 'superTrend', name: 'SUPERTREND RULES', account: 'MegaBull paper', symbol: 'NIFTY',
  side: 'CE', go: false, grade: null, checks: [ck('pass'), ck('pass'), ck('fail'), ck('notChecked', true)], blocked: [], tags: [], at: '10:05', ...over });
const trade = (over: Partial<AutoTrade>): AutoTrade => ({ id: 't', account: 'megabull', slot: 'superTrend', symbol: 'NIFTY', rule: 'SUPERTREND RULES', grade: 'A',
  side: 'CE', instrument: { id: 1, name: 'NIFTY 22650 CE', strike: 22650, expiry: '2026-10-27', optionType: 'CE', lotSize: 65 }, qty: 65, entryTime: '12:35:43',
  entryPrice: 131.7, stop: 118.5, target: 158.05, status: 'open', high: 131.7, low: 131.7, ...over });

describe('strategy board', () => {
  it('scores leave out the not-checked delta tick; Dharani uses its own score', () => {
    expect(score(rule({}))).toEqual({ met: 2, total: 3 });
    expect(score(rule({ score: 4, total: 5 }))).toEqual({ met: 4, total: 5 });
  });

  it('box states: in trade > GO > blocked > close > waiting', () => {
    const t = trade({});
    expect(cell(rule({}), t, 140)).toEqual({ kind: 'trade', title: 'In trade · call', sub: '22650 CE · +₹540 now' });
    expect(cell(rule({ go: true, grade: 'A' }), undefined).kind).toBe('go');
    expect(cell(rule({}), undefined)).toEqual({ kind: 'near', title: 'Close · 2 of 3', sub: 'call · one condition away' });
    expect(cell(rule({ checks: [ck('pass'), ck('fail'), ck('fail')] }), undefined).title).toBe('Waiting');
    expect(cell(rule({ grade: 'A', blocked: ['No new entries after 14:30'] }), undefined)).toEqual({ kind: 'wait', title: 'Blocked', sub: 'call · No new entries after 14:30' });
    expect(cell(null, undefined).kind).toBe('none');
  });

  it('finds the open trade of a strategy on an index, also for trades saved before the 4 Pillar / SuperTrend split', () => {
    const auto = { open: [trade({}), trade({ id: 'old', slot: 'megabull', setup: '4 Pillar', symbol: 'BANKNIFTY' })] } as unknown as AutoStatus;
    expect(openTrade(auto, 'superTrend', 'NIFTY')?.id).toBe('t');
    expect(openTrade(auto, 'fourPillar', 'BANKNIFTY')?.id).toBe('old');
    expect(openTrade(auto, 'superTrend', 'BANKNIFTY')).toBeUndefined();
  });

  it('OI votes say "Split" when no view has a majority; the put share is the lean', () => {
    const v = (verdict: OiView['verdict']) => ({ verdict }) as OiView;
    expect(votesText([v('Bearish'), v('Bullish'), v('Neutral')])).toBe('Split: 1 bullish · 1 bearish · 1 neutral');
    expect(votesText([v('Bearish'), v('Bearish'), v('Neutral')])).toBe('2 of 3 Bearish');
    expect(votesText([null])).toBe('—');
    // 26-Oct 12:30 Nifty: put 47,37,002 + 17,18,682, call 46,48,821 + 5,55,769 -> puts 55.4 %
    expect(putShare({ putOi: 4737002, putChg: 1718682, callOi: 4648821, callChg: 555769 } as OiView)).toBeCloseTo(55.36, 2);
  });

  it('each strategy shows only its indicators', () => {
    expect(CHART_PRESETS.dharaniV2).toMatchObject({ interval: 3, emaPeriod: 200, bb: { period: 15, mult: 3 } });
    expect(CHART_PRESETS.superTrend.indicators).toMatchObject({ supertrend: true, bollinger: true, rsi: true, vwap: false, ema: false });
    expect(CHART_PRESETS.all.interval).toBeNull();
  });

  it('marks the buy and sell of the strategy\'s trades today (IST times to epoch seconds)', () => {
    const auto = { day: '2026-10-26', open: [], today: [
      trade({ status: 'closed', exitTime: '12:37:10', exitPrice: 118.5 }),
      trade({ id: 'b', slot: 'tradingHub', symbol: 'BANKNIFTY', entryTime: '09:35:45' }),
    ] } as unknown as AutoStatus;
    const m = tradeMarks(auto, 'superTrend', 'NIFTY');
    expect(m).toEqual([
      { time: Date.UTC(2026, 9, 26, 7, 5, 43) / 1000, kind: 'buy', text: 'Buy 22650 CE 131.7' },
      { time: Date.UTC(2026, 9, 26, 7, 7, 10) / 1000, kind: 'sell', text: 'Sell 118.5' },
    ]);
    expect(tradeMarks(auto, 'superTrend', 'BANKNIFTY')).toEqual([]);
    expect(tradeMarks(auto, 'all', 'BANKNIFTY')).toHaveLength(1);
  });
});
