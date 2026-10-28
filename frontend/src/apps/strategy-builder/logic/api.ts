// Strategy Builder REST calls (backend/builder_api.py). Designs only: nothing here places an order.
import { requestJson } from '../../../shared/api';
import { BUILDER_API } from '../config/settings';
import type { OptionType } from './blackScholes';
import type { Side } from './payoff';

export interface DraftLeg { side: Side; type: OptionType; expiry: string; strike: number; lots: number; include: boolean; priceOverride: number | null }
export interface Draft { id: number; name: string; symbol: string; multiplier: number; legs: DraftLeg[]; createdAt: string; updatedAt: string }
export interface Margin { total: number; span: number | null; exposure: number | null; hedgeBenefit: number | null; cached: boolean }
export interface PositionLeg {
  securityId: number; name: string; symbol: string; expiry: string; strike: number; type: OptionType; side: Side;
  lots: number; lotSize: number; price: number;
}

export const builderApi = {
  drafts: (signal?: AbortSignal) => requestJson<{ drafts: Draft[] }>(BUILDER_API, '/api/builder/drafts', { signal }).then((r) => r.drafts),
  saveDraft: (body: { name: string; symbol: string; multiplier: number; legs: DraftLeg[] }) =>
    requestJson<{ draft: Draft }>(BUILDER_API, '/api/builder/drafts', { method: 'POST', body }).then((r) => r.draft),
  updateDraft: (id: number, body: Partial<{ name: string; symbol: string; multiplier: number; legs: DraftLeg[] }>) =>
    requestJson<{ draft: Draft }>(BUILDER_API, `/api/builder/drafts/${id}`, { method: 'PUT', body }).then((r) => r.draft),
  deleteDraft: (id: number) => requestJson<{ ok: boolean }>(BUILDER_API, `/api/builder/drafts/${id}`, { method: 'DELETE' }),
  margin: (legs: { securityId: number; side: Side; qty: number; price: number }[], signal?: AbortSignal) =>
    requestJson<Margin>(BUILDER_API, '/api/builder/margin', { method: 'POST', body: { legs }, signal }),
  positions: (strategyId: number) =>
    requestJson<{ strategy: { id: number; name: string }; legs: PositionLeg[] }>(BUILDER_API, `/api/builder/positions?strategy=${strategyId}`),
};
