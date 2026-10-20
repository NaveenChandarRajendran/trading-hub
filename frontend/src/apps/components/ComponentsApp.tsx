import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import data from './config/constituents.json';
import { buildRows, demoIds, demoQuotes, summarize, type CompRow, type Constituent, type Quote } from './logic/components';
import { createPrevCloseCache, fetchPrevClose, fillPrevCloses, istDate, type History, type PrevCloseCache } from './logic/prevClose';
import './components.css';

const INDEXES = [
  { key: 'BANKNIFTY', label: 'Bank Nifty' },
  { key: 'NIFTY', label: 'Nifty 50' },
] as const;
type Key = (typeof INDEXES)[number]['key'];
type Sort = 'weight' | 'change';
type View = 'tiles' | 'table';

const API = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000';
const nf = (d: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n: number, d = 2) => nf(d).format(n);
const sign = (n: number, d = 2) => `${n > 0 ? '+' : ''}${num(n, d)}`;
const dir = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

/** Indian market hours by the clock (no holiday calendar). */
function marketOpenNow(): boolean {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return ist.getDay() >= 1 && ist.getDay() <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

interface Live { ids: Record<string, number>; quotes: Record<string, Quote>; unknown: string[] }

/** Asks the Python backend, which holds the Dhan token and resolves symbols to security IDs. */
async function fetchQuotes(list: Constituent[]): Promise<Live> {
  const symbols = encodeURIComponent(list.map((c) => c.symbol).join(','));
  let res: Response;
  try {
    res = await fetch(`${API}/api/quotes?symbols=${symbols}`);
  } catch {
    throw new Error('Cannot reach the backend. Start it with: python main.py');
  }
  if (res.status === 401) throw new Error('Dhan token expired. Send a new one to the backend (POST /api/token).');
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.detail ?? `Backend returned HTTP ${res.status}.`);
  }
  return res.json();
}

/** Daily candles for one stock, via the Python backend. */
async function fetchHistory(symbol: string): Promise<History> {
  const res = await fetch(`${API}/api/history?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.detail ?? `History for ${symbol}: HTTP ${res.status}`);
  }
  return res.json();
}

function Tile({ r }: { r: CompRow }) {
  const c = r.changePct;
  const kind = c == null ? (r.ltp != null ? 'pending' : 'empty') : c > 0 ? 'gain' : c < 0 ? 'loss' : '';
  const intensity = c == null ? 0 : Math.min(Math.abs(c) / 2.5, 1);
  return (
    <div
      className={`cp-tile ${kind}`}
      style={{ ['--i' as string]: intensity }}
      title={`${r.name}\nWeight ${num(r.weight)}%${r.contribution != null ? `\nContribution ${sign(r.contribution, 3)}` : ''}`}
    >
      <div className="top"><span className="sym">{r.symbol}</span><span className="wt">{num(r.weight)}%</span></div>
      <div className="bot">
        <span className="ltp">{r.ltp != null ? num(r.ltp) : '—'}</span>
        <span className="chg">{c != null ? `${sign(c)}%` : r.ltp != null ? '—' : ''}</span>
      </div>
    </div>
  );
}

export default function ComponentsApp() {
  const [key, setKey] = useState<Key>('BANKNIFTY');
  const [demo, setDemo] = useState(false);
  const [auto, setAuto] = useState(false);
  const [sort, setSort] = useState<Sort>('weight');
  const [view, setView] = useState<View>('tiles');
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [liveIds, setLiveIds] = useState<Record<string, number>>({});
  const [unknown, setUnknown] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(marketOpenNow());
  const [prev, setPrev] = useState<Record<string, number>>({}); // previous closes {SYMBOL: price}, from the daily cache
  const [prevError, setPrevError] = useState('');
  const cacheRef = useRef<{ day: string; cache: PrevCloseCache } | null>(null);
  const runRef = useRef(0);
  const fillingRef = useRef(false);

  const list = data[key] as Constituent[];
  const ids = useMemo(() => (demo ? demoIds(list, {}) : liveIds), [demo, list, liveIds]);
  // live price from the quote call; previous close from the historical cache (never from ohlc.close)
  const merged = useMemo(() => {
    const out: Record<string, Quote> = {};
    for (const c of list) {
      const id = ids[c.symbol];
      const q = id != null ? quotes[String(id)] : undefined;
      if (q) out[String(id)] = demo ? q : { ltp: q.ltp, prevClose: prev[c.symbol] };
    }
    return out;
  }, [list, ids, quotes, prev, demo]);
  const rows = useMemo(() => {
    const r = buildRows(list, ids, merged);
    return sort === 'change' ? [...r].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999)) : r;
  }, [list, ids, merged, sort]);
  const sum = useMemo(() => summarize(rows), [rows]);
  const maxAbs = Math.max(0.0001, ...rows.map((r) => Math.abs(r.contribution ?? 0)));
  const unchanged = sum.priced - sum.advancing - sum.declining;

  /** One cache object per IST day; a new day starts a fresh cache and deletes older prevClose.* keys. */
  const getCache = useCallback(() => {
    const day = istDate(Date.now() / 1000);
    if (!cacheRef.current || cacheRef.current.day !== day) cacheRef.current = { day, cache: createPrevCloseCache(day) };
    return cacheRef.current.cache;
  }, []);

  /** Fill missing previous closes one by one (about 250 ms apart); the page never waits for this. */
  const ensurePrev = useCallback(async (symbols: string[]) => {
    if (fillingRef.current) return;
    fillingRef.current = true;
    const run = ++runRef.current;
    const cache = getCache();
    setPrev(cache.get());
    let failed = '';
    try {
      await fillPrevCloses(symbols, cache, (s) => fetchPrevClose(fetchHistory, s), {
        delayMs: 250,
        shouldStop: () => runRef.current !== run,
        onUpdate: setPrev,
        onError: (s, e) => { failed ||= e instanceof Error ? e.message : `could not load history for ${s}`; },
      });
    } finally {
      if (runRef.current === run) fillingRef.current = false;
    }
    if (runRef.current === run) setPrevError(failed);
  }, [getCache]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      if (demo) {
        setQuotes(demoQuotes(list, ids));
        setUnknown([]);
        setError('');
      } else {
        const live = await fetchQuotes(list);
        setLiveIds(live.ids);
        setQuotes(live.quotes);
        setUnknown(live.unknown);
        setError('');
        void ensurePrev(list.map((c) => c.symbol));
      }
      setUpdated(new Date().toLocaleTimeString('en-IN'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load prices.');
    } finally {
      setBusy(false);
      setOpen(marketOpenNow());
    }
  }, [demo, list, ids, ensurePrev]);

  // load as soon as the page opens, and again when the index or demo switch changes
  useEffect(() => { runRef.current++; fillingRef.current = false; setQuotes({}); setUnknown([]); setError(''); setPrevError(''); setUpdated(''); void load(); /* eslint-disable-next-line */ }, [key, demo]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [auto, load]);

  const loaded = sum.withPrice > 0;
  const waiting = !demo ? list.filter((c) => !(prev[c.symbol] > 0)).length : 0;

  return (
    <div className="cp">
      <div className="cp-head">
        <div className="cp-seg">
          {INDEXES.map((i) => <button key={i.key} className={key === i.key ? 'on' : ''} onClick={() => setKey(i.key)}>{i.label}</button>)}
        </div>
        <div className="cp-status"><i className={`cp-dot ${open ? 'on' : ''}`} />{open ? 'Market open' : 'Market closed'}{updated && ` · Updated ${updated}`}</div>
        <div className="cp-actions">
          <label><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Auto (10 s)</label>
          <label><input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />Demo</label>
          <button className="cp-btn" onClick={() => void load()} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>

      {error && <div className="cp-alert">{error}</div>}
      {demo && <div className="cp-note">DEMO: made-up prices, only to preview the layout.</div>}
      {!open && loaded && !demo && <div className="cp-note">Market is closed: showing the last available prices.</div>}
      {!demo && loaded && waiting > 0 && (
        <div className="cp-note">
          {prevError ? `Some previous closes could not be loaded (${prevError}). They are retried on the next refresh.` : `Loading previous closes… ${waiting} left. Change % fills in as they arrive.`}
        </div>
      )}
      {unknown.length > 0 && <div className="cp-note">No Dhan ID found for: {unknown.join(', ')}</div>}

      {loaded && sum.priced > 0 && (
        <>
          <div className="cp-stats">
            <div className="cp-stat"><span>Index move (from components)</span><b className={dir(sum.indexMove)}>{sign(sum.indexMove)}%</b></div>
            <div className="cp-stat"><span>Weighted average</span><b className={dir(sum.weightedAvg)}>{sign(sum.weightedAvg)}%</b></div>
            <div className="cp-stat"><span>Simple average</span><b className={dir(sum.simpleAvg)}>{sign(sum.simpleAvg)}%</b></div>
            <div className="cp-stat"><span>Advancing · Declining</span><b><span className="up">▲ {sum.advancing}</span> · <span className="down">▼ {sum.declining}</span></b></div>
          </div>
          <div className="cp-adv" title={`${sum.advancing} up, ${sum.declining} down, ${unchanged} unchanged`}>
            <i className="a" style={{ width: `${(sum.advancing / sum.priced) * 100}%` }} />
            <i className="d" style={{ width: `${(sum.declining / sum.priced) * 100}%`, marginLeft: 'auto' }} />
          </div>
        </>
      )}

      <div className="cp-bar">
        <div className="cp-seg">
          <button className={sort === 'weight' ? 'on' : ''} onClick={() => setSort('weight')}>By weight</button>
          <button className={sort === 'change' ? 'on' : ''} onClick={() => setSort('change')}>By change %</button>
        </div>
        <div className="cp-seg">
          <button className={view === 'tiles' ? 'on' : ''} onClick={() => setView('tiles')}>Heatmap</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
        </div>
        <span className="grow" />
        <small>Change % known for {sum.priced} of {sum.total} stocks · {num(sum.coverage, 1)}% of index weight</small>
      </div>

      {!loaded && !error && <div className="cp-empty">{busy ? 'Loading prices…' : 'No prices yet. Click Refresh.'}</div>}

      {view === 'tiles' && (loaded || error) && <div className="cp-tiles">{rows.map((r) => <Tile key={r.symbol} r={r} />)}</div>}

      {view === 'table' && (loaded || error) && (
        <table className="cp-table">
          <thead><tr><th>#</th><th>Stock</th><th>Weight %</th><th>LTP</th><th>Prev close</th><th>Change %</th><th>Contribution</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.symbol}>
                <td>{i + 1}</td>
                <td><b>{r.name}</b> <span style={{ opacity: 0.55 }}>{r.symbol}{unknown.includes(r.symbol) && ' · no ID'}</span></td>
                <td>{num(r.weight)}</td>
                <td>{r.ltp != null ? num(r.ltp) : '—'}</td>
                <td>{r.prevClose != null ? num(r.prevClose) : '—'}</td>
                <td className={dir(r.changePct ?? 0)}>{r.changePct != null ? `${r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '–'} ${sign(r.changePct)}%` : '—'}</td>
                <td className={dir(r.contribution ?? 0)} style={{ minWidth: 150 }}>
                  {r.contribution != null && (
                    <span style={{ display: 'inline-block', width: `${Math.max(4, (Math.abs(r.contribution) / maxAbs) * 70)}px`, height: 8, borderRadius: 3, marginRight: 8, verticalAlign: 'middle', opacity: 0.55, background: r.contribution >= 0 ? 'var(--cp-gain)' : 'var(--cp-loss)' }} />
                  )}
                  {r.contribution != null ? sign(r.contribution, 3) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="cp-foot">
        Change % = (last price − previous close) ÷ previous close; previous close = last daily candle before today. Contribution = weight × day change, in index % points. Heatmap colour deepens with the size of the move (full colour at ±2.5%).
        {key === 'BANKNIFTY' && ' Bank Nifty list has only the top 10 stocks so far.'}
      </p>
    </div>
  );
}
