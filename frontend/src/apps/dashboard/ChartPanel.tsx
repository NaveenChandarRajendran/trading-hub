// One index chart of the dashboard (owner 26-Oct-2026): the selected strategy's indicators only, its candle size, the
// pivot and OI levels, the strategy's buy / sell points today, and a saved zoom per index + strategy. Used twice in the
// split view, once in the single view and once in the pop-out window. Maximize (⤢) fills the app area; Esc returns.
import { useEffect, useMemo, useState } from 'react';
import { nseDate } from '../../shared/dhan/chainAdapter';
import { inr } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState } from '../../shared/ui';
import { DAILY_RANGES, INTERVALS, SR_RANGE, type IndicatorToggles } from './config/settings';
import { BOARD, CHART_PRESETS, tradeMarks, type ChartStrategy } from './logic/board';
import { pivots } from './logic/indicators';
import { srLevels } from './logic/levels';
import type { SignalsState } from './logic/signals';
import { PriceChart } from './PriceChart';
import type { Dashboard } from './useDashboard';

export const INDEX_NAME: Record<string, string> = { NIFTY: 'Nifty', BANKNIFTY: 'Bank Nifty' };
export const strategyName = (k: ChartStrategy) => (k === 'all' ? 'Plain chart' : BOARD.find((b) => b.key === k)?.name ?? k);

/** Opens the chart in its own browser window (live, same app). */
export function popOut(symbol: string, strategy: ChartStrategy) {
  const url = `${window.location.href.split('#')[0]}#/chart-window?symbol=${symbol}&strategy=${strategy}`;
  window.open(url, `chart-${symbol}`, 'popup,width=1280,height=800');
}

export function ChartPanel({ d, sig, strategy, indicators, maximizable = true, poppable = true, note }: {
  d: Dashboard; // useDashboard of this index
  sig: SignalsState | null; // signal state of this index (pivot, today's trades)
  strategy: ChartStrategy;
  indicators: IndicatorToggles; // the user's own toggles (used when strategy = all)
  maximizable?: boolean;
  poppable?: boolean;
  note?: string; // replaces the strategy note under the chart
}) {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!max) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMax(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [max]);

  const preset = CHART_PRESETS[strategy];
  const shown = strategy === 'all' ? indicators : preset.indicators;
  const params = { emaPeriod: preset.emaPeriod, bbPeriod: preset.bb.period, bbMult: preset.bb.mult, rsiGuides: preset.rsiGuides };
  const levelsChain = d.levelsBasis?.chain ?? null;
  const sr = useMemo(() => (levelsChain ? srLevels(levelsChain, SR_RANGE) : null), [levelsChain]);
  const ctx = sig?.context.find((c) => c?.symbol === d.symbol) ?? null;
  const pivot = d.isDaily ? null : d.day ? (d.prevSession ? pivots(d.prevSession.high, d.prevSession.low, d.prevSession.close).P : null) : ctx?.pivot ?? null;
  // SuperTrend Breakout's call checks the close against this R1 (the rule's own number, so chart and checklist agree)
  const r1 = !d.day && !d.isDaily && strategy === 'dharaniV2' ? sig?.rules.dharaniV2?.pivotR1 ?? null : null;
  const ruleLines = useMemo(() => (r1 != null ? [{ price: r1, title: 'Pivot R1' }] : []), [r1]);
  // the plain chart is price only: OI levels, pivot and trade marks come with a strategy (owner 27-Oct-2026)
  const plain = strategy === 'all';
  const marks = useMemo(() => (d.live && !plain ? tradeMarks(sig?.auto, strategy, d.symbol) : []), [d.live, plain, sig?.auto, strategy, d.symbol]);
  const intervalLabel = INTERVALS.find((x) => x.value === d.interval)?.label ?? `${d.interval} min`;
  const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const spot = d.summary?.chain.data?.meta.spot;

  return (
    <section className={`card db-chart-card ${max ? 'db-max' : ''}`}>
      <div className="card-head">
        <h3 className="card-title">{INDEX_NAME[d.symbol] ?? d.symbol}
          <span className="db-muted"> · {intervalLabel}{d.isDaily ? '' : ` · ${d.day ? nseDate(d.day) : 'today'}`}
            {spot != null && <> · spot <b className="num">{inr(2)(spot)}</b></>}
            {d.live && d.feedState !== 'open' && ` · live feed ${d.feedState}`}</span></h3>
        <span className="db-head-end">
          {/* always shown (owner 27-Oct-2026: it hid when a strategy was picked); a strategy starts at its own size */}
          <label className="field db-inline">Interval
            <select value={d.interval} onChange={(e) => d.setInterval(Number(e.target.value))}>
              {INTERVALS.map((x) => <option key={x.value} value={x.value}>{x.label}{strategy !== 'all' && x.value === preset.interval ? ' (rule)' : ''}</option>)}
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
                <option value="">{d.status.closed ? 'Today' : 'Today (live)'}</option>
                {d.sessions.filter((x) => x !== todayIst).map((x) => <option key={x} value={x}>{nseDate(x)}</option>)}
              </select>
            </label>
          )}
          {maximizable && (
            <button type="button" className="icon-btn" title={max ? 'Back (Esc)' : 'Maximize'} aria-label={max ? 'Back' : 'Maximize'}
              onClick={() => setMax((v) => !v)}>{max ? '✕' : '⤢'}</button>
          )}
          {poppable && (
            <button type="button" className="icon-btn" title="Open in its own window" aria-label="Pop out"
              onClick={() => popOut(d.symbol, strategy)}>⧉</button>
          )}
        </span>
      </div>
      {d.candlesError != null && <Alert kind="error">Candles: {errorText(d.candlesError)}</Alert>}
      {!d.bars.length ? (
        <EmptyState>{d.candlesError != null ? 'Candles are not available right now.' : 'Loading candles…'}</EmptyState>
      ) : (
        <PriceChart bars={d.bars} warm={d.warmBars} box={!d.day && (strategy === 'orbPullback' || strategy === 'orbPullback5') ? sig?.rules[strategy]?.box ?? null : null} ruleLines={ruleLines} levels={d.live && !plain ? sr?.levels ?? null : null} pivot={plain ? null : pivot}
          resetKey={`${d.symbol}-${d.interval}-${d.day}-${d.rangeDays}-${strategy}`} viewKey={`${d.symbol}.${strategy}.${d.interval}`} zoomKey={d.isDaily ? undefined : d.symbol}
          indicators={shown} params={params} marks={marks}
          volumeLabel={d.volumeInfo ? `Vol ${d.volumeInfo.name}` : 'Vol'} delta={d.flow} />
      )}
      <p className="card-foot">{note ?? `${strategyName(strategy)}: ${preset.note}`}{plain ? '' : ' ▲ buy · ▼ sell (today\'s paper trades).'}
        {!d.live && ' An earlier day or the daily chart: no live updates and no OI levels.'}</p>
    </section>
  );
}
