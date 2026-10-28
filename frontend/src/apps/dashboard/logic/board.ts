// Strategy board (owner 26-Oct-2026, simplified live dashboard): one row per strategy, one column per index. Each box
// says in a word where that strategy stands: In trade / GO / Close (one condition away) / Waiting. Pure functions only.
import { DEFAULT_INDICATORS, type IndicatorToggles } from '../config/settings';
import type { AutoStatus, AutoTrade, OiView, RuleResult, TrendingView } from './signals';

export type StrategyKey = 'fourPillar' | 'superTrend' | 'dharaniV2' | 'tradingHub' | 'reboundCall';
export const BOARD: { key: StrategyKey; name: string; account: string; only?: string[] }[] = [
  { key: 'fourPillar', name: '4 Pillar Rules', account: 'MegaBull · Grade A only' },
  { key: 'superTrend', name: 'SuperTrend Rules', account: 'MegaBull · Grade A only' },
  { key: 'dharaniV2', name: 'Dharani Rules', account: 'App · ₹1 lakh · 3-min' },
  { key: 'tradingHub', name: 'Trend Rules', account: 'App · ₹1 lakh · Grade A / B' },
  { key: 'reboundCall', name: 'Rebound Call', account: 'App · ₹1 lakh · BankNifty only', only: ['BANKNIFTY'] },
];

export type CellKind = 'trade' | 'go' | 'near' | 'wait' | 'none';
export interface Cell { kind: CellKind; title: string; sub: string }

const sideWord = (s: 'CE' | 'PE') => (s === 'PE' ? 'put' : 'call');
const money = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/** Did this strategy take the trade? (trades saved before the 4 Pillar / SuperTrend split carry slot "megabull" + a setup) */
export const byStrategy = (t: AutoTrade, key: StrategyKey) =>
  t.slot === key || (t.slot === 'megabull' && (key === 'fourPillar' || key === 'superTrend') && ((key === 'fourPillar') === /pillar/i.test(t.setup ?? '')));

/** Open auto trade of one strategy on one index. */
export function openTrade(auto: AutoStatus | null | undefined, key: StrategyKey, symbol: string): AutoTrade | undefined {
  return (auto?.open ?? []).find((t) => t.symbol === symbol && byStrategy(t, key));
}

/** Buy / sell points of today's trades for the chart: one strategy's ('all': every auto trade) on one index. */
export function tradeMarks(auto: AutoStatus | null | undefined, key: ChartStrategy, symbol: string): { time: number; kind: 'buy' | 'sell'; text: string }[] {
  if (!auto?.day) return [];
  const at = (hms: string) => Date.parse(`${auto.day}T${hms.length === 5 ? `${hms}:00` : hms}+05:30`) / 1000;
  const out: { time: number; kind: 'buy' | 'sell'; text: string }[] = [];
  for (const t of auto.today ?? []) {
    if (t.symbol !== symbol || t.account === 'manual' || (key !== 'all' && !byStrategy(t, key))) continue;
    const label = `${t.instrument.strike} ${t.side}`;
    if (t.entryTime) out.push({ time: at(t.entryTime), kind: 'buy', text: `Buy ${label} ${t.entryPrice}` });
    if (t.status === 'closed' && t.exitTime) out.push({ time: at(t.exitTime), kind: 'sell', text: `Sell ${t.exitPrice ?? ''}`.trim() });
  }
  return out.filter((m) => Number.isFinite(m.time));
}

/** How many of the rule's conditions are met: Dharani's own score; otherwise its checks, leaving out the "not checked,
 * does not block" delta ticks. */
export function score(r: RuleResult): { met: number; total: number } {
  if (r.score != null && r.total != null) return { met: r.score, total: r.total };
  const counted = r.checks.filter((c) => !(c.exempt && c.state === 'notChecked'));
  return { met: counted.filter((c) => c.state === 'pass').length, total: counted.length };
}

export function cell(r: RuleResult | null | undefined, open: AutoTrade | undefined, ltp?: number): Cell {
  if (open) {
    const now = ltp ?? open.ltp;
    const pnl = now != null ? (now - open.entryPrice) * open.qty : open.pnl;
    return { kind: 'trade', title: `In trade · ${sideWord(open.side)}`,
      sub: `${open.instrument.strike} ${open.side} · ${pnl != null ? `${money(pnl)} now` : `bought ${open.entryPrice}`}` };
  }
  if (!r) return { kind: 'none', title: 'No reading yet', sub: 'waits for the first candle' };
  const s = score(r);
  const base = `${sideWord(r.side)} · ${s.met} of ${s.total}`;
  if (r.go) return { kind: 'go', title: `GO${r.grade ? ` · Grade ${r.grade}` : ''}`, sub: `${sideWord(r.side)} · order sent ${r.at ?? ''}`.trim() };
  if (r.blocked.length && (r.grade || s.met === s.total)) return { kind: 'wait', title: 'Blocked', sub: `${sideWord(r.side)} · ${r.blocked[0]}` };
  if (s.total - s.met === 1) return { kind: 'near', title: `Close · ${s.met} of ${s.total}`, sub: `${sideWord(r.side)} · one condition away` };
  return { kind: 'wait', title: 'Waiting', sub: base };
}

/** "3 of 3 Bearish" / "Split: 1 bullish · 1 bearish · 1 neutral" from the three OI views. */
export function votesText(views: (OiView | TrendingView | null | undefined)[]): string {
  const vs = views.filter((v): v is OiView | TrendingView => !!v).map((v) => v.verdict);
  if (!vs.length) return '—';
  const n = (k: string) => vs.filter((v) => v === k).length;
  const top = (['Bullish', 'Bearish', 'Neutral'] as const).find((k) => n(k) > vs.length / 2);
  if (top) return `${n(top)} of ${vs.length} ${top}`;
  return `Split: ${(['Bullish', 'Bearish', 'Neutral'] as const).filter((k) => n(k)).map((k) => `${n(k)} ${k.toLowerCase()}`).join(' · ')}`;
}

/** Put share of OI + change (the "lean" shown next to the Dhan verdict). */
export function putShare(v: OiView | null | undefined): number | null {
  if (!v || v.putOi == null || v.callOi == null) return null;
  const put = v.putOi + (v.putChg ?? 0);
  const call = v.callOi + (v.callChg ?? 0);
  return put + call > 0 ? (put / (put + call)) * 100 : null;
}

/** What the chart shows for each strategy (owner 26-Oct-2026: only that strategy's indicators). */
export type ChartStrategy = 'all' | StrategyKey;
export interface ChartPreset { interval: number | null; indicators: IndicatorToggles; emaPeriod: number; bb: { period: number; mult: number }; note: string }
const OFF: IndicatorToggles = { rsi: false, ema: false, volume: false, supertrend: false, bollinger: false, vwap: false, delta: false };
export const CHART_PRESETS: Record<ChartStrategy, ChartPreset> = {
  all: { interval: null, indicators: DEFAULT_INDICATORS, emaPeriod: 20, bb: { period: 20, mult: 2 }, note: 'Just the price. Pick a strategy above to add its indicators, OI levels and trades.' },
  fourPillar: { interval: 5, indicators: { ...OFF, ema: true, vwap: true, rsi: true, delta: true }, emaPeriod: 20, bb: { period: 20, mult: 2 },
    note: 'EMA 20, VWAP, RSI 14, pivot and OI levels, cumulative delta. India VIX and PCR are on the strategy box.' },
  superTrend: { interval: 5, indicators: { ...OFF, supertrend: true, bollinger: true, rsi: true }, emaPeriod: 20, bb: { period: 20, mult: 2 },
    note: 'SuperTrend (10, 2), Bollinger (20, 2), RSI 14, pivot and OI levels.' },
  dharaniV2: { interval: 3, indicators: { ...OFF, supertrend: true, bollinger: true, ema: true, rsi: true }, emaPeriod: 200, bb: { period: 15, mult: 3 },
    note: 'SuperTrend (10, 2), Bollinger (15, 3) (the call rule; puts use 20, 2), EMA 200, RSI 14, pivot. Williams %R and CCI 20 are on the strategy box.' },
  tradingHub: { interval: 5, indicators: { ...OFF, supertrend: true, ema: true, vwap: true, bollinger: true, rsi: true, delta: true }, emaPeriod: 20,
    bb: { period: 20, mult: 2 }, note: 'SuperTrend, VWAP, EMA 20, Bollinger (20, 2), RSI 14, pivot. Trending OI is on the strategy box.' },
  reboundCall: { interval: 5, indicators: { ...OFF, ema: true, vwap: true }, emaPeriod: 200, bb: { period: 20, mult: 2 },
    note: 'EMA 200 and VWAP (BankNifty only). ATR and the 10-day average range are on the strategy box.' },
};
