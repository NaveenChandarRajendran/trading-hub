// Today's trades with live prices, shared by the Today page and the strategy pages (owner 29-Oct-2026: each strategy
// page shows its own trades the same way). Data: GET /api/journal/trades (today, all accounts), /api/signals/state for
// both indices (rule trades, stops, Auto switch, spot + VIX), /ws/paper (live prices, manual positions). PAPER ONLY.
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, requestJson } from '../../shared/api';
import { errorText } from '../../shared/live/liveStatus';
import { useSignals } from '../dashboard/useSignals';
import { fetchTrades, type JTrade } from '../paper-journal/logic/journal';
import { api as paperApi } from '../paper-trade/logic/api';
import { keyOf } from '../paper-trade/logic/feed';
import { usePaper } from '../paper-trade/usePaper';
import { buildRows, type TodayRow } from './logic/today';

const REFRESH_MS = 10000;

export function useToday() {
  const paper = usePaper();
  const sigN = useSignals('NIFTY');
  const sigB = useSignals('BANKNIFTY');
  const [trades, setTrades] = useState<JTrade[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const today = paper.today;

  useEffect(() => {
    const ac = new AbortController();
    const load = async (signal?: AbortSignal) => {
      try {
        setTrades((await fetchTrades(today, today, signal)).rows);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(e);
      }
    };
    void load(ac.signal);
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), REFRESH_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [today, paper.tradeVersion, reloadKey]);

  // the auto part (accounts, today's rule trades, Auto switch) is the same in both states; either one will do
  const auto = sigN.data?.auto ?? sigB.data?.auto ?? null;
  const ctx = (sym: string) => [...(sigN.data?.context ?? []), ...(sigB.data?.context ?? [])].find((c) => c?.symbol === sym) ?? null;
  const spotN = ctx('NIFTY')?.spot ?? null;
  const spotB = ctx('BANKNIFTY')?.spot ?? null;
  const ticks = useMemo(() => {
    const m: Record<number, number> = {};
    for (const t of paper.ticks.values()) if (t.segment === 'NSE_FNO') m[t.securityId] = t.ltp;
    return m;
  }, [paper.ticks]);
  const rows = useMemo(
    () => buildRows(trades ?? [], auto?.today ?? [], [...paper.positions.values()], ticks, { NIFTY: spotN, BANKNIFTY: spotB }),
    [trades, auto, paper.positions, ticks, spotN, spotB],
  );

  // live prices for every open trade
  const openIds = rows.filter((r) => r.open && r.securityId != null).map((r) => r.securityId as number).sort((a, b) => a - b).join(',');
  const { subscribe } = paper;
  useEffect(() => {
    subscribe(openIds ? openIds.split(',').map((x) => keyOf('NSE_FNO', Number(x))) : []);
  }, [openIds, subscribe]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice(done);
      setReloadKey((k) => k + 1);
      sigN.reload();
      sigB.reload();
      return true;
    } catch (e) {
      setNotice(errorText(e));
      return false;
    } finally {
      setBusy(false);
      window.setTimeout(() => setNotice(''), 6000);
    }
  };
  const exitRow = (r: TodayRow) =>
    r.manual
      ? act(() => paperApi.exit(r.securityId as number), `Exit sent for ${r.option}`)
      : r.short // Selling book: buy the leg back
        ? act(() => requestJson(API_BASE, `/api/selling/exit/${encodeURIComponent(r.id)}`, { method: 'POST' }), `Buy-back sent for ${r.option}`)
        : act(() => sigN.exitTrade(r.id), `Exit sent for ${r.option}`);
  /** Stop + target on a hand-bought option, as option prices (owner 29-Oct-2026: shown and editable before placing). */
  const placeBracket = (r: TodayRow, stop: number, target: number) =>
    act(() => requestJson(API_BASE, '/api/autopaper/bracket', { method: 'POST', body: { securityId: r.securityId, stopPrice: stop, targetPrice: target } }),
      `Stop ${stop.toFixed(2)} and target ${target.toFixed(2)} placed on ${r.option}`);

  const marketOpen = paper.meta?.marketOpen ?? sigN.data?.meta.marketOpen ?? false;
  return {
    paper, sigN, sigB, auto, rows, trades, error, busy, notice, today, marketOpen, act, exitRow, placeBracket,
    loading: trades == null && error == null,
    context: { NIFTY: ctx('NIFTY'), BANKNIFTY: ctx('BANKNIFTY') },
    bracketDefaults: { stopPct: 10, targetPct: 20 }, // owner 29-Oct-2026: option buying stop −10 % / target +20 %
  };
}

export type TodayData = ReturnType<typeof useToday>;
