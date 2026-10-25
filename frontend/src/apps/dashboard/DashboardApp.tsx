// Dashboard (landing page), top to bottom as in the owner's brief (23-Oct-2026):
// top bar → day levels → chart → the two rule cards → OI section → paper trade card → snapshot log bar.
// The chart, candles and S/R lines are the existing dashboard (useDashboard); the rule cards, OI section and paper card
// show the backend signal watcher's evaluation (useSignals, GET /api/signals/state).
import { useEffect, useMemo, useState } from 'react';
import { copyText } from '../../shared/clipboard';
import { nseDate } from '../../shared/dhan/chainAdapter';
import { inr } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, CopyValue, EmptyState, Pill, Status } from '../../shared/ui';
import { SYMBOLS } from '../option-strategy/config/expiries';
import { hm } from '../oi-support-resistance/OsrResult';
import { levelsText } from '../oi-support-resistance/logic/levels';
import { api as paperApi } from '../paper-trade/logic/api';
import { BB_PERIOD, DAILY_RANGES, EMA_PERIOD, INTERVALS, LEVELS_REFRESH_SEC, REFRESH_OPTIONS, RSI_PERIOD, SR_RANGE, ST_FACTOR, ST_PERIOD } from './config/settings';
import { componentsCard } from './logic/cards';
import { srLevels } from './logic/levels';
import { pivots } from './logic/indicators';
import { minutesToExit } from './logic/signals';
import constituents from '../components/config/constituents.json';
import type { Constituent } from '../components/logic/components';
import { PriceChart } from './PriceChart';
import {
  AccountCard, AutoSwitch, DayLevels, ManualPositions, OiViewsCard, OrderFlowCard, RuleCard, SnapshotBar, SrCard, TodayTrades, TrendingOiCard,
} from './SignalPanels';
import { useDashboard } from './useDashboard';
import { useSignals } from './useSignals';
import './dashboard.css';

const INDICATORS = [
  ['supertrend', `SuperTrend ${ST_PERIOD},${ST_FACTOR}`], ['bollinger', `Bollinger ${BB_PERIOD}`], ['ema', `EMA ${EMA_PERIOD}`],
  ['vwap', 'VWAP'], ['volume', 'Volume'], ['rsi', `RSI ${RSI_PERIOD}`], ['delta', 'Cum. delta (est.)'],
] as const;
const LEVEL_ORDER = [['S', 0], ['S', 1], ['S', 2], ['R', 0], ['R', 1], ['R', 2]] as const;
const refreshLabel = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const clock = (d: Date) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function DashboardApp() {
  const [optionIds, setOptionIds] = useState<number[]>([]);
  const d = useDashboard(optionIds);
  const sig = useSignals(d.symbol);
  const now = useClock();
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState('');

  const s = sig.data;
  // live premiums for the paper card: auto trades on this index + hand-placed positions
  const wanted = useMemo(() => [
    ...(s?.auto?.open ?? []).filter((t) => t.symbol === d.symbol && typeof t.instrument.id === 'number').map((t) => t.instrument.id as number),
    ...(s?.paperPositions ?? []).map((p) => p.security_id),
  ], [s, d.symbol]);
  useEffect(() => {
    if (wanted.join(',') !== optionIds.join(',')) setOptionIds(wanted);
  }, [wanted, optionIds]);

  const intervalLabel = INTERVALS.find((x) => x.value === d.interval)?.label ?? `${d.interval} min`;
  const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const levelsChain = d.levelsBasis?.chain ?? null; // replaced at most hourly, see useDashboard
  const sr = useMemo(() => (levelsChain ? srLevels(levelsChain, SR_RANGE) : null), [levelsChain]);
  const levelsAt = d.levelsBasis ? hhmm(d.levelsBasis.at) : '';
  const levelsNext = d.levelsBasis ? hhmm(d.levelsBasis.at + LEVELS_REFRESH_SEC * 1000) : '';
  const ctx = s?.context.find((c) => c?.symbol === d.symbol) ?? null;
  // pivot line: today's from the watcher; an earlier day's from its previous session; none on the daily chart
  const chartPivot = d.isDaily ? null : d.day ? (d.prevSession ? pivots(d.prevSession.high, d.prevSession.low, d.prevSession.close).P : null) : ctx?.pivot ?? null;
  const comp = useMemo(() => componentsCard(d.summary?.components, (constituents as Record<string, Constituent[]>)[d.symbol] ?? [], new Date()), [d.summary, d.symbol]);
  const compText = comp.figures.length ? `Index components: ${comp.figures[0].value}${comp.verdict ? ` · ${comp.verdict}` : ''}` : '';
  const left = minutesToExit(now);

  const copyLevels = async () => {
    if (!sr) return;
    const text = levelsText(sr.analysis.snapshot, hm(sr.analysis.snapshot.t), sr.levels);
    setCopied((await copyText(text)) ? 'Copied' : `Copy failed. Select this text manually: ${text}`);
    setTimeout(() => setCopied(''), 2500);
  };
  const refresh = () => {
    d.refresh();
    sig.reload();
  };

  return (
    <div className="ds db">
      {/* 1. top bar */}
      <section className="card">
        <div className="toolbar">
          <label className="field">Index
            <select value={d.symbol} onChange={(e) => d.setSymbol(e.target.value)}>
              {SYMBOLS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry (OI levels)
            <select value={d.expiry} onChange={(e) => d.setExpiry(e.target.value)} disabled={!d.expiries.length}>
              {!d.expiries.length && <option value="">…</option>}
              {d.expiries.map((x) => <option key={x} value={x}>{nseDate(x)}</option>)}
            </select>
          </label>
          <div className="db-chips">
            <Pill tone={left <= 30 ? 'warn' : 'neutral'}>Exit by 3:15 PM · {left} min left · no new Trend entries after 2:30</Pill>
            <Pill tone="accent">India VIX {ctx?.vix != null ? inr(2)(ctx.vix) : '—'} · record only</Pill>
          </div>
          <div className="toolbar-end">
            {d.status.closed && <Pill tone="neutral">Market closed</Pill>}
            <Status kind={d.status.kind}>{d.status.label} · {clock(now)}</Status>
            <button className="btn" onClick={refresh} disabled={d.loading}>{d.loading ? 'Refreshing…' : 'Refresh'}</button>
            <div className="db-settings">
              <button className="btn ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>Settings</button>
              {showSettings && (
                <div className="card db-pop">
                  <label className="field">Auto-refresh (chart levels)
                    <select value={d.refreshSec} onChange={(e) => d.setRefreshSec(Number(e.target.value))}>
                      {REFRESH_OPTIONS.map((x) => <option key={x} value={x}>Every {refreshLabel(x)}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {d.summaryError != null && <Alert kind="error">{errorText(d.summaryError)}{d.summary && ' Showing the last data received.'}</Alert>}
      {sig.error != null && <Alert kind="error">Signals: {errorText(sig.error)}</Alert>}
      {s?.meta.watcher.late && <Alert kind="error">The signal watcher has not run for over 7 minutes. Restart the backend (python main.py).</Alert>}
      {(s?.alerts ?? []).filter((a) => a.kind !== 'summary').slice(-3).map((a) => (
        <Alert key={a.time + a.message} kind="warn">{a.time.slice(11, 16)} · {a.message}</Alert>
      ))}

      {/* 2. day levels */}
      <DayLevels rows={s?.context ?? [null, null]} />

      {/* 3. chart */}
      <section className="card db-chart-card">
        <div className="card-head">
          <h3 className="card-title">{d.symbol} · {intervalLabel}{d.isDaily ? '' : ` · ${d.day ? nseDate(d.day) : 'today'}`}
            {d.live && d.feedState !== 'open' && <span className="db-muted"> · live feed {d.feedState}</span>}</h3>
          <span className="db-head-end">
            <label className="field db-inline">Interval
              <select value={d.interval} onChange={(e) => d.setInterval(Number(e.target.value))}>
                {INTERVALS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
            {d.isDaily ? (
              <label className="field db-inline">Range
                <select value={d.rangeDays} onChange={(e) => d.setRangeDays(Number(e.target.value))}>
                  {DAILY_RANGES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              </label>
            ) : (
              <label className="field db-inline">Date
                <select value={d.day} onChange={(e) => d.setDay(e.target.value)}>
                  <option value="">Today (live)</option>
                  {d.sessions.filter((x) => x !== todayIst).map((x) => <option key={x} value={x}>{nseDate(x)}</option>)}
                </select>
              </label>
            )}
            {d.summary?.chain.data && <span className="db-muted num">Spot {inr(2)(d.summary.chain.data.meta.spot)}</span>}
            <span className="db-toggles" role="group" aria-label="Indicators">
              {INDICATORS.map(([k, label]) => (
                <button key={k} type="button" className={`db-toggle ${d.indicators[k] ? 'on' : ''}`} aria-pressed={d.indicators[k]}
                  title={k === 'volume' || k === 'vwap' ? `Uses the near-month future's volume${d.volumeInfo ? ` (${d.volumeInfo.name})` : ''}: an index has none` : undefined}
                  onClick={() => d.toggleIndicator(k)}>{label}</button>
              ))}
            </span>
          </span>
        </div>
        {d.candlesError != null && d.summaryError == null && <Alert kind="error">Candles: {errorText(d.candlesError)}</Alert>}
        {!d.bars.length ? (
          <EmptyState>{d.candlesError != null ? 'Candles are not available right now.' : 'Loading candles…'}</EmptyState>
        ) : (
          <PriceChart bars={d.bars} levels={d.live ? sr?.levels ?? null : null} pivot={chartPivot}
            resetKey={`${d.symbol}-${d.interval}-${d.day}-${d.rangeDays}`}
            indicators={d.indicators} volumeLabel={d.volumeInfo ? `Vol ${d.volumeInfo.name}` : 'Vol'} delta={d.flow} />
        )}
        <div className="db-levels">
          {sr ? (
            <>
              <span className="db-level-list">
                {ctx?.pivot != null && <span className="db-level warn">Pivot <CopyValue value={Math.round(ctx.pivot * 100) / 100} iconSide="end" /></span>}
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
                <span className="db-muted" title="Levels move at most once an hour; Refresh or a new index / expiry updates them at once">
                  Levels {levelsAt} IST · next {levelsNext}
                </span>
                {copied && <span className="db-muted">{copied}</span>}
                <button className="btn" onClick={() => void copyLevels()}>Copy levels for chart</button>
              </span>
            </>
          ) : (
            <span className="db-muted">
              {d.summary?.chain.error || (d.summaryError != null ? 'OI levels are not available right now.' : 'Loading OI levels…')}
            </span>
          )}
        </div>
        <p className="card-foot">
          {!d.live && <>Showing {d.isDaily ? 'daily candles' : `an earlier day (${nseDate(d.day)})`}: no live updates, OI levels only for today. The rule cards always use today's 5-min reading. </>}
          Dashed lines: the pivot and S1–S3 / R1–R3 (top put / call OI within {SR_RANGE} pts of spot, updated hourly).
          SuperTrend red = bearish, green = bullish. RSI zones: put 30–45, call 55–70.
          {d.indicators.volume && (d.volumeInfo ? ` Volume and VWAP: ${d.volumeInfo.name} (near-month future).` : '')}
          {d.indicators.volume && d.volumeError && ` ${d.volumeError}`}{' '}
          Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a>.
        </p>
      </section>

      {/* 4. rule cards */}
      <div className="db-three">
        <RuleCard r={s?.rules.megabull} fallbackName="MEGABULL RULE" />
        <RuleCard r={s?.rules.dharaniV2} fallbackName="DHARANI v2 RULE" />
        <RuleCard r={s?.rules.tradingHub} fallbackName="TRADING HUB RULE" />
        <OrderFlowCard f={s?.orderFlow} symbol={d.symbol} />
      </div>
      {s && <p className="db-eval">Evaluated {s.meta.evaluatedAt} IST on the {s.meta.signalCandle ?? '—'} candle ({s.meta.source === 'watcher' ? 'signal watcher' : 'page check, no trading'}).
        {s.meta.problems.length > 0 && ` Data: ${s.meta.problems.join('; ')}`}</p>}

      {/* 5. OI section */}
      <div className="db-two">
        <TrendingOiCard rows={s?.trendingOi ?? []} />
        <OiViewsCard views={s?.oiViews ?? null} sr={s?.sr ?? null} />
      </div>
      <SrCard sr={s?.sr ?? null} components={compText} />

      {/* 6. paper trading, both accounts (the owner never needs to open MegaBull) */}
      <div className="db-section-head">
        <h3 className="card-title">Paper trading · {d.symbol === 'BANKNIFTY' ? 'Bank Nifty' : 'Nifty'}</h3>
        <AutoSwitch auto={s?.auto ?? null} busy={sig.busy} notice={sig.notice} onAuto={(on) => void sig.toggleAuto(on)} />
      </div>
      <div className="db-two">
        <AccountCard account="megabull" auto={s?.auto ?? null} symbol={d.symbol} ltp={d.optionLtp} now={now} busy={sig.busy}
          onExit={(id) => void sig.exitTrade(id)} />
        <AccountCard account="tradingHub" auto={s?.auto ?? null} symbol={d.symbol} ltp={d.optionLtp} now={now} busy={sig.busy}
          onExit={(id) => void sig.exitTrade(id)}>
          <ManualPositions positions={s?.paperPositions ?? []} ltp={d.optionLtp} busy={sig.busy} onBracket={(id) => void sig.bracket(id)}
            onExitManual={(id) => void paperApi.exit(id).then(() => sig.reload())} />
        </AccountCard>
      </div>
      <TodayTrades auto={s?.auto ?? null} shadow={s?.shadow ?? null} />

      {/* 7. snapshot log */}
      <SnapshotBar s={s?.snapshots} watcher={s?.meta.watcher} />
    </div>
  );
}
