// Growth Plans REST calls (backend growth_plans_api.py). The signed-in user's own plans only.
import { API_BASE, requestJson } from '../../../shared/api';
import type { DayNet, Flow } from './tracker';
import type { Method } from './plan';

export interface Plan {
  id: number;
  name: string;
  yearlyPct: number;
  method: Method;
  initialCapital: number;
  startMonth: string; // 'YYYY-MM'
  years: number;
  createdAt: string;
  archivedAt: string | null;
  appliedTo?: { id: number; name: string }[]; // strategies using it now
  usedBefore?: { id: number; name: string }[]; // strategies that used it earlier
}
export interface Mapping { id: number; strategyId: number; planId: number; initialCapital: number; appliedAt: string; endedAt: string | null }
export interface TrackerData {
  strategy: { id: number; name: string; capital: number; kind: 'manual' | 'algo' };
  plan: Plan | null;
  mapping: Mapping | null;
  history: (Mapping & { planName: string })[];
  days: DayNet[];
  flows: (Flow & { kind: 'set' | 'reset' })[];
  unrealized: number;
  today: string;
}
export type NewPlan = Pick<Plan, 'name' | 'yearlyPct' | 'method' | 'initialCapital' | 'startMonth' | 'years'>;

export const planApi = {
  list: (archived = false, signal?: AbortSignal) =>
    requestJson<{ plans: Plan[] }>(API_BASE, `/api/plans?archived=${archived}`, { signal }).then((r) => r.plans),
  create: (body: NewPlan) => requestJson<{ plan: Plan }>(API_BASE, '/api/plans', { method: 'POST', body }).then((r) => r.plan),
  edit: (id: number, body: Partial<NewPlan>) =>
    requestJson<{ plan: Plan }>(API_BASE, `/api/plans/${id}`, { method: 'PATCH', body }).then((r) => r.plan),
  delete: (id: number) => requestJson<{ ok: boolean }>(API_BASE, `/api/plans/${id}`, { method: 'DELETE' }),
  archive: (id: number) => requestJson<{ plan: Plan }>(API_BASE, `/api/plans/${id}/archive`, { method: 'POST' }),
  apply: (strategyId: number, planId: number, initialCapital?: number) =>
    requestJson<{ mapping: Mapping }>(API_BASE, `/api/strategies/${strategyId}/plan`, { method: 'POST', body: { planId, initialCapital } }),
  remove: (strategyId: number) => requestJson(API_BASE, `/api/strategies/${strategyId}/plan`, { method: 'DELETE' }),
  tracker: (strategyId: number, signal?: AbortSignal) =>
    requestJson<TrackerData>(API_BASE, `/api/strategies/${strategyId}/plan`, { signal }),
};
