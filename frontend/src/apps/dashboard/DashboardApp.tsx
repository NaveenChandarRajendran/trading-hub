import { useMemo, useState } from 'react';
import { copyText } from '../../shared/clipboard';
import { nseDate } from '../../shared/dhan/chainAdapter';
import { inr } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, CopyValue, EmptyState, Pill, Segmented, Status } from '../../shared/ui';
import { SYMBOLS } from '../option-strategy/config/expiries';
import { hm } from '../oi-support-resistance/OsrResult';
import { levelsText } from '../oi-support-resistance/logic/levels';
import { INTERVALS, LEVELS_REFRESH_SEC, REFRESH_OPTIONS, SR_RANGE } from './config/settings';
import { buildCards, consensus } from './logic/cards';
import { srLevels } from './logic/levels';
import { Consensus, GlanceCard } from './GlanceCard';
import constituents from '../components/config/constituents.json';
import type { Constituent } from '../components/logic/components';
import { PriceChart } from './PriceChart';
import { useDashboard } from './useDashboard';
import './dashboard.css';

const LEVEL_ORDER = [['S', 0], ['S', 1], ['S', 2], ['R', 0], ['R', 1], ['R', 2]] as const;
const refreshLabel = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export default function DashboardApp() {
  const d = useDashboard();
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState('');

  const levelsChain = d.levelsBasis?.chain ?? null; // replaced at most hourly, see useDashboard
  const sr = useMemo(() => (levelsChain ? srLevels(levelsChain, SR_RANGE) : null), [levelsChain]);
  const levelsAt = d.levelsBasis ? hhmm(d.levelsBasis.at) : '';
  const levelsNext = d.levelsBasis ? hhmm(d.levelsBasis.at + LEVELS_REFRESH_SEC * 1000) : '';
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
            {d.summary?.chain.data && <span className="db-muted num">Spot {inr(2)(d.summary.chain.data.meta.spot)}</span>}
          </div>
          {d.candlesError != null && d.summaryError == null && <Alert kind="error">Candles: {errorText(d.candlesError)}</Alert>}
          {!d.bars.length ? (
            <EmptyState>{d.candlesError != null ? 'Candles are not available right now.' : 'Loading candles…'}</EmptyState>
          ) : (
            <PriceChart bars={d.bars} liveBar={d.liveBar} levels={sr?.levels ?? null} resetKey={`${d.symbol}-${d.interval}`} />
          )}
          <div className="db-levels">
            {sr ? (
              <>
                <span className="db-level-list">
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
            S1–S3 / R1–R3: top put / call OI within {SR_RANGE} pts of spot, as in OI Support &amp; Resistance Live,
            updated hourly (Refresh updates them now).
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
