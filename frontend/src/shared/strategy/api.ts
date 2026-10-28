// The signed-in user's strategies (backend strategies_api.py). Someone else's strategy is a 404 from the backend.
import { API_BASE, requestJson } from '../api';

export type StrategyKind = 'manual' | 'algo' | 'options'; // options: Strategy Builder baskets held to expiry (ADR 0010)
export type Tool = 'paper' | 'scalper';

export interface Strategy {
  id: number;
  name: string;
  description: string;
  notes: string;
  capital: number;
  kind: StrategyKind;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface StrategyNumbers { id: number; booked: number; unbooked: number; total: number; open: number; lastDay: string | null }

const one = (r: { strategy: Strategy }) => r.strategy;

export const strategyApi = {
  list: (archived = false, signal?: AbortSignal) =>
    requestJson<{ strategies: Strategy[] }>(API_BASE, `/api/strategies?archived=${archived}`, { signal }).then((r) => r.strategies),
  summary: (archived = false, signal?: AbortSignal) =>
    requestJson<{ rows: StrategyNumbers[] }>(API_BASE, `/api/strategies/summary?archived=${archived}`, { signal }).then((r) => r.rows),
  create: (name: string, capital?: number, description = '', kind: 'manual' | 'options' = 'manual') =>
    requestJson<{ strategy: Strategy }>(API_BASE, '/api/strategies', { method: 'POST', body: { name, capital, description, kind } }).then(one),
  edit: (id: number, body: Partial<Pick<Strategy, 'name' | 'description' | 'notes'>>) =>
    requestJson<{ strategy: Strategy }>(API_BASE, `/api/strategies/${id}`, { method: 'PATCH', body }).then(one),
  archive: (id: number) => requestJson<{ strategy: Strategy }>(API_BASE, `/api/strategies/${id}/archive`, { method: 'POST' }).then(one),
  unarchive: (id: number) => requestJson<{ strategy: Strategy }>(API_BASE, `/api/strategies/${id}/unarchive`, { method: 'POST' }).then(one),
  pick: (tool: Tool, signal?: AbortSignal) =>
    requestJson<{ strategyId: number | null }>(API_BASE, `/api/strategies/pick?tool=${tool}`, { signal }).then((r) => r.strategyId),
  setPick: (tool: Tool, strategyId: number) =>
    requestJson<{ strategyId: number }>(API_BASE, '/api/strategies/pick', { method: 'PUT', body: { tool, strategyId } }),
};

/** Strategies a tool can trade into: active manual ones, by name. */
export const tradable = (list: Strategy[]) =>
  list.filter((s) => s.kind === 'manual' && !s.archivedAt).sort((a, b) => a.name.localeCompare(b.name));

/** The kind as a tag / word: MANUAL (Paper Trading, Power Scalper), ALGO (the OI breakout algo), OPTIONS (Strategy
 *  Builder baskets held to expiry, ADR 0010). */
export const KIND_INFO: Record<StrategyKind, { tag: string; word: string; tone: 'accent' | 'neutral' | 'warn' }> = {
  manual: { tag: 'MANUAL', word: 'Manual', tone: 'neutral' },
  algo: { tag: 'ALGO', word: 'Algo', tone: 'accent' },
  options: { tag: 'OPTIONS', word: 'Options', tone: 'warn' },
};

/** Strategies the Strategy Builder can paper trade into: active options ones, by name. */
export const optionStrategies = (list: Strategy[]) =>
  list.filter((s) => s.kind === 'options' && !s.archivedAt).sort((a, b) => a.name.localeCompare(b.name));

/** ?strategy=<id> appended to a backend path (keeps an existing query string). */
export const withStrategy = (path: string, id: number | null) =>
  id == null ? path : `${path}${path.includes('?') ? '&' : '?'}strategy=${id}`;
