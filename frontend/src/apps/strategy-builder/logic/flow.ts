// The guided flow's state (pure reducer): Choose → Adjust → Review. Back / Next keep everything set so far; picking
// another template resets its numbers to that template's defaults, a new index or expiry keeps them.
import { itemById } from './catalog';

export type Step = 1 | 2 | 3;
export interface FlowState {
  step: Step;
  itemId: string | null;
  symbol: string;
  expiry: string;
  params: Record<string, number>;
}

export type FlowAction =
  | { type: 'pick'; itemId: string }
  | { type: 'symbol'; symbol: string }
  | { type: 'expiry'; expiry: string }
  | { type: 'param'; key: string; value: number }
  | { type: 'next' } | { type: 'back' } | { type: 'goto'; step: Step };

export const startFlow = (itemId: string | null, symbol: string, expiry: string): FlowState =>
  ({ step: 1, itemId, symbol, expiry, params: itemId ? { ...(itemById(itemId)?.defaults ?? {}) } : {} });

/** Step 1 is complete with a template and an expiry. */
export const canNext = (s: FlowState) => (s.step === 1 ? !!s.itemId && !!s.expiry : s.step < 3);

export function flowReducer(s: FlowState, a: FlowAction): FlowState {
  switch (a.type) {
    case 'pick': return a.itemId === s.itemId ? s : { ...s, itemId: a.itemId, params: { ...(itemById(a.itemId)?.defaults ?? {}) } };
    case 'symbol': return { ...s, symbol: a.symbol, expiry: '' };
    case 'expiry': return { ...s, expiry: a.expiry };
    case 'param': return { ...s, params: { ...s.params, [a.key]: a.value } };
    case 'next': return canNext(s) ? { ...s, step: (s.step + 1) as Step } : s;
    case 'back': return s.step > 1 ? { ...s, step: (s.step - 1) as Step } : s;
    case 'goto': return a.step <= s.step || (a.step === s.step + 1 && canNext(s)) ? { ...s, step: a.step } : s;
  }
}
