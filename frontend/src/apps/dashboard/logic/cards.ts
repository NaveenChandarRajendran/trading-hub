// Glance cards: each card is computed with its app's own logic from the summary response. Pure: no React.
// Verdicts (approved 2026-10-22):
//   Trending OI          latest row's sentiment (backend calc: Bullish if Diff OI > 0)
//   OI & OI Change Live  getVerdict: final average (5–25) vs spot
//   Sensibull OI Live    anticipated level vs spot (Change in OI, windows 10 + 20, ATM ±25: the live app's defaults)
//   OI S&R Live          no verdict: a neutral "Levels" tag, not counted in the consensus
//   Index Components     index move from components: > +0.05 Bullish, < −0.05 Bearish, otherwise Neutral
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain, toSbSnapshot } from '../../../shared/dhan/chainAdapter';
import { inr, signed } from '../../../shared/grid';
import { buildRows, summarize, type Constituent, type Quote } from '../../components/logic/components';
import { selectPrevClose } from '../../components/logic/prevClose';
import { analyzeOptionChain } from '../../option-strategy/logic/oiCalculation';
import { analyzeSnapshot } from '../../sensibull-oi/logic/sensibullCalc';
import { DEFAULT_RANGE as SB_RANGE } from '../../sensibull-oi-live/config/settings';
import { limitRange } from '../../sensibull-oi-live/logic/range';
import type { Section, SectionStatus, Summary } from './api';
import type { SrLevels } from './levels';

export type Verdict = 'Bullish' | 'Bearish' | 'Neutral';
export const COMPONENTS_NEUTRAL_BAND = 0.05; // index % points

export interface Figure {
  label: string;
  value: string;
  tone?: 'up' | 'down' | '';
}

export interface CardModel {
  id: string;
  title: string;
  path: string; // the full app
  state: SectionStatus | 'loading';
  verdict: Verdict | null; // null: no verdict (see tag) or not computed
  tag?: string; // shown instead of a verdict, e.g. "Levels"
  figures: Figure[];
  asOf: string | null; // "11:05"
  message: string; // why there is nothing to show / what is wrong
}

const tone = (v: number): Figure['tone'] => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const hhmm = (s: string | null | undefined) => (s ? s.slice(11, 16) : null); // "2026-10-21 11:05:03" -> "11:05"
export const vsSpot = (value: number, spot: number): Verdict => (value > spot ? 'Bullish' : value < spot ? 'Bearish' : 'Neutral');

function shell(id: string, title: string, path: string, s: Section<unknown> | undefined): CardModel {
  return {
    id, title, path, state: s ? s.status : 'loading', verdict: null, figures: [], asOf: hhmm(s?.asOf), message: s?.error ?? '',
  };
}
const usable = (s: Section<unknown> | undefined) => !!s?.data && (s.status === 'ok' || s.status === 'stale');

export function trendingCard(s: Summary['trendingOi'] | undefined): CardModel {
  const c = shell('trending', 'Trending OI', '/trending-oi', s);
  const row = s?.data?.rows[0];
  if (s?.status === 'empty') c.message = s.data?.meta.message || s.error;
  if (!usable(s) || !row) return c;
  c.verdict = row.sentiment === 'Bullish' ? 'Bullish' : 'Bearish';
  c.figures = [
    { label: 'Diff OI', value: signed(0)(row.diffOi), tone: tone(row.diffOi) },
    { label: 'Net PCR', value: row.netPcr == null ? '—' : inr(2)(row.netPcr) },
  ];
  c.asOf = row.time.slice(0, 5);
  return c;
}

export function oiChangeCard(s: Summary['chain'] | undefined): CardModel {
  const c = shell('oi-change', 'OI & OI Change Live', '/oi-change-live', s);
  if (!usable(s)) return c;
  const chain = toOptionChain(s!.data as ChainResponse);
  if (!chain.strikes.length) return { ...c, state: 'empty', message: 'No strikes for this expiry.' };
  const a = analyzeOptionChain(chain);
  c.verdict = a.verdict.verdict === 'BULLISH' ? 'Bullish' : a.verdict.verdict === 'BEARISH' ? 'Bearish' : 'Neutral';
  c.figures = [
    { label: 'Final avg', value: `${inr(2)(a.win.overallAverage)} (${signed(2)(a.verdict.points)})`, tone: tone(a.verdict.points) },
    { label: 'PCR', value: inr(2)(a.summary.pcr) },
  ];
  return c;
}

export function sensibullCard(s: Summary['chain'] | undefined): CardModel {
  const c = shell('sensibull', 'Sensibull OI Change Live', '/sensibull-oi-live', s);
  if (!usable(s)) return c;
  const snap = limitRange(toSbSnapshot(s!.data as ChainResponse), SB_RANGE);
  if (!snap.strikes.length) return { ...c, state: 'empty', message: 'No strikes for this expiry.' };
  const a = analyzeSnapshot(snap, 'change', null);
  c.verdict = vsSpot(a.anticipated, snap.spot);
  c.figures = [
    { label: 'Anticipated', value: `${inr(2)(a.anticipated)} (${signed(2)(a.anticipated - snap.spot)})`, tone: tone(a.anticipated - snap.spot) },
    { label: 'Avg PCR', value: inr(2)(a.avgPcr) },
  ];
  return c;
}

/** "85 pts above S1 · 15 below R1", for the given spot (default: the spot the levels were computed at). */
export function srPosition(sr: SrLevels, spot = sr.spot): string {
  const s1 = sr.levels.S[0];
  const r1 = sr.levels.R[0];
  const above = s1 ? `${inr(0)(Math.round(Math.abs(spot - s1.strike)))} pts ${spot >= s1.strike ? 'above' : 'below'} S1` : '';
  const below = r1 ? `${inr(0)(Math.round(Math.abs(r1.strike - spot)))} ${s1 ? '' : 'pts '}${spot <= r1.strike ? 'below' : 'above'} R1` : '';
  return [above, below].filter(Boolean).join(' · ') || 'No S1 / R1 within range';
}

/** sr: the levels drawn on the chart (backend stability rule); the position uses the latest spot from the summary's chain. */
export function srCard(s: Summary['chain'] | undefined, sr: SrLevels | null): CardModel {
  const c = shell('sr', 'OI Support & Resistance Live', '/oi-support-resistance-live', s);
  c.tag = 'Levels';
  if (!usable(s)) return c;
  if (!sr) return { ...c, state: 'empty', message: 'No strikes near spot for this expiry.' };
  const spot = (s!.data as ChainResponse).meta.spot || sr.spot;
  c.figures = [
    { label: 'Spot', value: srPosition(sr, spot) },
    { label: 'PCR', value: sr.analysis.pcr == null ? '—' : inr(2)(sr.analysis.pcr) },
  ];
  return c;
}

export function componentsCard(s: Summary['components'] | undefined, list: Constituent[], now = new Date()): CardModel {
  const c = shell('components', 'Index Components', '/index-components', s);
  if (!s?.data || !(s.status === 'ok' || s.status === 'stale' || s.status === 'warming')) return c;
  // the app's own functions: buildRows wants quotes keyed by security id, so give every symbol a local one
  const ids: Record<string, number> = {};
  const quotes: Record<string, Quote> = {};
  list.forEach((x, i) => {
    const q = s.data!.quotes[x.symbol];
    if (!q) return;
    const h = s.data!.history[x.symbol];
    ids[x.symbol] = i;
    quotes[String(i)] = { ltp: q.ltp, prevClose: h ? selectPrevClose(h.timestamp, h.close, now) ?? undefined : undefined };
  });
  const sum = summarize(buildRows(list, ids, quotes));
  if (!sum.priced) return { ...c, message: s.error || 'Waiting for previous closes.' };
  c.figures = [
    { label: 'Adv · Dec', value: `▲ ${sum.advancing} · ▼ ${sum.declining}` },
    { label: 'From components', value: `${signed(2)(sum.indexMove)}%`, tone: tone(sum.indexMove) },
  ];
  if (s.status === 'warming') {
    // part of the index only: show the figures so far, but no verdict (it could flip once every close is in)
    c.message = `${sum.priced} of ${sum.total} stocks so far; verdict once all previous closes are in.`;
    return c;
  }
  c.verdict = sum.indexMove > COMPONENTS_NEUTRAL_BAND ? 'Bullish' : sum.indexMove < -COMPONENTS_NEUTRAL_BAND ? 'Bearish' : 'Neutral';
  return c;
}

/** failure: why there is no summary at all (e.g. backend not running); every card then shows it instead of "Loading…". */
export function buildCards(summary: Summary | null, sr: SrLevels | null, constituents: Constituent[], now = new Date(), failure = ''): CardModel[] {
  const cards = [
    trendingCard(summary?.trendingOi),
    oiChangeCard(summary?.chain),
    sensibullCard(summary?.chain),
    componentsCard(summary?.components, constituents, now),
    srCard(summary?.chain, sr),
  ];
  return !summary && failure ? cards.map((c) => ({ ...c, state: 'error' as const, message: failure })) : cards;
}

/** "Bullish 3 · Bearish 1 · Neutral 1": cards with a verdict only (no verdict, loading or failed cards don't count). */
export function consensus(cards: CardModel[]): Record<Verdict, number> {
  const out: Record<Verdict, number> = { Bullish: 0, Bearish: 0, Neutral: 0 };
  for (const c of cards) if (c.verdict) out[c.verdict] += 1;
  return out;
}
