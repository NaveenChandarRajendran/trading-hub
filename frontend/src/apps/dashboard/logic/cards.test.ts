// Glance cards on the real NIFTY 27-Oct chain (21-Oct-2026 after the close) plus small Trending OI / components data.
// Each verdict is checked against the app's own screen or logic for the same data.
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain, toSbSnapshot } from '../../../shared/dhan/chainAdapter';
import { analyzeOptionChain } from '../../option-strategy/logic/oiCalculation';
import { analyzeSnapshot } from '../../sensibull-oi/logic/sensibullCalc';
import { limitRange } from '../../sensibull-oi-live/logic/range';
import type { ToiRow } from '../../trending-oi/logic/api';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import type { Section, Summary } from './api';
import { buildCards, componentsCard, consensus, oiChangeCard, sensibullCard, srCard, srPosition, trendingCard, vsSpot } from './cards';
import { srLevels } from './levels';

const chainData = niftyJson as unknown as ChainResponse;
const ok = <T,>(data: T, asOf = '2026-10-21 15:40:00'): Section<T> => ({ status: 'ok', error: '', asOf, data });
const chain = ok(chainData);
const sr = srLevels(chainData, 500)!;

const row = (over: Partial<ToiRow>): ToiRow => ({
  no: 1, date: '21-10-2026', time: '15:25:00', ltp: 22811, dayHLBreak: null, callChg: 100, putChg: 50, diffOi: -50,
  strengthPct: -50, directionChg: 0, directionPct: 0, callLtpTotal: 0, putLtpTotal: 0, callLtpChg: 0, putLtpChg: 0,
  cePeLtpChg: 0, netPcr: 0.5, dayHLDiffBreak: null, sentiment: 'Bearish', live: false, ...over,
});
const toi = (rows: ToiRow[]): Summary['trendingOi'] =>
  ok({ meta: { symbol: 'NIFTY', expiry: '2026-10-27', interval: 5, strikes: [], strikeCount: 15, spot: 22811, asOf: '2026-10-21 15:25', marketOpen: false, tokenExpired: false, lastError: '', message: '' }, rows });

describe('verdicts come from each app\'s own logic', () => {
  it('Trending OI: the newest row\'s sentiment, Diff OI and Net PCR', () => {
    const c = trendingCard(toi([row({ sentiment: 'Bullish', diffOi: 1234500, netPcr: 1.42, time: '15:25:00' }), row({})]));
    expect([c.verdict, c.asOf, c.state]).toEqual(['Bullish', '15:25', 'ok']);
    expect(c.figures).toEqual([{ label: 'Diff OI', value: '+12,34,500', tone: 'up' }, { label: 'Net PCR', value: '1.42' }]);
  });

  it('OI & OI Change: BEARISH, final average 22,772.84 (−38.51), PCR 0.62, as on the OI & OI Change Live screen', () => {
    const c = oiChangeCard(chain);
    expect(c.verdict).toBe('Bearish');
    expect(c.figures[0]).toEqual({ label: 'Final avg', value: '22,772.84 (−38.51)', tone: 'down' });
    expect(c.figures[1].value).toBe('0.62');
    expect(analyzeOptionChain(toOptionChain(chainData)).verdict.verdict).toBe('BEARISH');
  });

  it('Sensibull: anticipated 22,806.79 is below spot 22,811.35 → Bearish (Sensibull OI Change Live defaults)', () => {
    const c = sensibullCard(chain);
    const a = analyzeSnapshot(limitRange(toSbSnapshot(chainData), 25), 'change', null);
    expect(a.anticipated).toBeCloseTo(22806.79, 2);
    expect(c.verdict).toBe('Bearish');
    expect(c.figures).toEqual([
      { label: 'Anticipated', value: '22,806.79 (−4.56)', tone: 'down' },
      { label: 'Avg PCR', value: '3.53' },
    ]);
  });

  it('OI S&R: no verdict, a "Levels" tag, and spot vs S1 / R1 (111 above S1, 189 below R1)', () => {
    const c = srCard(chain, sr);
    expect([c.verdict, c.tag]).toEqual([null, 'Levels']);
    expect(c.figures[0].value).toBe('111 pts above S1 · 189 below R1');
    expect(c.figures[1].value).toBe('0.70');
    expect(srPosition({ ...sr, levels: { R: sr.levels.R, S: [] } })).toBe('189 pts below R1');
  });

  it('vsSpot', () => {
    expect([vsSpot(101, 100), vsSpot(99, 100), vsSpot(100, 100)]).toEqual(['Bullish', 'Bearish', 'Neutral']);
  });
});

describe('Index Components card', () => {
  const list = [
    { name: 'HDFC Bank', symbol: 'HDFCBANK', weight: 30 },
    { name: 'ICICI Bank', symbol: 'ICICIBANK', weight: 20 },
    { name: 'Axis Bank', symbol: 'AXISBANK', weight: 10 },
  ];
  const now = new Date('2026-10-21T06:00:00Z'); // 11:30 IST
  const yday = Date.parse('2026-10-20T00:00:00+05:30') / 1000;
  const today = Date.parse('2026-10-21T00:00:00+05:30') / 1000;
  const hist = (prev: number) => ({ timestamp: [yday, today], close: [prev, 999] }); // today's partial candle is ignored
  const comp = (quotes: Record<string, number>, prevs: Record<string, number>, status: 'ok' | 'warming' = 'ok') => ({
    ...ok({
      quotes: Object.fromEntries(Object.entries(quotes).map(([k, v]) => [k, { ltp: v }])),
      history: Object.fromEntries(Object.entries(prevs).map(([k, v]) => [k, hist(v)])),
      unknown: [], pending: [],
    }), status,
  });

  it('advancing / declining and index move from components, with the ±0.05 neutral band', () => {
    // HDFC +1% × 30% = +0.30, ICICI −1% × 20% = −0.20, Axis 0 → +0.10 index % points → Bullish
    const c = componentsCard(comp({ HDFCBANK: 101, ICICIBANK: 99, AXISBANK: 50 }, { HDFCBANK: 100, ICICIBANK: 100, AXISBANK: 50 }), list, now);
    expect(c.verdict).toBe('Bullish');
    expect(c.figures).toEqual([{ label: 'Adv · Dec', value: '▲ 1 · ▼ 1' }, { label: 'From components', value: '+0.10%', tone: 'up' }]);
    // +0.30 − 0.30 + 0.04 = +0.04 → inside the band → Neutral
    const n = componentsCard(comp({ HDFCBANK: 101, ICICIBANK: 98.5, AXISBANK: 50.2 }, { HDFCBANK: 100, ICICIBANK: 100, AXISBANK: 50 }), list, now);
    expect([n.verdict, n.figures[1].value]).toEqual(['Neutral', '+0.04%']);
    const b = componentsCard(comp({ HDFCBANK: 99 }, { HDFCBANK: 100 }), list, now);
    expect([b.verdict, b.figures[1].value]).toEqual(['Bearish', '−0.30%']);
  });

  it('while previous closes load: figures so far, but no verdict (a partial index could flip it)', () => {
    const none = componentsCard(comp({ HDFCBANK: 101 }, {}, 'warming'), list, now);
    expect([none.state, none.verdict, none.figures]).toEqual(['warming', null, []]);
    const some = componentsCard(comp({ HDFCBANK: 101, ICICIBANK: 99 }, { HDFCBANK: 100 }, 'warming'), list, now);
    expect(some.verdict).toBeNull();
    expect(some.figures[1].value).toBe('+0.30%');
    expect(some.message).toBe('1 of 3 stocks so far; verdict once all previous closes are in.');
    expect(consensus([some])).toEqual({ Bullish: 0, Bearish: 0, Neutral: 0 });
  });
});

describe('states and consensus', () => {
  it('a failed or empty section gives that card its state and message, and no verdict', () => {
    const err: Summary['chain'] = { status: 'error', error: 'Dhan HTTP 502', asOf: null, data: null };
    expect(oiChangeCard(err)).toMatchObject({ state: 'error', verdict: null, message: 'Dhan HTTP 502', figures: [] });
    const token: Summary['chain'] = { status: 'token', error: 'Dhan access token expired', asOf: null, data: null };
    expect(sensibullCard(token)).toMatchObject({ state: 'token', verdict: null });
    const empty = { ...toi([]), status: 'empty' as const };
    empty.data!.meta.message = 'Market is closed and nothing was recorded today.';
    expect(trendingCard(empty)).toMatchObject({ state: 'empty', verdict: null, message: 'Market is closed and nothing was recorded today.' });
    expect(oiChangeCard(undefined).state).toBe('loading');
  });

  it('a stale chain still gives values (the card shows it as stale)', () => {
    const c = oiChangeCard({ ...chain, status: 'stale', error: 'Dhan HTTP 502' });
    expect([c.state, c.verdict]).toEqual(['stale', 'Bearish']);
  });

  it('consensus counts verdicts only: the Levels tag and failed cards are left out', () => {
    const summary: Summary = {
      meta: { symbol: 'NIFTY', expiry: '2026-10-27', asOf: '2026-10-21 15:40:00', marketOpen: false, tokenExpired: false, message: '' },
      chain,
      trendingOi: toi([row({ sentiment: 'Bullish', diffOi: 5 })]),
      components: { status: 'error', error: 'boom', asOf: null, data: null },
    };
    const cards = buildCards(summary, sr, []);
    expect(cards.map((c) => c.id)).toEqual(['trending', 'oi-change', 'sensibull', 'components', 'sr']);
    expect(consensus(cards)).toEqual({ Bullish: 1, Bearish: 2, Neutral: 0 });
  });

  it('no summary at all (backend down): every card shows the error instead of loading', () => {
    const cards = buildCards(null, null, [], new Date(), 'Cannot reach the backend at http://127.0.0.1:8000.');
    expect(cards.map((c) => c.state)).toEqual(['error', 'error', 'error', 'error', 'error']);
    expect(cards[0].message).toMatch(/Cannot reach the backend/);
    expect(buildCards(null, null, []).map((c) => c.state)).toEqual(['loading', 'loading', 'loading', 'loading', 'loading']);
  });

  it('market closed: cards still show the last session with its time', () => {
    const c = oiChangeCard(chain);
    expect([c.state, c.asOf]).toEqual(['ok', '15:40']);
  });
});
