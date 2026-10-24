import { useMemo, useState } from 'react';
import { copyText } from '../../shared/clipboard';
import { nseDate } from '../../shared/dhan/chainAdapter';
import { inr, signed } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, CopyValue, EmptyState, Pill, Segmented, Status } from '../../shared/ui';
import { SYMBOLS } from '../option-strategy/config/expiries';
import { hm } from '../oi-support-resistance/OsrResult';
import { levelsText } from '../oi-support-resistance/logic/levels';
import { EMA_PERIOD, INTERVALS, REFRESH_OPTIONS, RSI_PERIOD, SR_RANGE } from './config/settings';
import { buildCards, consensus } from './logic/cards';
import { chartLevels, compare, hhmm, ROW_ORDER, shiftSummary, toSet, type Comparison } from './logic/fixedLevels';
import { currentLevels, saveSrSettings, type SrChange, type SrSettings } from './logic/levelHistory';
import { srFrom } from './logic/levels';
import { Consensus, GlanceCard } from './GlanceCard';
import constituents from '../components/config/constituents.json';
import type { Constituent } from '../components/logic/components';
import { PriceChart } from './PriceChart';
import { useDashboard } from './useDashboard';
import './dashboard.css';

const INDICATORS = [['volume', 'Volume'], ['rsi', `RSI ${RSI_PERIOD}`], ['ema', `EMA ${EMA_PERIOD}`]] as const;
const refreshLabel = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
const strike = (n: number) => inr(Number.isInteger(n) ? 0 : 2)(n);
const changeText = (c: SrChange) => `${strike(c.from)} → ${c.to == null ? 'removed' : strike(c.to)}`;
const REASONS: Record<string, string> = {
  oi: 'OI lead held', crossed: 'spot crossed it', range: 'out of range', fill: 'slot filled', renumber: 'renumbered', open: 'first set',
};

export default function DashboardApp() {
  const d = useDashboard();
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState('');
  const [showChanges, setShowChanges] = useState(false); // "Level changes today" starts collapsed

  const chainResp = d.summary?.chain;
  const chain = chainResp?.data && (chainResp.status === 'ok' || chainResp.status === 'stale') ? chainResp.data : null;
  const h = d.history?.meta.symbol === d.symbol && d.history.meta.expiry === d.expiry ? d.history : null;
  const range = h?.meta.settings.range ?? SR_RANGE;
  // levels: the backend's accepted set (stability rule) with this chain's OI; the raw ranking if nothing is recorded yet
  const sr = useMemo(() => (chain ? srFrom(chain, currentLevels(h, chain.meta.lotSize), range) : null), [chain, h, range]);
  const recorded = sr?.source === 'recorded';

  const changes = useMemo(() => (h ? h.changes.filter((c) => c.reason !== 'open') : []), [h]);
  // the chart draws exactly one set: the fixed zones while "Fix zones" is ticked, else the live levels
  const lines = useMemo(() => chartLevels(sr?.levels ?? null, d.fixed), [sr, d.fixed]);
  const rows = useMemo(() => (d.fixed ? compare(d.fixed.levels, toSet(sr?.levels ?? null)) : null), [d.fixed, sr]);
  const summary = d.fixed && rows ? shiftSummary(rows, d.fixed.fixedAt) : '';
  const cards = useMemo(
    () => buildCards(d.summary, sr, (constituents as Record<string, Constituent[]>)[d.symbol] ?? [], new Date(),
      d.summaryError != null ? 'Not available. See the message at the top.' : ''),
    [d.summary, sr, d.symbol, d.summaryError],
  );
  const staleAll = d.status.kind === 'stale'; // the whole summary is old: every card shows it

  const copyLevels = async () => {
    if (!sr) return;
    const text = levelsText(sr.analysis.snapshot, hm(sr.analysis.snapshot.t), sr.levels);
    setCopied((await copyText(text)) ? 'Copied' : `Copy failed. Select this text manually: ${text}`);
    setTimeout(() => setCopied(''), 2500);
  };

  return (
    <div className="ds db">
      <section className="card">
        <div className="toolbar">
          <label className="field">Index
            <select value={d.symbol} onChange={(e) => d.setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry (OI levels)
            <select value={d.expiry} onChange={(e) => d.setExpiry(e.target.value)} disabled={!d.expiries.length}>
              {!d.expiries.length && <option value="">…</option>}
              {d.expiries.map((x) => <option key={x} value={x}>{nseDate(x)}</option>)}
            </select>
          </label>
          <div className="field">Interval
            <Segmented label="Candle interval" options={INTERVALS} value={String(d.interval) as (typeof INTERVALS)[number]['value']}
              onChange={(v) => d.setInterval(Number(v))} />
          </div>
          <div className="toolbar-end">
            {d.status.closed && <Pill tone="neutral">Market closed</Pill>}
            <Status kind={d.status.kind}>{d.status.label}</Status>
            <button className="btn" onClick={d.refresh} disabled={d.loading}>{d.loading ? 'Refreshing…' : 'Refresh'}</button>
            <div className="db-settings">
              <button className="btn ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Settings</button>
              {showSettings && (
                <div className="card db-pop">
                  <label className="field">Auto-refresh (cards and levels)
                    <select value={d.refreshSec} onChange={(e) => d.setRefreshSec(Number(e.target.value))}>
                      {REFRESH_OPTIONS.map((s) => <option key={s} value={s}>Every {refreshLabel(s)}</option>)}
                    </select>
                  </label>
                  {h && <SrRuleForm key={JSON.stringify(h.meta.settings)} settings={h.meta.settings} onSaved={d.reloadHistory} />}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {d.summaryError != null && <Alert kind="error">{errorText(d.summaryError)}{d.summary && ' Showing the last data received.'}</Alert>}

      <div className="db-grid">
        <section className="card db-chart-card">
          <div className="card-head">
            <h3 className="card-title">{d.symbol} · {d.interval} min{d.feedState !== 'open' && <span className="db-muted"> · live feed {d.feedState}</span>}</h3>
            <span className="db-head-end">
              {d.summary?.chain.data && <span className="db-muted num">Spot {inr(2)(d.summary.chain.data.meta.spot)}</span>}
              <span className="db-toggles" role="group" aria-label="Indicators">
                {INDICATORS.map(([k, label]) => (
                  <button key={k} type="button" className={`db-toggle ${d.indicators[k] ? 'on' : ''}`} aria-pressed={d.indicators[k]}
                    title={k === 'volume' ? `Volume of the near-month future${d.volumeInfo ? ` (${d.volumeInfo.name})` : ''}: an index has none` : undefined}
                    onClick={() => d.toggleIndicator(k)}>{label}</button>
                ))}
              </span>
              <label className="db-fix" title="Freeze the S/R lines on the chart; the row below shows how the live levels moved since">
                <input type="checkbox" checked={!!d.fixed} disabled={!d.fixed && !sr}
                  onChange={(e) => void d.setFixed(e.target.checked, toSet(sr?.levels ?? null))} />
                Fix zones
              </label>
              {d.fixed && <span className="db-muted num">Fixed at {hhmm(d.fixed.fixedAt)}</span>}
            </span>
          </div>
          {d.candlesError != null && d.summaryError == null && <Alert kind="error">Candles: {errorText(d.candlesError)}</Alert>}
          {!d.bars.length ? (
            <EmptyState>{d.candlesError != null ? 'Candles are not available right now.' : 'Loading candles…'}</EmptyState>
          ) : (
            <PriceChart bars={d.bars} levels={lines} resetKey={`${d.symbol}-${d.interval}`}
              indicators={d.indicators} volumeLabel={d.volumeInfo ? `Vol ${d.volumeInfo.name}` : 'Vol'} />
          )}
          {d.fixedError != null && <Alert kind="error">Fix zones: {errorText(d.fixedError)}</Alert>}
          <div className="db-levels">
            {sr || d.fixed ? (
              <>
                <div className="db-compare">
                  {summary && <span className="db-shift-summary">{summary}</span>}
                  {ROW_ORDER.map((line) => (
                    <span key={line[0]} className="db-level-list">
                      {line.map((slot) => <LevelCell key={slot} slot={slot} live={toSet(sr?.levels ?? null)[slot] ?? null}
                        row={rows?.find((r) => r.slot === slot) ?? null} />)}
                    </span>
                  ))}
                </div>
                <span className="db-copy">
                  {copied && <span className="db-muted">{copied}</span>}
                  <button className="btn" disabled={!sr} onClick={() => void copyLevels()}>Copy levels for chart</button>
                </span>
              </>
            ) : (
              <span className="db-muted">
                {d.summary?.chain.error || (d.summaryError != null ? 'OI levels are not available right now.' : 'Loading OI levels…')}
              </span>
            )}
          </div>
          <div className="db-changes">
            <div className="db-changes-head">
              <button type="button" className="db-changes-toggle" aria-expanded={showChanges} onClick={() => setShowChanges((v) => !v)}>
                Level changes today ({changes.length}) {showChanges ? '▾' : '▸'}
              </button>
              <span className="db-muted">
                {recorded ? `Recorded · as of ${h!.meta.asOf.slice(11, 16)} IST` : chain ? 'Not recorded yet: raw OI ranking shown' : ''}
              </span>
            </div>
            {showChanges && d.historyError != null && <span className="db-muted">Level history: {errorText(d.historyError)}</span>}
            {!showChanges ? null : changes.length ? (
              <ol className="db-change-list">
                {changes.map((c) => (
                  <li key={`${c.at}|${c.slot}`} className="num">
                    <span className="db-muted">{c.at.slice(11, 16)}</span>
                    <span className={`db-level ${c.slot[0] === 'R' ? 'down' : 'up'}`}>{c.slot}</span>
                    <span>{changeText(c)}</span>
                    {c.to != null && <span className="db-muted">{signed(0)(c.to - c.from)} · {REASONS[c.reason] ?? c.reason}</span>}
                  </li>
                ))}
              </ol>
            ) : (
              <span className="db-muted">{h?.meta.message || (h ? 'No changes yet.' : '')}</span>
            )}
          </div>
          <p className="card-foot">
            {d.fixed ? `Chart lines: the zones fixed at ${hhmm(d.fixed.fixedAt)}; the row compares them with the live levels. ` : ''}
            S1–S3 / R1–R3: top put / call OI within {range} pts of spot. A level moves to another strike only when that
            strike's OI leads by {h?.meta.settings.leadPct ?? 10}% for {h?.meta.settings.confirmRefreshes ?? 3} refreshes in a row
            (at once if spot crosses it); OI Support &amp; Resistance Live shows the same levels.
            {d.indicators.volume && (d.volumeInfo ? ` Volume: ${d.volumeInfo.name} (near-month future).` : '')}
            {d.indicators.volume && d.volumeError && ` ${d.volumeError}`}{' '}
            Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a>.
          </p>
        </section>

        <aside className="db-side" aria-label="Live apps at a glance">
          <Consensus counts={consensus(cards)} />
          {cards.map((c) => <GlanceCard key={c.id} c={c} stale={staleAll} />)}
        </aside>
      </div>
    </div>
  );
}

/** One slot of the level row. Not fixed: the live level (copyable). Fixed: "22,500 → 22,400 ↓100" or "22,700 —". */
function LevelCell({ slot, live, row }: { slot: string; live: number | null; row: Comparison | null }) {
  const cls = `db-level ${slot[0] === 'R' ? 'down' : 'up'}`;
  if (!row) {
    return <span className={cls}>{slot} {live != null ? <CopyValue value={live} iconSide="end" /> : <span className="db-muted">—</span>}</span>;
  }
  return (
    <span className={cls}>
      {slot}{' '}
      {row.fixed != null ? <CopyValue value={row.fixed} iconSide="end" /> : <span className="db-muted">–</span>}
      {row.move === 'same' && <span className="db-same">—</span>}
      {(row.move === 'up' || row.move === 'down') && (
        <span className="db-delta num">→ {strike(row.now!)} <span className={row.move}>{row.move === 'up' ? '↑' : '↓'}{strike(Math.abs(row.delta!))}</span></span>
      )}
      {row.move === 'missing' && <span className="db-same">→ {row.now != null ? strike(row.now) : 'none'}</span>}
    </span>
  );
}

const RULE_FIELDS = [
  ['leadPct', 'New strike OI lead (%)', 0, 100, 1],
  ['confirmRefreshes', 'For refreshes in a row', 1, 30, 1],
  ['range', 'Range from spot (pts)', 50, 3000, 50],
] as const;

/** The stability rule, kept on the backend so the Dashboard and OI S&R Live show the same levels. */
function SrRuleForm({ settings, onSaved }: { settings: SrSettings; onSaved: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [msg, setMsg] = useState('');
  const changed = RULE_FIELDS.some(([k]) => draft[k] !== settings[k]);
  const save = async () => {
    try {
      await saveSrSettings(draft);
      setMsg('Saved. Applies from the next refresh.');
      onSaved();
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <fieldset className="db-rule">
      <legend>S/R level rule (shared)</legend>
      {RULE_FIELDS.map(([k, label, min, max, step]) => (
        <label key={k} className="field">{label}
          <input type="number" min={min} max={max} step={step} value={draft[k]}
            onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} />
        </label>
      ))}
      <span className="db-copy">
        <button className="btn" disabled={!changed} onClick={() => void save()}>Save rule</button>
        {msg && <span className="db-muted">{msg}</span>}
      </span>
    </fieldset>
  );
}
