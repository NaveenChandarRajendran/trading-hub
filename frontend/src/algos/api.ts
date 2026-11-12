// The Algos hub API (backend algos_api.py): one shape for every algo.
import { API_BASE, requestJson } from '../shared/api';

export type AlgoState = 'running' | 'stopped' | 'stale' | 'closed' | 'off' | 'token' | 'error';

export interface AlgoSummary {
  slug: string;
  name?: string;
  category?: string;
  state: AlgoState;
  stateText: string;
  halted?: boolean;
  todayPnl?: number;
  mtdPnl?: number;
  open?: string | null;
  lastEvent?: { ts: string; text: string } | null;
}

export interface AlgoEvent { id: number; ts: string; type: string; side: string | null; scope: string; variant: string; setup: string; message: string }
export interface EventsPage {
  date: string; total: number; page: number; size: number; types: string[]; variants: string[]; scopes: string[];
  liveVariant: string; rows: AlgoEvent[];
}

export interface AlgoTrade {
  setup: string; side: string; instrument: string; lots: number | null;
  entryAt: string | null; entryPrice: number | null; exitAt: string | null; exitPrice: number | null;
  spotIn: number | null; spotOut: number | null; pnl: number | null; note: string;
}

export interface DayRow { date: string; realized: number; charges: number; net: number; trades: number; wins?: number; losses?: number }
export interface ReportTiles {
  net: number; charges: number; days: number; trades: number; wins: number; losses: number;
  winRate: number | null; avgWin: number | null; avgLoss: number | null;
  bestDay: { date: string; net: number } | null; worstDay: { date: string; net: number } | null;
}
export interface SetupResult { key: string; name: string; trades: number; wins: number; losses: number; points: number; net: number }
export interface AlgoReport { from: string; to: string; days: DayRow[]; tiles: ReportTiles; holidays: string[]; breakdown?: SetupResult[] }

export type FieldKind = 'number' | 'int' | 'time' | 'bool' | 'list' | 'text';
export type FieldValue = number | string | boolean | string[];
export interface SettingField {
  key: string; label: string; group: string; kind: FieldKind; value: FieldValue; default: FieldValue;
  min?: number; max?: number; choices?: (string | number)[]; readOnly?: boolean;
}
export interface SettingChange { ts: string; key: string; old: unknown; new: unknown; user: string }
export interface SettingsView { editable: boolean; fields: SettingField[]; history: SettingChange[]; note?: string }

const base = (slug: string) => `/api/algos/${encodeURIComponent(slug)}`;
const qs = (q: Record<string, string | number | undefined>) => {
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

export const hubApi = {
  list: (signal?: AbortSignal) => requestJson<{ rows: AlgoSummary[] }>(API_BASE, '/api/algos', { signal }),
  status: (slug: string, signal?: AbortSignal) => requestJson<AlgoSummary>(API_BASE, `${base(slug)}/status`, { signal }),
  events: (slug: string, q: { date?: string; type?: string; variant?: string; scope?: string; page?: number; size?: number }, signal?: AbortSignal) =>
    requestJson<EventsPage>(API_BASE, `${base(slug)}/events${qs(q)}`, { signal }),
  trades: (slug: string, date: string, signal?: AbortSignal) =>
    requestJson<{ date: string; rows: AlgoTrade[] }>(API_BASE, `${base(slug)}/trades${qs({ date })}`, { signal }),
  reports: (slug: string, from: string, to: string, signal?: AbortSignal) =>
    requestJson<AlgoReport>(API_BASE, `${base(slug)}/reports${qs({ from, to })}`, { signal }),
  settings: (slug: string, signal?: AbortSignal) => requestJson<SettingsView>(API_BASE, `${base(slug)}/settings`, { signal }),
  saveSettings: (slug: string, changes: Record<string, FieldValue>) =>
    requestJson<SettingsView>(API_BASE, `${base(slug)}/settings`, { method: 'PUT', body: changes }),
  overview: <T,>(slug: string, signal?: AbortSignal) => requestJson<T>(API_BASE, `${base(slug)}/overview`, { signal }),
  rules: (slug: string, signal?: AbortSignal) => requestJson<{ doc: string; markdown: string }>(API_BASE, `${base(slug)}/rules`, { signal }),
  kill: (slug: string, action: 'stop' | 'stop-exit-all' | 'resume') =>
    requestJson<AlgoSummary>(API_BASE, `${base(slug)}/${action}`, { method: 'POST' }),
};
