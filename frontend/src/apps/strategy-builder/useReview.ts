// What the Review card, the checks and the sticky summary bar need besides the design: your options strategies (the
// "Trading into:" pick and its capital), every open iron condor across them (check D), the check thresholds (per user)
// and the GO / SKIP checks themselves.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { illiquidReason } from '../../shared/dhan/liquidity';
import { optionStrategies, strategyApi, type Strategy } from '../../shared/strategy/api';
import { TEMPLATE_LIQUIDITY } from './config/settings';
import { builderApi, optionsApi } from './logic/api';
import { DEFAULT_THRESHOLDS, condorWings, openCondors, runChecks, type Checks, type OpenCondor, type Thresholds } from './logic/checks';
import type { Quote } from './logic/legs';
import type { Leg } from './logic/payoff';
import { strikeStep } from './logic/rules';
import { rememberedStrategy } from './PaperTradeDialog';

const PICK_KEY = 'builder.options.strategy';

/** Your options strategies and the one picked under "Trading into:" (shared with the Paper trade dialog). */
export function useOptionStrategies(refreshKey: unknown = 0) {
  const [list, setList] = useState<Strategy[] | null>(null);
  const [pick, setPickState] = useState<number | null>(rememberedStrategy);
  const [error, setError] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    strategyApi.list(false, ctrl.signal).then((all) => {
      const opts = optionStrategies(all);
      setList(opts);
      setPickState((p) => (p && opts.some((s) => s.id === p) ? p : opts[0]?.id ?? null));
      setError('');
    }).catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load your strategies.'); });
    return () => ctrl.abort();
  }, [refreshKey]);
  const setPick = useCallback((id: number) => {
    setPickState(id);
    try { localStorage.setItem(PICK_KEY, String(id)); } catch { /* not remembered */ }
  }, []);
  const picked = list?.find((s) => s.id === pick) ?? null;
  return { list, pick, picked, setPick, error };
}

/** Every open iron condor in every options strategy of yours (check D). null while loading. */
export function useOpenCondors(strategies: Strategy[] | null, refreshKey: unknown = 0) {
  const [rows, setRows] = useState<OpenCondor[] | null>(null);
  const ids = strategies?.map((s) => s.id).join(',') ?? '';
  useEffect(() => {
    if (!strategies) return;
    const ctrl = new AbortController();
    setRows(null);
    Promise.all(strategies.map((s) => optionsApi.positions(s.id, ctrl.signal).then((b) => openCondors(s.name, b.positions)).catch(() => [])))
      .then((all) => setRows(all.flat()))
      .catch(() => { if (!ctrl.signal.aborted) setRows([]); });
    return () => ctrl.abort();
  }, [ids, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}

/** The check thresholds (backend th_user_prefs), with a save. */
export function useThresholds() {
  const [th, setTh] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  useEffect(() => {
    const ctrl = new AbortController();
    builderApi.checks(ctrl.signal).then(setTh).catch(() => undefined);
    return () => ctrl.abort();
  }, []);
  const save = useCallback(async (v: Partial<Thresholds>) => setTh(await builderApi.saveChecks(v)), []);
  return { th, save };
}

const fmtK = (k: number) => k.toLocaleString('en-IN');

/** The checks for a priced design. condor: the template is an iron condor (else: the legs look like one). */
export function useChecks({ legs, rawQuote, spot, strikes, multiplier, nowMs, condor, capital, condors, th, marketOpen, minCreditPts }: {
  legs: Leg[]; rawQuote: (l: Leg) => Quote | null | undefined; spot: number | null; strikes: number[]; multiplier: number; nowMs: number;
  condor?: boolean; capital: number | null; condors: OpenCondor[] | null; th: Thresholds; marketOpen: boolean | null; minCreditPts?: number | null;
}): Checks | null {
  const key = JSON.stringify(legs);
  return useMemo(() => {
    const on = legs.filter((l) => l.include && l.lots > 0);
    if (!on.length || spot == null) return null;
    const illiquid = on.flatMap((l) => {
      const q = rawQuote(l);
      const why = illiquidReason(q && { oi: q.oi, volume: q.volume, bid: q.bid, ask: q.ask }, marketOpen, TEMPLATE_LIQUIDITY);
      return why ? [`${fmtK(l.strike)} ${l.type} ${why}`] : [];
    });
    return runChecks({ legs: on, spot, multiplier, nowMs, condor: condor ?? condorWings(on) != null, capital, openCondors: condors,
      illiquid, step: strikeStep(strikes, spot), minCreditPts }, th);
  }, [key, spot, strikes.length, multiplier, nowMs, condor, capital, condors, th, marketOpen, minCreditPts]); // eslint-disable-line react-hooks/exhaustive-deps
}
