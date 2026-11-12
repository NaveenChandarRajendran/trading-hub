import { describe, expect, it } from 'vitest';
import { canNext, flowReducer, startFlow, type FlowAction, type FlowState } from './flow';

const run = (s: FlowState, ...actions: FlowAction[]) => actions.reduce(flowReducer, s);

describe('guided flow', () => {
  it('keeps every choice through Back / Next', () => {
    let s = startFlow('iron-condor-a', 'NIFTY', '2026-11-17');
    expect(s.params).toEqual({ shortPutPct: -3.73, shortCallPct: 4.31, wingPct: 1.1, minCreditPct: 0.053, lots: 1 });
    s = run(s, { type: 'next' }, { type: 'param', key: 'lots', value: 3 }, { type: 'param', key: 'wingPct', value: 1.5 }, { type: 'next' });
    expect(s.step).toBe(3);
    s = run(s, { type: 'back' }, { type: 'back' });
    expect(s.step).toBe(1);
    expect(s.params.lots).toBe(3);
    s = run(s, { type: 'expiry', expiry: '2026-11-24' }, { type: 'next' });
    expect([s.step, s.params.lots, s.params.wingPct, s.expiry]).toEqual([2, 3, 1.5, '2026-11-24']);
  });
  it('another template starts from its own numbers; the same one keeps them', () => {
    let s = run(startFlow('iron-condor-a', 'NIFTY', '2026-11-17'), { type: 'param', key: 'lots', value: 2 });
    s = flowReducer(s, { type: 'pick', itemId: 'iron-condor-a' });
    expect(s.params.lots).toBe(2);
    s = flowReducer(s, { type: 'pick', itemId: 'ic-monthly-delta' });
    expect(s.params).toEqual({ deltaTarget: 0.32, deltaMin: 0.30, deltaMax: 0.35, wingPct: 2.5, targetPct: 50, timeExitDays: 8, lots: 1 });
  });
  it('Next needs a template and an expiry; the stepper only jumps back or one ahead', () => {
    const empty = startFlow(null, 'NIFTY', '2026-11-17');
    expect(canNext(empty)).toBe(false);
    expect(flowReducer(empty, { type: 'next' }).step).toBe(1);
    const noExpiry = run(startFlow('iron-condor', 'NIFTY', '2026-11-17'), { type: 'symbol', symbol: 'SENSEX' });
    expect(noExpiry.expiry).toBe('');
    expect(flowReducer(noExpiry, { type: 'next' }).step).toBe(1);
    const s = startFlow('iron-condor', 'NIFTY', '2026-11-17');
    expect(flowReducer(s, { type: 'goto', step: 3 }).step).toBe(1);
    expect(run(s, { type: 'goto', step: 2 }, { type: 'goto', step: 3 }, { type: 'goto', step: 1 }).step).toBe(1);
  });
});
