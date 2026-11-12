// Trending OI Algo page helpers (pure): the status line, the direction pill, the decision-log filter, settings groups.
import type { Tone } from '../../../shared/ui';
import type { Direction, LogRow, Settings, ToiStatus } from './api';

export type RunState = 'Running' | 'Stopped' | 'Stale' | 'Market closed' | 'Off' | 'Token expired' | 'Loading';

/** Running / Stopped (kill switch) / Stale (no index tick) / Market closed / Off / Token expired. */
export function runState(s: ToiStatus | null): RunState {
  if (!s) return 'Loading';
  if (s.meta.mode === 'off') return 'Off';
  if (s.meta.tokenExpired) return 'Token expired';
  if (!s.meta.marketOpen) return 'Market closed';
  if (s.meta.halted) return 'Stopped';
  if (s.meta.stale) return 'Stale';
  return 'Running';
}

export const RUN_KIND: Record<RunState, 'live' | 'stale' | 'error' | 'idle'> = {
  Running: 'live', Stopped: 'stale', Stale: 'stale', 'Market closed': 'idle', Off: 'idle', 'Token expired': 'error', Loading: 'idle',
};

/** "Bullish 64.0% ●●●" style pieces; the verdict when no direction yet. */
export function directionText(d: Direction | null): { text: string; dots: string; tone: Tone } {
  if (!d || d.sentiment == null || d.strength == null) return { text: 'No Trending OI yet', dots: '', tone: 'neutral' };
  const dots = '●'.repeat(d.dots) + '○'.repeat(Math.max(0, 3 - d.dots));
  const tone: Tone = d.side == null ? 'neutral' : d.side === 'CE' ? 'up' : 'down';
  return { text: `${d.sentiment} ${Math.abs(d.strength).toFixed(1)}%${d.side ? ` → ${d.side} only` : ''}`, dots, tone };
}

export const TYPE_TONE: Record<string, Tone> = {
  entry: 'accent', add: 'accent', partial: 'up', exit: 'accent', stopMove: 'up', skip: 'warn', noTrade: 'warn', clear: 'up',
  error: 'down', feed: 'warn', settings: 'neutral', levels: 'neutral', info: 'neutral', heartbeat: 'neutral',
};

export type LogFilter = 'all' | 'decisions' | 'trades' | 'problems';
const DECISIONS = new Set(['noTrade', 'clear', 'skip', 'entry', 'add', 'partial', 'stopMove', 'exit']);
const TRADES = new Set(['entry', 'add', 'partial', 'stopMove', 'exit']);
const PROBLEMS = new Set(['skip', 'error', 'feed', 'noTrade']);

export function filterLog(rows: LogRow[], f: LogFilter): LogRow[] {
  if (f === 'all') return rows;
  const set = f === 'decisions' ? DECISIONS : f === 'trades' ? TRADES : PROBLEMS;
  return rows.filter((r) => set.has(r.type) || (f === 'trades' && r.type === 'info' && /filled|closed/i.test(r.message)));
}

/** Settings shown in groups on the page, with a short label each (keys = trending_oi_algo_config.DEFAULTS). */
export const SETTING_GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: 'Direction & no-trade', keys: [['toiStrengthMin', 'Trending OI strength min %'], ['toiDotsMin', 'Strength dots min'],
    ['flipLookbackMin', 'No trade after a flip (min)'], ['weakDayFrom', 'Weak-day check from'], ['weakDayRangePct', 'Weak day: range below %'],
    ['maxVwapDistPct', 'Over-extended: from VWAP %'], ['rsiMaxCE', 'RSI max for CE'], ['rsiMinPE', 'RSI min for PE']] },
  { title: 'Entry & stop', keys: [['touchPts', 'Pullback within (pts)'], ['entryLots', 'Entry lots'], ['maxStopPct', 'Skip when stop beyond %'],
    ['entryFrom', 'Entries from'], ['entryTo', 'Entries until'], ['maxTrades', 'Trades per day'], ['dayLossStopPct', 'Day loss stop % of capital']] },
  { title: 'Adds', keys: [['avgAddLots', 'Averaging adds (lots)'], ['avgMaxLots', 'Averaging up to (lots)'], ['pyrAddLots', 'Pyramiding adds (lots)'],
    ['pyrMaxLots', 'Pyramiding up to (lots)'], ['maxLots', 'Never more than (lots)'], ['addRiskMax', 'Risk guard (₹)'], ['deltaFallback', 'Delta without chain data']] },
  { title: 'Exits & indicators', keys: [['partialMinPts', 'Partial level at least (pts)'], ['breakevenAtR', 'Breakeven at (R) without levels'],
    ['squareOff', 'Square-off'], ['supertrendPeriod', 'Supertrend period'], ['supertrendMult', 'Supertrend factor'], ['rsiPeriod', 'RSI period']] },
];

/** The settings changed in a form: typed like their defaults ('' = back to the default). */
export function changedSettings(form: Record<string, string>, current: Settings, defaults: Settings): Settings {
  const out: Settings = {};
  for (const [k, raw] of Object.entries(form)) {
    const d = defaults[k];
    if (Array.isArray(d)) continue;
    const v = raw.trim() === '' ? d : typeof d === 'number' ? Number(raw) : raw.trim();
    if (v !== current[k] && !(typeof v === 'number' && Number.isNaN(v))) out[k] = v;
  }
  return out;
}
