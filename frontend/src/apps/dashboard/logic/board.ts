// Strategy board (owner 26-Oct-2026, simplified live dashboard): one row per strategy, one column per index. Each box
// says in a word where that strategy stands: In trade / GO / Close (one condition away) / Waiting. Pure functions only.
import { DEFAULT_INDICATORS, type IndicatorToggles } from '../config/settings';
import type { AutoStatus, AutoTrade, OiView, RuleResult, TrendingView } from './signals';

export type StrategyKey = 'fourPillar' | 'superTrend' | 'dharaniV2' | 'tradingHub' | 'reboundCall' | 'orbPullback' | 'orbPullback5';
export const BOARD: { key: StrategyKey; name: string; account: string; only?: string[] }[] = [
  { key: 'fourPillar', name: '4 Pillar Rules', account: 'MegaBull · Grade A only' },
  { key: 'superTrend', name: 'SuperTrend Rules', account: 'MegaBull · Grade A only' },
  { key: 'dharaniV2', name: 'SuperTrend Breakout', account: 'App · ₹1 lakh · 3-min' },
  { key: 'tradingHub', name: 'Trend Rules', account: 'App · ₹1 lakh · Grade A / B' },
  { key: 'reboundCall', name: 'Rebound Call', account: 'App · ₹1 lakh · BankNifty only', only: ['BANKNIFTY'] },
  { key: 'orbPullback', name: 'Box Pullback 15/5', account: 'App · ₹1 lakh · 15-min box, 5-min close' },
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

/** Closed auto trades of one strategy on one index today. */
export function doneTrades(auto: AutoStatus | null | undefined, key: StrategyKey, symbol: string): AutoTrade[] {
  return (auto?.today ?? []).filter((t) => t.status === 'closed' && t.symbol === symbol && byStrategy(t, key));
}

/** One box of the board. After the close (owner 29-Oct-2026: no stale "Waiting" once the day is over) it says how the day ended. */
export function cell(r: RuleResult | null | undefined, open: AutoTrade | undefined, ltp?: number, opts: { done?: AutoTrade[]; closed?: boolean } = {}): Cell {
  if (open) {
    const now = ltp ?? open.ltp;
    const pnl = now != null ? (now - open.entryPrice) * open.qty : open.pnl;
    return { kind: 'trade', title: `In trade · ${sideWord(open.side)}`,
      sub: `${open.instrument.strike} ${open.side} · ${pnl != null ? `${money(pnl)} ${opts.closed ? 'at close' : 'now'}` : `bought ${open.entryPrice}`}` };
  }
  const done = opts.done ?? [];
  if (done.length) {
    return { kind: 'wait', title: 'Done today', sub: `${done.length} trade${done.length > 1 ? 's' : ''} · ${money(done.reduce((t, x) => t + (x.netPnl ?? x.pnl ?? 0), 0))}` };
  }
  if (opts.closed) return { kind: 'none', title: 'No trade today', sub: r ? `market closed · last check ${score(r).met} of ${score(r).total}` : 'market closed' };
  if (!r) return { kind: 'none', title: 'No reading yet', sub: 'waits for the first candle' };
  const s = score(r);
  const base = `${sideWord(r.side)} · ${s.met} of ${s.total}`;
  if (r.go) return { kind: 'go', title: `GO${r.grade ? ` · Grade ${r.grade}` : ''}`, sub: `${sideWord(r.side)} · order sent ${r.at ?? ''}`.trim() };
  if (r.blocked.length && (r.grade || s.met === s.total)) return { kind: 'wait', title: 'Blocked', sub: `${sideWord(r.side)} · ${r.blocked[0]}` };
  if (s.total - s.met === 1) return { kind: 'near', title: `Close · ${s.met} of ${s.total}`, sub: `${sideWord(r.side)} · one condition away` };
  return { kind: 'wait', title: 'Waiting', sub: base };
}

/** "3 of 3 Bearish" / "Split: 1 bullish · 1 bearish · 1 neutral" from the three OI views. */
export function votesText(views: ({ verdict: OiView['verdict'] } | null | undefined)[]): string {
  const vs = views.filter((v): v is { verdict: OiView['verdict'] } => !!v).map((v) => v.verdict);
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
export interface ChartPreset { interval: number | null; indicators: IndicatorToggles; emaPeriod: number; bb: { period: number; mult: number }; note: string;
  rsiGuides?: { price: number; side: 'put' | 'call'; title: string }[];
  warm?: number } // earlier sessions the chart loads so its indicators equal the rule's (default 2 = 4 sessions, SuperTrend Breakout) // the rule's own RSI levels (default: Trend zones 30-45 / 55-70)
const OFF: IndicatorToggles = { rsi: false, ema: false, volume: false, supertrend: false, bollinger: false, vwap: false, delta: false };
export const CHART_PRESETS: Record<ChartStrategy, ChartPreset> = {
  all: { interval: null, indicators: DEFAULT_INDICATORS, emaPeriod: 20, bb: { period: 20, mult: 2 }, note: 'Just the price. Pick a strategy for its lines.' },
  fourPillar: { interval: 5, indicators: { ...OFF, ema: true, vwap: true, rsi: true, delta: true }, emaPeriod: 20, bb: { period: 20, mult: 2 },
    note: 'EMA 20, VWAP, RSI 14, pivot and OI levels, cumulative delta. India VIX and PCR are on the strategy box.' },
  superTrend: { interval: 5, indicators: { ...OFF, supertrend: true, bollinger: true, rsi: true }, emaPeriod: 20, bb: { period: 20, mult: 2 },
    note: 'SuperTrend (10, 2), Bollinger (20, 2), RSI 14, pivot and OI levels.' },
  dharaniV2: { interval: 3, indicators: { ...OFF, supertrend: true, bollinger: true, ema: true, rsi: true }, emaPeriod: 200, bb: { period: 20, mult: 2.5 }, // the call's Bollinger (owner 30-Oct-2026: was 15, 3)
    rsiGuides: [{ price: 70, side: 'call', title: 'Call: above 70' }], // the put checks RSI 20 < 30 on the FUTURES, not this index RSI 14
    note: 'Call: SuperTrend, Bollinger (20, 2.5), RSI above 70, Pivot R1. Put checks run on futures (see checklist).' },
  tradingHub: { interval: 5, indicators: { ...OFF, supertrend: true, ema: true, vwap: true, bollinger: true, rsi: true, delta: true }, emaPeriod: 20,
    bb: { period: 20, mult: 2 }, note: 'SuperTrend, VWAP, EMA 20, Bollinger (20, 2), RSI 14, pivot. Trending OI is on the strategy box.' },
  reboundCall: { interval: 5, indicators: { ...OFF, ema: true, vwap: true }, emaPeriod: 200, bb: { period: 20, mult: 2 }, warm: 10, // the rule's 12 sessions
    note: 'EMA 200 and VWAP. Bank Nifty only.' },
  orbPullback: { interval: 5, indicators: { ...OFF }, emaPeriod: 20, bb: { period: 20, mult: 2 },
    note: 'Solid lines = the 9:15-9:29 box high and low.' },
  orbPullback5: { interval: 1, indicators: { ...OFF }, emaPeriod: 20, bb: { period: 20, mult: 2 },
    note: 'The 5-minute box (09:15-09:19 high / low) is the two solid lines; the break and the pullback are on the strategy box.' },
};

/** The Rs 10 lakh option SELLING book (owner 28-Oct-2026, sell_desk.py): NIFTY only, its own state at /api/selling/state. */
export interface SellLeg {
  id: string; slot: string; rule?: string; side: 'CE' | 'PE'; qty: number; entryPrice: number; netPnl?: number | null;
  instrument: { name: string; securityId?: number }; ltp?: number | null; pnl?: number | null;
  priceAt?: string | null; // set when ltp is the last saved price (after the close / a restart), IST ISO time
  stop?: number | null; entryDay?: string; entryTime?: string; exitTime?: string | null; exitPrice?: number | null;
  exitReason?: string | null; expiry?: string; status?: 'open' | 'closed';
}
export interface SellingState {
  open: SellLeg[]; closedToday: SellLeg[]; notes: Record<string, string>;
  capital?: number; realized?: number; unrealized?: number; equity?: number; enabled?: boolean; error?: string | null;
  cycle?: { pnl?: number; [k: string]: unknown } | null;
}
export const SELL_BOARD: { key: string; name: string; account: string; idle: string }[] = [
  { key: 'sellStraddle', name: 'Expiry Straddle (sell)', account: 'Selling · ₹10 lakh · Nifty only', idle: 'sells 09:20 on Nifty expiry days' },
  { key: 'sellCalmCall', name: 'Calm-day Call Sell', account: 'Selling · ₹10 lakh · Nifty only', idle: 'checks at 10:15 (calm days only)' },
  { key: 'sellStrangle', name: '2-month Strangle (sell)', account: 'Selling · ₹10 lakh · Nifty only', idle: 'enters at 10:00 when none is open' },
  { key: 'sellStraddle940', name: 'Expiry Straddle 9:40 (sell)', account: 'Selling · ₹10 lakh · Nifty only', idle: 'sells 09:40 on Nifty expiry days' },
  { key: 'sellStraddle1126', name: 'Expiry Straddle 11:26 (sell)', account: 'Selling · ₹10 lakh · Nifty only', idle: 'sells 11:26 on Nifty expiry days' },
  { key: 'sellStraddle1224', name: 'Expiry Straddle 12:24 (sell)', account: 'Selling · ₹10 lakh · Nifty only', idle: 'sells 12:24 on Nifty expiry days' },
];

/** One selling rule's box: sold legs and their P&L now, else today's result or note, else when it acts. */
export function sellCell(st: SellingState | null | undefined, key: string, ltp: Record<number, number> = {}, closed = false): Cell {
  const row = SELL_BOARD.find((b) => b.key === key);
  if (!st || !row) return { kind: 'none', title: 'No reading yet', sub: 'selling book not running' };
  const open = st.open.filter((l) => l.slot === key);
  if (open.length) {
    const pnl = open.reduce((s, l) => {
      const now = l.instrument.securityId != null ? ltp[l.instrument.securityId] : undefined;
      return s + (now != null ? (l.entryPrice - now) * l.qty : l.pnl ?? 0);
    }, 0);
    return { kind: 'trade', title: `Sold · ${open.length} leg${open.length > 1 ? 's' : ''}`,
      sub: `${open.map((l) => l.instrument.name.replace(/^NIFTY \S+ \S+ /, '')).join(' + ')} · ${money(pnl)} ${closed ? 'at close' : 'now'}` };
  }
  const done = st.closedToday.filter((l) => l.slot === key);
  if (done.length) return { kind: 'wait', title: 'Done today', sub: `${done.length} leg${done.length > 1 ? 's' : ''} · ${money(done.reduce((s, l) => s + (l.netPnl ?? 0), 0))}` };
  const note = st.notes[row.name];
  if (closed) return { kind: 'none', title: 'No trade today', sub: note || row.idle };
  return { kind: 'wait', title: 'Waiting', sub: note || row.idle };
}
