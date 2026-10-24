// Pure helpers for the Algo page: trade rows for the end-of-day review, the decision-log filter, labels.
import { inr, signed } from '../../../shared/grid';
import type { Tone } from '../../../shared/ui';
import type { AlgoEvent, AlgoStatus, ClosedTrade, Slot } from './api';

export const LEVEL_ORDER: Slot[] = ['S3', 'S2', 'S1', 'R1', 'R2', 'R3'];

export interface TradeRow extends ClosedTrade {
  symbol: string;
}

/** Every closed trade of the day, both indices, in entry order. */
export function tradeRows(s: AlgoStatus | null): TradeRow[] {
  if (!s) return [];
  return s.indices
    .flatMap((i) => i.closed.map((t) => ({ ...t, symbol: i.symbol })))
    .sort((a, b) => a.entryAt.localeCompare(b.entryAt));
}

const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));

/** Plain text for checking the trades on the chart: one block per trade with times, prices and reasons. */
export function reviewText(rows: TradeRow[], date: string): string {
  if (!rows.length) return `Algo trades ${date}: none.`;
  const total = rows.reduce((t, r) => t + (r.pnl ?? 0), 0);
  const lines = [`Algo trades ${date} (paper): ${rows.length}, P&L ${signed(2)(total)}`];
  rows.forEach((r, i) => {
    lines.push(
      '',
      `${i + 1}. ${r.symbol} ${r.setup} · ${r.option ?? '-'}`,
      `   Entry ${r.entryAt} @ ${px(r.entryPrice)} (spot ${px(r.entrySpotLive ?? r.entrySpot)}) · Exit ${r.exitAt} @ ${px(r.exitPrice)} (spot ${px(r.exitSpot)}) · P&L ${r.pnl == null ? '–' : signed(2)(r.pnl)}`,
      `   Why entry: ${r.reason}`,
      `   Why exit: ${r.exitReason}`,
    );
  });
  return lines.join('\n');
}

export type LogFilter = 'all' | 'trades' | 'signals' | 'problems';

const IN: Record<LogFilter, (e: AlgoEvent) => boolean> = {
  all: (e) => e.type !== 'candle',
  trades: (e) => e.type === 'entry' || e.type === 'exit',
  signals: (e) => ['signal', 'skip', 'entry', 'exit', 'levels'].includes(e.type),
  problems: (e) => ['error', 'skip', 'feed'].includes(e.type),
};

/** Decision log rows for a filter, index ("" = both) and variant ("" = all; lines for both indices always show). */
export function filterEvents(rows: AlgoEvent[], filter: LogFilter, symbol: string, variant = ''): AlgoEvent[] {
  return rows.filter((e) => IN[filter](e))
    .filter((e) => !symbol || e.index === symbol || e.index === '*')
    .filter((e) => !variant || e.variant === variant || e.index === '*');
}

/** Tone of a log row's pill, by its fine-grained kind (armed, skip, entry, ...). */
export const KIND_TONE: Record<string, Tone> = {
  entry: 'accent', exit: 'accent', armed: 'up', skip: 'warn', cancel: 'neutral', expire: 'neutral', error: 'down',
  levels: 'neutral', info: 'neutral', candle: 'neutral', stale: 'warn', feed: 'warn', heartbeat: 'neutral',
};

export function stateTone(state: string): Tone {
  if (state === 'in trade') return 'accent';
  if (state === 'stopped') return 'down';
  if (state.includes('armed')) return 'up';
  return 'neutral';
}

/** "Live · data 3 s" style status for the toolbar dot. */
export function feedStatus(s: AlgoStatus | null, error: unknown): { kind: 'live' | 'stale' | 'error' | 'idle'; label: string } {
  if (error) return { kind: 'error', label: 'Backend not reachable' };
  if (!s) return { kind: 'idle', label: 'Loading…' };
  if (s.meta.mode === 'off') return { kind: 'idle', label: 'Algo off (ALGO_MODE=off)' };
  const h = s.meta.health;
  if (h?.state === 'error') return { kind: 'error', label: 'Error' };
  if (h?.state === 'stale') return { kind: 'stale', label: 'Stale' };
  if (s.meta.tokenExpired) return { kind: 'error', label: 'Dhan token expired: no new entries' };
  if (!s.meta.tradingDay) return { kind: 'idle', label: 'Not a trading day' };
  const ages = s.indices.map((i) => i.dataAgeSec).filter((a): a is number => a != null);
  if (!ages.length) return { kind: 'idle', label: 'Waiting for the first tick' };
  const worst = Math.max(...ages);
  return worst > 120 ? { kind: 'stale', label: `Data ${worst} s old` } : { kind: 'live', label: `Running · ${s.meta.asOf.slice(11, 19)}` };
}
