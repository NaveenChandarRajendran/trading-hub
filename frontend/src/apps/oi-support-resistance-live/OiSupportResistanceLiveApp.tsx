import { useEffect, useMemo, useState } from 'react';
import { inr } from '../../shared/grid';
import { toOptionChain, nseDate } from '../../shared/dhan/chainAdapter';
import { istMs } from '../../shared/live/liveStatus';
import { useLiveChain } from '../../shared/live/useLiveChain';
import { Alert, EmptyState, Pill } from '../../shared/ui';
import { LiveToolbar } from '../../shared/ui/LiveToolbar';
import { DEFAULT_RANGE, DEFAULT_THRESHOLD } from '../oi-support-resistance/config/settings';
import { analyzeChain, buildView, type Analysis, type Snapshot } from '../oi-support-resistance/logic/levels';
import { dayKey } from '../oi-support-resistance/logic/snapshots';
import { OsrResult, hm } from '../oi-support-resistance/OsrResult';
import { createStore } from '../oi-support-resistance/storage';
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

  const key = live.expiry ? dayKey(live.symbol, nseDate(live.expiry)) : '';
  // Snapshots for the analysed chain, or for the index + expiry picked in the toolbar before any refresh.
  const todays = useMemo(() => (result ? snaps : key ? store.loadSnapshots(key) : []), [result, snaps, key, cleared]);

  useEffect(() => {
    setResult(null);
    setSnaps([]);
    setNotice(null);
  }, [live.symbol, live.expiry]);

  const refresh = async () => {
    setNotice(null);
    const r = await live.refresh();
    if (!r) return; // the toolbar shows the error
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

  const view = useMemo(() => (result ? buildView(result, snaps, range) : null), [result, snaps, range]);

  return (
    <div className="ds osr">
      <LiveToolbar live={live} onRefresh={() => void refresh()}>
        <div className="osr-settings">
          <button className="btn ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Settings</button>
          {showSettings && (
            <div className="card osr-pop">
              <label className="field">Range around spot (points)
                <input type="number" min={100} step={50} value={range} onChange={(e) => setSetting('range', Number(e.target.value))} />
              </label>
              <label className="field">Change threshold (%)
                <input type="number" min={1} step={1} value={threshold} onChange={(e) => setSetting('threshold', Number(e.target.value))} />
              </label>
              <button className="btn ghost" onClick={clearAll}>Clear today's snapshots</button>
            </div>
          )}
        </div>
      </LiveToolbar>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

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
        <OsrResult result={result} view={view} range={range} threshold={threshold} source="live" />
      )}
    </div>
  );
}
