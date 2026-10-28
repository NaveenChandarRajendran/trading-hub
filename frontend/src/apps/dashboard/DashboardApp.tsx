// Dashboard (landing page), redesigned with the owner 26-Oct-2026 for live-market use:
// status strip (index tabs, spots, day P&L) → strategy board (4 strategies × Nifty / Bank Nifty) → the charts (split
// Nifty | Bank Nifty, or one index; only the selected strategy's indicators, its trades marked) → paper accounts and
// today's trades → "Market context" (day levels, Trending OI, OI views, OI levels, order flow; collapsed) → snapshot bar.
// Charts and candles: useDashboard per index; rule boxes, OI and paper data: useSignals per index (GET /api/signals/state).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { copyText } from '../../shared/clipboard';
import { nseDate } from '../../shared/dhan/chainAdapter';
import { inr, signed } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, CopyValue, Pill, Segmented, Status } from '../../shared/ui';
import { hm } from '../oi-support-resistance/OsrResult';
import { levelsText } from '../oi-support-resistance/logic/levels';
import { BB_PERIOD, DEFAULT_INDICATORS, EMA_PERIOD, LEVELS_REFRESH_SEC, REFRESH_OPTIONS, RSI_PERIOD, SR_RANGE, ST_FACTOR, ST_PERIOD, STORAGE_PREFIX, type IndicatorToggles } from './config/settings';
import { componentsCard } from './logic/cards';
import { srLevels } from './logic/levels';
import { CHART_PRESETS, type ChartStrategy, type SellingState, type StrategyKey } from './logic/board';
import { API_BASE, getJson } from '../../shared/api';
import { minutesToExit, type SignalsState } from './logic/signals';
import constituents from '../components/config/constituents.json';
import type { Constituent } from '../components/logic/components';
import { ChartPanel, INDEX_NAME, strategyName } from './ChartPanel';
import {
  AccountCard, AutoSwitch, DayLevels, manualPnl, OiViewsCard, OrderFlowCard, SnapshotBar, SrCard, TrendingOiCard,
} from './SignalPanels';
import { StrategyBoard } from './StrategyBoard';
import { useDashboard, type Dashboard } from './useDashboard';
import { useSignals } from './useSignals';
import './dashboard.css';

const INDICATORS = [
  ['supertrend', `SuperTrend ${ST_PERIOD},${ST_FACTOR}`], ['bollinger', `Bollinger ${BB_PERIOD}`], ['ema', `EMA ${EMA_PERIOD}`],
  ['vwap', 'VWAP'], ['volume', 'Volume'], ['rsi', `RSI ${RSI_PERIOD}`], ['delta', 'Cum. delta (est.)'],
] as const;
const LEVEL_ORDER = [['S', 0], ['S', 1], ['S', 2], ['R', 0], ['R', 1], ['R', 2]] as const;
const SYMS = ['NIFTY', 'BANKNIFTY'] as const;
type Tab = 'both' | 'NIFTY' | 'BANKNIFTY';
const TABS = [{ value: 'both', label: 'Both' }, { value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
const refreshLabel = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const clock = (d: Date) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

const read = (k: string) => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + k, v);
  } catch {
    /* storage blocked: the choice just isn't remembered */
  }
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Indicator toggles of the plain chart (remembered per browser). Owner 27-Oct-2026: the plain chart starts as candles
 * only; a strategy brings its own indicators, levels and trades. */
const PLAIN: IndicatorToggles = { rsi: false, ema: false, volume: false, supertrend: false, bollinger: false, vwap: false, delta: false };
export function useToggles() {
  const [indicators, set] = useState<IndicatorToggles>(() => {
    try {
      return { ...PLAIN, ...JSON.parse(read('plainIndicators') ?? '{}') };
    } catch {
      return PLAIN;
    }
  });
  const toggle = (k: keyof IndicatorToggles) => set((p) => {
    const next = { ...p, [k]: !p[k] };
    write('plainIndicators', JSON.stringify(next));
    return next;
  });
  return { indicators, toggle };
}

/** Option security IDs whose live premium is needed: open auto trades on the index + hand-placed positions. */
function useOptionIds(s: SignalsState | null, symbol: string, withManual: boolean) {
  const [ids, setIds] = useState<number[]>([]);
  const wanted = useMemo(() => [
    ...(s?.auto?.open ?? []).filter((t) => t.symbol === symbol && typeof t.instrument.id === 'number').map((t) => t.instrument.id as number),
    ...(withManual ? (s?.paperPositions ?? []).map((p) => p.security_id) : []),
  ], [s, symbol, withManual]);
  useEffect(() => {
    if (wanted.join(',') !== ids.join(',')) setIds(wanted);
  }, [wanted, ids]);
  return ids;
}

function LevelsRow({ d, pivot }: { d: Dashboard; pivot: number | null | undefined }) {
  const [copied, setCopied] = useState('');
  const chain = d.levelsBasis?.chain ?? null;
  const sr = useMemo(() => (chain ? srLevels(chain, SR_RANGE) : null), [chain]);
  if (!sr) return <span className="db-muted">{d.summary?.chain.error || (d.summaryError != null ? 'OI levels are not available right now.' : 'Loading OI levels…')}</span>;
  const copy = async () => {
    const text = levelsText(sr.analysis.snapshot, hm(sr.analysis.snapshot.t), sr.levels);
    setCopied((await copyText(text)) ? 'Copied' : `Copy failed. Select this text manually: ${text}`);
    setTimeout(() => setCopied(''), 2500);
  };
  return (
    <div className="db-levels">
      <span className="db-level-list">
        <b>{INDEX_NAME[d.symbol]}</b>
        {pivot != null && <span className="db-level warn">Pivot <CopyValue value={Math.round(pivot * 100) / 100} iconSide="end" /></span>}
        {LEVEL_ORDER.map(([side, i]) => {
          const l = sr.levels[side][i];
          return (
            <span key={`${side}${i}`} className={`db-level ${side === 'R' ? 'down' : 'up'}`}>
              {side}{i + 1} {l ? <CopyValue value={l.strike} iconSide="end" /> : <span className="db-muted">—</span>}
            </span>
          );
        })}
      </span>
      <span className="db-copy">
        <span className="db-muted" title="Levels move at most once an hour; Refresh or a new expiry updates them at once">
          Levels {d.levelsBasis ? hhmm(d.levelsBasis.at) : ''} IST · next {d.levelsBasis ? hhmm(d.levelsBasis.at + LEVELS_REFRESH_SEC * 1000) : ''}
        </span>
        {copied && <span className="db-muted">{copied}</span>}
        <button className="btn" onClick={() => void copy()}>Copy levels for chart</button>
      </span>
    </div>
  );
}

export default function DashboardApp() {
  const [tab, setTabState] = useState<Tab>(() => {
    const v = read('tab');
    return v === 'NIFTY' || v === 'BANKNIFTY' ? v : 'both';
  });
  const setTab = (t: Tab) => { write('tab', t); setTabState(t); };
  // always opens on the plain chart (owner 27-Oct-2026); picking a strategy on the board adds its indicators
  const [strategy, setStrategy] = useState<ChartStrategy>('all');
  const [showToggles, setShowToggles] = useState(false);
  const [openBox, setOpenBox] = useState<{ key: StrategyKey; symbol: string } | null>(null);
  const toggles = useToggles();
  const now = useClock();
  const [showSettings, setShowSettings] = useState(false);

  const sigN = useSignals('NIFTY');
  const sigB = useSignals('BANKNIFTY');
  const sN = sigN.data;
  const sB = sigB.data;
  // the option selling book's state for the board (owner 28-Oct-2026); undefined = not running, so no selling rows
  const [selling, setSelling] = useState<SellingState | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () => getJson<SellingState>(API_BASE, '/api/selling/state').then((r) => live && setSelling(r), () => live && setSelling(undefined));
    void load();
    const id = window.setInterval(load, 10000);
    return () => { live = false; window.clearInterval(id); };
  }, []);
  // a strategy's chart opens at its own candle size, and the Interval picker stays usable (owner 27-Oct-2026)
  const [strategyInterval, setStrategyInterval] = useState<number | null>(null);
  useEffect(() => setStrategyInterval(null), [strategy]);
  const presetInterval = strategy === 'all' ? null : strategyInterval ?? CHART_PRESETS[strategy].interval;
  const dN = useDashboard(useOptionIds(sN, 'NIFTY', true), { symbol: 'NIFTY', interval: presetInterval });
  const dB = useDashboard(useOptionIds(sB, 'BANKNIFTY', true), { symbol: 'BANKNIFTY', interval: presetInterval });
  // the interval and date pickers move both charts together
  const both = {
    setInterval: (v: number) => {
      if (strategy !== 'all') return setStrategyInterval(v);
      dN.setInterval(v);
      dB.setInterval(v);
    },
    setDay: (v: string) => { dN.setDay(v); dB.setDay(v); },
    setRangeDays: (v: number) => { dN.setRangeDays(v); dB.setRangeDays(v); },
  };
  const dash: Record<string, Dashboard> = { NIFTY: { ...dN, ...both }, BANKNIFTY: { ...dB, ...both } };
  const signals: Record<string, SignalsState | null> = { NIFTY: sN, BANKNIFTY: sB };
  const s = sN ?? sB; // account-wide parts (auto, accounts, alerts, snapshots) are the same in both
  const ltp = { ...dB.optionLtp, ...dN.optionLtp };
  const symbols: string[] = tab === 'both' ? [...SYMS] : [tab];

  const left = minutesToExit(now);
  const vix = s?.context.find((c) => c?.vix != null)?.vix;
  const rows = s?.auto?.today ?? [];
  // the manual paper account counts too (owner 27-Oct-2026): its P&L before charges, at the live price
  // hand-placed positions come per index (each signals state has its own); the Both tab shows both (owner 27-Oct-2026)
  const manual = symbols.flatMap((x) => (x === 'NIFTY' ? sN : sB)?.paperPositions ?? []);
  const dayPnl = rows.reduce((t, r) => t + (r.status === 'closed' ? r.netPnl ?? 0 : r.pnl ?? 0), 0)
    + manual.reduce((t, p) => t + manualPnl(p, ltp[p.security_id]), 0);
  const openCount = (s?.auto?.open ?? []).length + manual.filter((p) => p.open_qty !== 0).length;
  const status = dN.status.kind === 'error' ? dN.status : dB.status.kind === 'error' ? dB.status : dN.status;
  const anyLoading = dN.loading || dB.loading;
  const refresh = () => {
    dN.refresh();
    dB.refresh();
    sigN.reload();
    sigB.reload();
  };
  const compText = (sym: string) => {
    const c = componentsCard(dash[sym].summary?.components, (constituents as Record<string, Constituent[]>)[sym] ?? [], new Date());
    return c.figures.length ? `Index components: ${c.figures[0].value}${c.verdict ? ` · ${c.verdict}` : ''}` : '';
  };
  const spotOf = (sym: string) => dash[sym].summary?.chain.data?.meta.spot;

  return (
    <div className="ds db">
      {/* 1. status strip */}
      <section className="card db-strip">
        <Segmented label="Index" options={TABS} value={tab} onChange={(v) => { setTab(v); setOpenBox(null); }} />
        <span className="db-strip-figs">
          {SYMS.map((x) => (
            <span key={x}><span className="db-muted">{INDEX_NAME[x]}</span> <b className="num">{spotOf(x) != null ? inr(2)(spotOf(x)!) : '—'}</b></span>
          ))}
          <Link to="/today" className="db-strip-link" title="See every trade on Today">
            <span className="db-muted">Day P&amp;L</span> <b className={`num ${tone(dayPnl)}`}>{signed(0)(dayPnl)}</b>
            <span className="db-muted"> · Open trades</span> <b className="num">{openCount}</b>
          </Link>
          <span><span className="db-muted">VIX</span> <b className="num">{vix != null ? inr(2)(vix) : '—'}</b></span>
        </span>
        <Pill tone={left <= 30 ? 'warn' : 'neutral'}>Exit by 3:15 · {left} min left</Pill>
        <div className="toolbar-end">
          {dN.status.closed && <Pill tone="neutral">Market closed</Pill>}
          <Status kind={status.kind}>{status.label} · {clock(now)}</Status>
          <button className="btn" onClick={refresh} disabled={anyLoading}>{anyLoading ? 'Refreshing…' : 'Refresh'}</button>
          <div className="db-settings">
            <button className="btn ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>Settings</button>
            {showSettings && (
              <div className="card db-pop">
                {SYMS.map((x) => (
                  <label key={x} className="field">Expiry for {INDEX_NAME[x]} OI levels
                    <select value={dash[x].expiry} onChange={(e) => dash[x].setExpiry(e.target.value)} disabled={!dash[x].expiries.length}>
                      {!dash[x].expiries.length && <option value="">…</option>}
                      {dash[x].expiries.map((e) => <option key={e} value={e}>{nseDate(e)}</option>)}
                    </select>
                  </label>
                ))}
                <label className="field">Auto-refresh (chart levels)
                  <select value={dN.refreshSec} onChange={(e) => { dN.setRefreshSec(Number(e.target.value)); dB.setRefreshSec(Number(e.target.value)); }}>
                    {REFRESH_OPTIONS.map((x) => <option key={x} value={x}>Every {refreshLabel(x)}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>
        </div>
      </section>

      {SYMS.map((x) => dash[x].summaryError != null && <Alert key={x} kind="error">{INDEX_NAME[x]}: {errorText(dash[x].summaryError)}{dash[x].summary && ' Showing the last data received.'}</Alert>)}
      {(sigN.error ?? sigB.error) != null && <Alert kind="error">Signals: {errorText(sigN.error ?? sigB.error)}</Alert>}
      {s?.meta.watcher.late && <Alert kind="error">The signal watcher has not run for over 7 minutes. Restart the backend (python main.py).</Alert>}
      {(s?.alerts ?? []).filter((a) => a.kind !== 'summary').slice(-3).map((a) => (
        <Alert key={a.time + a.message} kind="warn">{a.time.slice(11, 16)} · {a.message}</Alert>
      ))}

      {/* 2. strategy board */}
      <StrategyBoard signals={signals} symbols={symbols} strategy={strategy} open={openBox} ltp={ltp}
        onStrategy={setStrategy} onOpen={setOpenBox} selling={selling} />

      {/* 3. charts */}
      <div className="db-section-head">
        <h3 className="card-title">Chart · {strategyName(strategy)}</h3>
        <span className="db-head-end">
          {strategy === 'all' ? (
            <>
              {!showToggles && <span className="db-muted">Pick a strategy above to add its indicators, levels and trades</span>}
              {showToggles && (
                <span className="db-toggles" role="group" aria-label="Indicators">
                  {INDICATORS.map(([k, label]) => (
                    <button key={k} type="button" className={`db-toggle ${toggles.indicators[k] ? 'on' : ''}`} aria-pressed={toggles.indicators[k]}
                      title={k === 'volume' || k === 'vwap' ? "Uses the near-month future's volume: an index has none" : undefined}
                      onClick={() => toggles.toggle(k)}>{label}</button>
                  ))}
                </span>
              )}
              <button type="button" className="btn ghost" onClick={() => setShowToggles((v) => !v)} aria-expanded={showToggles}>
                {showToggles ? 'Hide indicator list' : 'Add my own indicators'}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setStrategy('all')}>✕ Back to plain chart</button>
          )}
        </span>
      </div>
      <div className={symbols.length > 1 ? 'db-split' : ''}>
        {symbols.map((x) => (
          <ChartPanel key={x} d={dash[x]} sig={signals[x]} strategy={strategy} indicators={toggles.indicators} />
        ))}
      </div>

      {/* 4. paper trading */}
      <div className="db-section-head">
        <h3 className="card-title">Rule accounts{tab !== 'both' ? ` · ${INDEX_NAME[tab]}` : ''}</h3>
        <AutoSwitch auto={s?.auto ?? null} busy={sigN.busy} notice={sigN.notice} onAuto={(on) => void sigN.toggleAuto(on)} />
      </div>
      <div className="db-accts">
        {(['megabull', 'tradingHub', 'dharani'] as const).map((a) => (
          <AccountCard key={a} account={a} auto={s?.auto ?? null} symbol={tab === 'both' ? '' : tab} ltp={ltp} now={now} busy={sigN.busy}
            onExit={(id) => void sigN.exitTrade(id)} />
        ))}
      </div>
      {/* owner 27-Oct-2026: every trade of the day (manual ones too) with live P&L lives on one page, Today */}
      <Link to="/today" className="card db-today-link">
        <span><b>All of today&apos;s trades{manual.length ? `, including your ${manual.length} manual trade${manual.length > 1 ? 's' : ''},` : ''} are on Today</b>
          <span className="db-muted"> · open and closed, every account, live P&amp;L, Exit buttons</span></span>
        <span className={`num ${tone(dayPnl)}`}>{signed(0)(dayPnl)} →</span>
      </Link>

      {/* 5. market context (collapsed) */}
      <details className="card db-context" onToggle={(e) => write('context', (e.target as HTMLDetailsElement).open ? '1' : '0')} open={read('context') === '1'}>
        <summary className="card-title">Market context <span className="db-muted">· day levels, Trending OI, OI views, OI levels, order flow</span></summary>
        <div className="db-context-body">
          <DayLevels rows={s?.context ?? [null, null]} />
          {symbols.map((x) => (
            <div key={x} className="db-context-index">
              <h3 className="card-title">{INDEX_NAME[x]}</h3>
              <LevelsRow d={dash[x]} pivot={signals[x]?.context.find((c) => c?.symbol === x)?.pivot} />
              <div className="db-two">
                <TrendingOiCard rows={signals[x]?.trendingOi ?? []} />
                <OiViewsCard views={signals[x]?.oiViews ?? null} sr={signals[x]?.sr ?? null} />
              </div>
              <div className="db-two">
                <SrCard sr={signals[x]?.sr ?? null} components={compText(x)} />
                <OrderFlowCard f={signals[x]?.orderFlow} symbol={x} />
              </div>
            </div>
          ))}
        </div>
      </details>

      {/* 6. snapshot log */}
      <SnapshotBar s={s?.snapshots} watcher={s?.meta.watcher} />
    </div>
  );
}
