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

/** An open leg of an options strategy (backend options_service.positions): qty signed, long + / short −. */
export interface OptionPosition {
  security_id: number; name: string; symbol: string; expiry: string; strike: number; optionType: OptionType;
  lot_size: number; qty: number; lots: number; avg: number; ltp: number | null; realized: number; unrealized: number;
  settlementPending: boolean;
}
export interface OptionFunds { capital: number; realized: number; charges: number; premiumOpen: number; cash: number; blockedMargin: number; available: number }
export interface OptionBook {
  strategy: { id: number; name: string; kind: string };
  positions: OptionPosition[];
  funds: OptionFunds;
  unrealized: number;
  meta: { acceptingOrders: boolean; asOf: string; lastError: string };
}
export interface OptionFill { id: string; basketId: string; securityId: number; side: 'BUY' | 'SELL'; qty: number; price: number; value: number; charges: number; kind: string; realized: number }

/** Options strategies (backend options_api.py). PAPER ONLY. */
export const optionsApi = {
  positions: (strategyId: number, signal?: AbortSignal) =>
    requestJson<OptionBook>(BUILDER_API, `/api/options/positions?strategy=${strategyId}`, { signal }),
  basket: (strategyId: number, legs: { securityId: number; side: Side; lots: number }[]) =>
    requestJson<OptionBook & { fills: OptionFill[] }>(BUILDER_API, `/api/options/basket?strategy=${strategyId}`, { method: 'POST', body: { legs } }),
  exit: (strategyId: number, securityId?: number) =>
    requestJson<OptionBook & { fills: OptionFill[] }>(BUILDER_API, `/api/options/exit?strategy=${strategyId}`,
      { method: 'POST', body: securityId != null ? { securityId } : {} }),
};

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
