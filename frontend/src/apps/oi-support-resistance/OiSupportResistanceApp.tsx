import { useEffect, useMemo, useState } from 'react';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Pill } from '../../shared/ui';
import { SYMBOLS, buildOptionChainUrl, upcomingExpiries } from '../option-strategy/config/expiries';
import { ChainParseError, parseOptionChain, type OptionChain } from '../option-strategy/logic/optionChain';
import { copyText } from '../../shared/clipboard';
import { DEFAULT_RANGE, DEFAULT_THRESHOLD } from './config/settings';
import { analyzeChain, buildView, type Analysis, type Snapshot } from './logic/levels';
import { OsrResult, hm } from './OsrResult';
import { checkPaste, dayKey } from './logic/snapshots';
import { store } from './storage';
import './oi-sr.css';

const readNum = (k: string, fallback: number) => Number(store.get(k)) || fallback;

export default function OiSupportResistanceApp() {
  const [symbol, setSymbol] = useState<string>(() => {
    const s = store.get('symbol');
    return SYMBOLS.some((x) => x.value === s) ? s! : SYMBOLS[0].value;
  });
  const expiries = useMemo(() => upcomingExpiries(symbol), [symbol]);
  const [expiryPick, setExpiryPick] = useState('');
  const expiry = expiries.includes(expiryPick) ? expiryPick : expiries[0] ?? '';
  const url = expiry ? buildOptionChainUrl(symbol, expiry) : '';
  useEffect(() => store.set('symbol', symbol), [symbol]);

  const [range, setRange] = useState(() => readNum('range', DEFAULT_RANGE));
  const [threshold, setThreshold] = useState(() => readNum('threshold', DEFAULT_THRESHOLD));
  const [showSettings, setShowSettings] = useState(false);

  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'warn' | 'info'; text: string } | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [cleared, setCleared] = useState(0); // bumps after "Clear today's data" so the paste list re-reads storage

  // Pastes for the analysed chain, or for the index + expiry picked in the toolbar before any analysis.
  const todays = useMemo(
    () => (result ? snaps : store.loadSnapshots(dayKey(symbol, expiry))),
    [result, snaps, symbol, expiry, cleared],
  );

  const analyze = (text: string, save: boolean) => {
    setError('');
    setNotice(null);
    let chain: OptionChain;
    try {
      chain = parseOptionChain(text);
    } catch (e) {
      setError(e instanceof ChainParseError ? e.message : 'Something went wrong while reading the data.');
      return;
    }
    if (chain.underlying <= 0) return setError('Could not find the spot price (underlyingValue) in this JSON.');
    const a = analyzeChain(chain);
    if (!Object.keys(a.snapshot.rows).length) return setError('No strikes found near spot in this data.');
    store.set('last', text);

    const key = dayKey(chain.symbol, chain.expiry);
    let list = store.loadSnapshots(key);
    if (save) {
      const check = checkPaste(list, a.snapshot);
      if (!check.ok) return setNotice({ kind: 'warn', text: check.message });
      list = [...list, a.snapshot];
      store.saveSnapshots(key, list);
    } else {
      setNotice({ kind: 'info', text: 'Showing your last paste. It was not saved again.' });
    }
    setResult(a);
    setSnaps(list);
    if (SYMBOLS.some((s) => s.value === chain.symbol)) {
      setSymbol(chain.symbol);
      setExpiryPick(chain.expiry);
    }
  };

  const loadLast = () => {
    const last = store.get('last');
    if (!last) return setError('No saved paste found yet.');
    setRaw(last);
    analyze(last, false);
  };

  const clearAll = () => {
    if (!confirm("Clear today's option chain data (all pastes and the last paste)? Settings are kept. This cannot be undone.")) return;
    store.clearData();
    setRaw('');
    setResult(null);
    setSnaps([]);
    setError('');
    setNotice(null);
    setCleared((n) => n + 1);
  };

  const view = useMemo(() => (result ? buildView(result, snaps, range) : null), [result, snaps, range]);

  const setSetting = (k: 'range' | 'threshold', v: number) => {
    if (!(v > 0)) return;
    store.set(k, String(v));
    (k === 'range' ? setRange : setThreshold)(v);
  };

  const last = todays[todays.length - 1];

  return (
    <div className="ds osr">
      <section className="card">
        <div className="toolbar">
          <label className="field">Index
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry
            <select value={expiry} onChange={(e) => setExpiryPick(e.target.value)}>
              {expiries.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="field osr-url">NSE link
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button className="btn" onClick={() => void copyText(url)} disabled={!url}>Copy</button>
          <a className="btn" href={url} target="_blank" rel="noreferrer">Open</a>
          <div className="toolbar-end">
            <span className="status">
              <span className={`dot ${last ? 'live' : ''}`} />
              {last ? `${todays.length} paste${todays.length > 1 ? 's' : ''} today · last ${hm(last.t)} IST` : 'No pastes yet today'}
            </span>
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
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Paste option chain</h3></div>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the full JSON response from option-chain-v3 here…" spellCheck={false} />
        <div className="osr-actions">
          <button className="btn primary" onClick={() => analyze(raw, true)} disabled={!raw.trim()}>Analyze</button>
          <button className="btn" onClick={loadLast}>Load last paste</button>
          <button className="btn ghost" onClick={clearAll}>Clear today's data</button>
        </div>
        <div className="osr-stack">
          {error && <Alert kind="error">{error}</Alert>}
          {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
        </div>
        {todays.length > 0 && (
          <div className="osr-chips">
            <span className="muted">Today's pastes:</span>
            {todays.map((s, i) => (
              <Pill key={s.t} tone={i === 0 ? 'accent' : 'neutral'}>{hm(s.t)} · spot {inr(0)(s.spot)}{i === 0 ? ' (baseline)' : ''}</Pill>
            ))}
          </div>
        )}
        <details>
          <summary>Where do I get this JSON?</summary>
          <ol>
            <li>Pick the index and expiry above, then click Open (visit nseindia.com first if it shows an empty page).</li>
            <li>Select all of the page's JSON, copy it and paste it above.</li>
            <li>Click Analyze. Your first paste of the day is the baseline; repeat later to see how OI changed.</li>
          </ol>
        </details>
      </section>

      {!view || !result ? (
        <EmptyState>Paste the option chain and click Analyze. The first paste of the day becomes the baseline; later pastes are compared with it.</EmptyState>
      ) : (
        <OsrResult result={result} view={view} range={range} threshold={threshold} source="paste" />
      )}
    </div>
  );
}
