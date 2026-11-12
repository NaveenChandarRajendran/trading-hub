// Pure helpers of the Algos hub template: date presets, safe Markdown, CSV files, setting parsing, status tones.
import { Marked, Renderer } from 'marked';
import { toCsv } from '../../shared/csv';
import type { AlgoEvent, AlgoState, AlgoTrade, DayRow, FieldKind, FieldValue } from '../api';

// ------------------------------------------------------------------ dates (IST 'YYYY-MM-DD' strings, UTC arithmetic)
const DAY_MS = 86400000;
const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const REPORT_PRESETS = [
  { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'lastMonth', label: 'Last month' },
  { value: 'fy', label: 'This FY' }, { value: 'custom', label: 'Custom' },
] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number]['value'];

/** from..to of a preset ending today (custom returns null: the user picks both dates). */
export function presetRange(p: ReportPreset, today: string): { from: string; to: string } | null {
  const y = +today.slice(0, 4), m = +today.slice(5, 7);
  if (p === 'week') {
    const back = (new Date(toMs(today)).getUTCDay() + 6) % 7; // to Monday
    return { from: toDay(toMs(today) - back * DAY_MS), to: today };
  }
  if (p === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (p === 'lastMonth') {
    const first = Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1);
    return { from: toDay(first), to: toDay(Date.UTC(y, m - 1, 1) - DAY_MS) };
  }
  if (p === 'fy') return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today };
  return null;
}

// ------------------------------------------------------------------ safe Markdown (rules docs)
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Only http(s), mailto, in-page anchors and relative paths; anything else (javascript:, data:, vbscript:) is dropped. */
export function safeHref(href: string | null | undefined): string | null {
  const h = (href ?? '').trim();
  if (!h) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h.replace(/[\u0000-\u001f\s]/g, ''));
  if (scheme && !['http', 'https', 'mailto'].includes(scheme[1].toLowerCase())) return null;
  return h;
}

const renderer = new Renderer();
renderer.html = (html: string) => escapeHtml(html); // raw HTML in a doc is shown as text, never run
renderer.link = (href: string, title: string | null | undefined, text: string) => {
  const h = safeHref(href);
  if (h === null) return text;
  const ext = /^https?:/i.test(h);
  return `<a href="${escapeHtml(h)}"${title ? ` title="${escapeHtml(title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
};
renderer.image = (_href: string, _title: string | null, text: string) => escapeHtml(text || ''); // no remote images
const md = new Marked({ renderer, gfm: true, breaks: false, async: false });

/** Markdown -> HTML with raw HTML escaped and unsafe links removed. */
export const renderMarkdown = (source: string) => md.parse(source) as string;

// ------------------------------------------------------------------ status, money
export const STATE_DOT: Record<AlgoState, 'live' | 'stale' | 'error' | 'idle'> = {
  running: 'live', stopped: 'stale', stale: 'stale', closed: 'idle', off: 'idle', token: 'error', error: 'error',
};

export const money = (v: number | null | undefined) =>
  v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const toneOf = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');
export const hhmm = (ts: string) => (ts.length >= 16 ? ts.slice(11, 16) : ts);
export const hhmmss = (ts: string) => (ts.length >= 19 ? ts.slice(11, 19) : ts);

// ------------------------------------------------------------------ CSV
export const daysCsv = (days: DayRow[]) =>
  toCsv(['date', 'trades', 'wins', 'losses', 'realized', 'charges', 'net'],
    days.map((d) => [d.date, d.trades, d.wins ?? '', d.losses ?? '', d.realized, d.charges, d.net]));
export const eventsCsv = (rows: AlgoEvent[]) =>
  toCsv(['time', 'type', 'side', 'variant', 'setup', 'message'], rows.map((e) => [e.ts, e.type, e.side ?? '', e.variant, e.setup, e.message]));
export const tradesCsv = (rows: AlgoTrade[]) =>
  toCsv(['setup', 'side', 'instrument', 'lots', 'entry_at', 'entry_price', 'exit_at', 'exit_price', 'spot_in', 'spot_out', 'pnl', 'note'],
    rows.map((t) => [t.setup, t.side, t.instrument, t.lots, t.entryAt, t.entryPrice, t.exitAt, t.exitPrice, t.spotIn, t.spotOut, t.pnl, t.note]));

// ------------------------------------------------------------------ settings
export const showValue = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v == null ? '–' : String(v));

/** Text from an input -> the value for the API, or an error message (the backend validates again). */
export function parseField(kind: FieldKind, text: string): { value: FieldValue } | { error: string } {
  const t = text.trim();
  if (kind === 'list') {
    const items = t.split(',').map((s) => s.trim()).filter(Boolean);
    return { value: items };
  }
  if (kind === 'time') {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? { value: t } : { error: 'a time like 09:45' };
  }
  if (t === '' || !Number.isFinite(Number(t))) return { error: 'a number' };
  const n = Number(t);
  if (n < 0) return { error: 'a number 0 or more' };
  if (kind === 'int' && !Number.isInteger(n)) return { error: 'a whole number' };
  return { value: n };
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
