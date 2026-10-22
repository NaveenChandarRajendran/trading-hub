import { useEffect, useMemo, useState } from 'react';
import { inr } from '../../shared/grid';
import { toOptionChain, nseDate } from '../../shared/dhan/chainAdapter';
import { errorText, istMs } from '../../shared/live/liveStatus';
import { useLiveChain } from '../../shared/live/useLiveChain';
import { Alert, EmptyState, Pill } from '../../shared/ui';
import { LiveToolbar } from '../../shared/ui/LiveToolbar';
import { DEFAULT_RANGE, DEFAULT_THRESHOLD } from '../oi-support-resistance/config/settings';
import { analyzeChain, buildView, type Analysis, type Snapshot } from '../oi-support-resistance/logic/levels';
import { dayKey } from '../oi-support-resistance/logic/snapshots';
import { OsrResult, hm } from '../oi-support-resistance/OsrResult';
import { createStore } from '../oi-support-resistance/storage';
import { currentLevels, fetchSrHistory, type SrHistory } from '../dashboard/logic/levelHistory';
import { LIVE_PREFIX, liveSaveCheck } from './logic/saveRule';
import '../oi-support-resistance/oi-sr.css';

const store = createStore(LIVE_PREFIX);
const readNum = (k: string, fallback: number) => Number(store.get(k)) || fallback;

export default function OiSupportResistanceLiveApp() {
  // Refresh button only: every click fetches the chain and saves one snapshot; the first one today is the baseline.
  const live = useLiveChain({ appId: 'oi-support-resistance-live', manual: true });
  const [range, setRange] = useState(() => readNum('range', DEFAULT_RANGE));
  const [threshold, setThreshold] = useState(() => readNum('threshold', DEFAULT_THRESHOLD));
  const [showSettings, setShowSettings] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [notice, setNotice] = useState<{ kind: 'warn' | 'info'; text: string } | null>(null);
  const [cleared, setCleared] = useState(0); // bumps after "Clear today's data" so the snapshot list re-reads storage
  // levels accepted by the backend's stability rule, the same ones the Dashboard draws (fetched with every Refresh)
  const [hist, setHist] = useState<{ h: SrHistory | null; lotSize: number; error: string } | null>(null);

  const key = live.expiry ? dayKey(live.symbol, nseDate(live.expiry)) : '';
  // Snapshots for the analysed chain, or for the index + expiry picked in the toolbar before any refresh.
  const todays = useMemo(() => (result ? snaps : key ? store.loadSnapshots(key) : []), [result, snaps, key, cleared]);

  useEffect(() => {
    setResult(null);
    setSnaps([]);
    setNotice(null);
    setHist(null);
  }, [live.symbol, live.expiry]);

  const refresh = async () => {
    setNotice(null);
    const histP = live.expiry ? fetchSrHistory(live.symbol, live.expiry).then((h) => ({ h, error: '' }), (e) => ({ h: null, error: errorText(e) })) : null;
    const r = await live.refresh();
    if (!r) return; // the toolbar shows the error
    const got = histP ? await histP : { h: null, error: '' };
    setHist({ ...got, lotSize: r.meta.lotSize });
    const chain = toOptionChain(r, live.expiries);
    if (!chain.strikes.length || chain.underlying <= 0) {
      setNotice({ kind: 'warn', text: 'Dhan returned no strikes or no spot price for this expiry. Nothing was saved.' });
      return;
    }
    const a = analyzeChain(chain, istMs(r.meta.asOf));
    if (!Object.keys(a.snapshot.rows).length) {
      setNotice({ kind: 'warn', text: 'No strikes found near spot in this data. Nothing was saved.' });
      return;
    }
    const k = dayKey(chain.symbol, chain.expiry);
    let list = store.loadSnapshots(k);
    const check = liveSaveCheck(list, a.snapshot);
    if (check.ok) {
      list = [...list, a.snapshot];
      store.saveSnapshots(k, list);
    } else {
      setNotice({ kind: 'info', text: check.message });
    }
    setResult(a);
    setSnaps(list);
  };

  const clearAll = () => {
    if (!confirm("Clear today's saved snapshots for every index and expiry? Settings are kept. This cannot be undone.")) return;
    store.clearData();
    setResult(null);
    setSnaps([]);
    setNotice(null);
    setCleared((n) => n + 1);
  };

  const setSetting = (k: 'range' | 'threshold', v: number) => {
    if (!(v > 0)) return;
    store.set(k, String(v));
    (k === 'range' ? setRange : setThreshold)(v);
  };

  const recorded = useMemo(() => (hist?.h ? currentLevels(hist.h, hist.lotSize) : null), [hist]);
  const effRange = hist?.h?.meta.settings.range ?? range; // the shared rule's range when the backend has one
  const view = useMemo(() => (result ? buildView(result, snaps, effRange, recorded) : null), [result, snaps, effRange, recorded]);
  const sourceText = !result || !hist ? '' : recorded
    ? `Levels: recorded by the backend (OI lead ${hist.h!.meta.settings.leadPct}% for ${hist.h!.meta.settings.confirmRefreshes} refreshes, as of ${hist.h!.meta.asOf.slice(11, 16)} IST), same as the Dashboard.`
    : `Levels: top OI of this refresh (nothing recorded by the backend for today${hist.error ? `: ${hist.error}` : ''}).`;

  return (
    <div className="ds osr">
      <LiveToolbar live={live} onRefresh={() => void refresh()}>
        <div className="osr-settings">
          <button className="btn ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Settings</button>
          {showSettings && (
            <div className="card osr-pop">
              {hist?.h ? (
                <span className="muted">Range around spot: {inr(0)(effRange)} pts (shared S/R rule, change it in Dashboard → Settings)</span>
              ) : (
                <label className="field">Range around spot (points)
                  <input type="number" min={100} step={50} value={range} onChange={(e) => setSetting('range', Number(e.target.value))} />
                </label>
              )}
              <label className="field">Change threshold (%)
                <input type="number" min={1} step={1} value={threshold} onChange={(e) => setSetting('threshold', Number(e.target.value))} />
              </label>
              <button className="btn ghost" onClick={clearAll}>Clear today's snapshots</button>
            </div>
          )}
        </div>
      </LiveToolbar>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {sourceText && <p className="muted osr-source">{sourceText}</p>}

      {todays.length > 0 && (
        <div className="osr-chips">
          <span className="muted">Today's snapshots:</span>
          {todays.map((s, i) => (
            <Pill key={s.t} tone={i === 0 ? 'accent' : 'neutral'}>{hm(s.t)} · spot {inr(0)(s.spot)}{i === 0 ? ' (baseline)' : ''}</Pill>
          ))}
        </div>
      )}

      {!view || !result ? (
        live.error ? null : (
          <EmptyState>
            {live.loading
              ? 'Loading option chain…'
              : 'Press Refresh to load the option chain from Dhan. Each refresh saves a snapshot; the first one today is the baseline and later ones are compared with it.'}
          </EmptyState>
        )
      ) : (
        <OsrResult result={result} view={view} range={effRange} threshold={threshold} source="live" />
      )}
    </div>
  );
}
