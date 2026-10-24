// Pure helpers for the Algo Reports view: presets, tiles, CSV files, the end-of-day comparison.
import { toCsv } from '../../../shared/csv';
import { inr, signed } from '../../../shared/grid';
import type { Tone } from '../../../shared/ui';
import type { AlgoEvent, CandleRow, ComparisonRow, RangeReport, SummaryRow } from './api';

export const PRESETS = [
  { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' }, { value: 'custom', label: 'Custom' },
] as const;
export type Preset = (typeof PRESETS)[number]['value'];

const tone = (v: number | null | undefined): Tone | undefined => (!v ? undefined : v > 0 ? 'up' : 'down');
const money = (v: number | null | undefined) =>  // "+₹1,250.50", as on the paper trading pages
  (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${inr(2)(Math.abs(v))}`);
const pts = (v: number | null | undefined) => (v == null ? '–' : `${signed(2)(v)} pts`);

export interface Tile { label: string; value: string; delta?: string; tone?: Tone }

/** The summary tiles of a range: rupees for the live variant (paper P&L), points for a shadow. */
export function tiles(r: RangeReport): Tile[] {
  const t = r.tiles;
  const live = t.unit === 'rupees';
  const val = live ? money : pts;
  const day = (d: [string, number] | null) => (d ? { value: val(d[1]), delta: d[0] } : { value: '–', delta: '' });
  const best = day(t.bestDay);
  const worst = day(t.worstDay);
  return [
    live ? { label: 'Net P&L', value: money(t.netPnl), delta: `${pts(t.points)} index`, tone: tone(t.netPnl) }
      : { label: 'Points (would-be)', value: pts(t.points), delta: 'shadow: no orders', tone: tone(t.points) },
    { label: 'Trades', value: String(t.trades), delta: `${t.wins} won · ${t.losses} lost` },
    { label: 'Win rate', value: t.winRate == null ? '–' : `${inr(1)(t.winRate)}%` },
    { label: 'Average win', value: val(t.avgWin), tone: tone(t.avgWin) },
    { label: 'Average loss', value: val(t.avgLoss), tone: tone(t.avgLoss) },
    { label: 'Best day', value: best.value, delta: best.delta, tone: tone(t.bestDay?.[1]) },
    { label: 'Worst day', value: worst.value, delta: worst.delta, tone: tone(t.worstDay?.[1]) },
  ];
}

/** Day-wise table as CSV (numbers raw). */
export function daysCsv(rows: SummaryRow[]): string {
  return toCsv(['Date', 'Variant', 'Live', 'Signals', 'Entries', 'Wins', 'Losses', 'Points', 'Gross P&L', 'Charges', 'Net P&L'],
    rows.map((r) => [r.trade_date, r.variant, r.is_live ? 'yes' : 'no', r.signals, r.entries, r.wins, r.losses, r.points,
      r.gross_pnl ?? '', r.charges ?? '', r.net_pnl ?? '']));
}

/** One day's decision log as CSV, oldest first (time, index, variant, type, setup, message). */
export function eventsCsv(events: AlgoEvent[]): string {
  const rows = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  return toCsv(['Time', 'Index', 'Variant', 'Type', 'Kind', 'Setup', 'Message'],
    rows.map((e) => [e.ts.slice(11, 19), e.index === '*' ? 'ALL' : e.index, e.variant, e.type, e.kind, e.setup, e.message]));
}

/** One day's candles with the filter values, as CSV. */
export function candlesCsv(rows: CandleRow[]): string {
  return toCsv(['Index', 'Start', 'Open', 'High', 'Low', 'Close', 'RSI', 'Trending OI %', 'Trending OI', 'OI change',
    'OI change pts', 'Components', 'Components %'],
  rows.map((c) => [c.index, c.candle_start.slice(11, 16), c.open, c.high, c.low, c.close, c.rsi ?? '', c.toi_strength ?? '',
    c.toi_sentiment ?? '', c.oi_change ?? '', c.oi_change_points ?? '', c.components ?? '', c.components_move ?? '']));
}

/** The comparison rows A-D in order, the live variant flagged. */
export function comparisonRows(rows: ComparisonRow[]): ComparisonRow[] {
  return [...rows].sort((a, b) => a.variant.localeCompare(b.variant));
}

/** The end-of-day comparison card shows once the daily summary time (15:35) has passed. */
export function showEod(asOf: string | undefined, summaryAt: string | undefined): boolean {
  return !!asOf && !!summaryAt && asOf.slice(11, 16) >= summaryAt;
}
