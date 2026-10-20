import { useCallback, useEffect, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';
import { inr, useGridTheme } from '../../shared/grid';
import { SYMBOLS } from '../option-strategy/config/expiries';
import { DEFAULT_BACKEND, INTERVALS, REFRESH_MS } from './config/settings';
import { ApiError, fetchExpiries, fetchTrendingOi, strengthDots, type ToiResponse, type ToiRow } from './logic/api';

const LS_BACKEND = 'trending-oi.backend';
type Cell = ICellRendererParams<ToiRow>;

const num = (d = 0) => (p: ValueFormatterParams<ToiRow>) => inr(d)(p.value);
const posNeg = (p: { value?: number }) => ((p.value ?? 0) > 0 ? 'pos' : (p.value ?? 0) < 0 ? 'neg' : '');

function TimeCell({ data, value }: Cell) {
  return <span>{value}{data?.live && <span className="pill live">LIVE</span>}</span>;
}

/** Index broke the day's high (green) or low (red) among the rows shown. */
function SpotBreakCell({ data }: Cell) {
  const b = data?.dayHLBreak;
  if (!b) return <span>-</span>;
  return <span className={`pill sm ${b.type === 'DHB' ? 'bull' : 'bear'}`}>{b.type === 'DHB' ? 'D.H.B.' : 'D.L.B.'} ({inr(2)(b.level)})</span>;
}

function StrengthCell({ value }: Cell) {
  const pct = Number(value);
  const kind = pct >= 0 ? 'bull' : 'bear';
  const dots = strengthDots(pct);
  return (
    <span>
      <span className={`pill sm ${kind}`}>{pct > 0 ? '+' : ''}{Math.round(pct)}%</span>
      <span className="dots">{[0, 1, 2].map((i) => <i key={i} className={i < dots ? `on ${kind}` : ''} />)}</span>
    </span>
  );
}

function DirectionCell({ data }: Cell) {
  if (!data) return null;
  const up = data.directionChg >= 0;
  return <span className={`pill sm ${up ? 'bull' : 'bear'}`}>{up ? '↑' : '↓'} {inr(2)(data.directionPct)} %</span>;
}

function DiffBreakCell({ value }: Cell) {
  if (!value) return <span>-</span>;
  return <span className={`pill sm ${value === 'HIGH' ? 'bull' : 'bear'}`}>Day {value === 'HIGH' ? 'High' : 'Low'} Break</span>;
}

function SentimentCell({ value }: Cell) {
  return <span className={`pill ${value === 'Bullish' ? 'bull' : 'bear'}`}>{value}</span>;
}

const left = { textAlign: 'left' } as const;

const columns: ColDef<ToiRow>[] = [
  { field: 'date', headerName: 'Date', width: 110, cellStyle: left, headerClass: '' },
  { field: 'time', headerName: 'Time', width: 130, pinned: 'left', cellStyle: left, headerClass: '', cellRenderer: TimeCell },
  { field: 'ltp', headerName: 'LTP', valueFormatter: num(2) },
  { field: 'dayHLBreak', headerName: 'Day H/L Break', minWidth: 150, cellRenderer: SpotBreakCell },
  { field: 'callChg', headerName: 'Chng. In Call OI', valueFormatter: num() },
  { field: 'putChg', headerName: 'Chng. In Put OI', valueFormatter: num() },
  { field: 'diffOi', headerName: 'Diff. in OI', valueFormatter: num(), cellClass: posNeg },
  { field: 'strengthPct', headerName: 'Strength', minWidth: 130, cellRenderer: StrengthCell },
  { field: 'directionPct', headerName: 'Direction of chng.', minWidth: 140, cellRenderer: DirectionCell },
  { field: 'directionChg', headerName: 'Chng. In Direction', valueFormatter: num(), cellClass: posNeg },
  { field: 'callLtpTotal', headerName: 'Total Call LTP', valueFormatter: num(2) },
  { field: 'callLtpChg', headerName: 'Call LTP chng.', valueFormatter: num(2), cellClass: posNeg },
  { field: 'cePeLtpChg', headerName: 'CE + PE LTP Chng.', valueFormatter: num(2), cellClass: posNeg },
  { field: 'putLtpChg', headerName: 'Put LTP chng.', valueFormatter: num(2), cellClass: posNeg },
  { field: 'putLtpTotal', headerName: 'Total Put LTP', valueFormatter: num(2) },
  { field: 'netPcr', headerName: 'Net PCR', valueFormatter: (p) => (p.value == null ? '-' : inr(2)(p.value)) },
  { field: 'dayHLDiffBreak', headerName: 'Day High/Low Diff. in OI', minWidth: 160, cellRenderer: DiffBreakCell },
  { field: 'sentiment', headerName: 'Sentiment', cellRenderer: SentimentCell },
];

const defaultColDef: ColDef = { resizable: true, flex: 1, minWidth: 115, wrapHeaderText: true, autoHeaderHeight: true, cellStyle: { textAlign: 'right' }, headerClass: 'ag-right-aligned-header' };

export default function TrendingOiApp() {
  const gridTheme = useGridTheme();
  const gridRef = useRef<AgGridReact<ToiRow>>(null);

  const [backend, setBackend] = useState(() => {
    try { return localStorage.getItem(LS_BACKEND) || DEFAULT_BACKEND; } catch { return DEFAULT_BACKEND; }
  });
  const [backendDraft, setBackendDraft] = useState(backend);
  const [symbol, setSymbol] = useState<string>(SYMBOLS[1].value);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [interval, setIntervalMin] = useState<number>(5);
  const [auto, setAuto] = useState(true);
  const [data, setData] = useState<ToiResponse | null>(null);
  const [error, setError] = useState('');

  const saveBackend = () => {
    const v = backendDraft.trim() || DEFAULT_BACKEND;
    setBackend(v);
    try { localStorage.setItem(LS_BACKEND, v); } catch { /* storage blocked: keep it for this session only */ }
  };

  // Expiry list for the chosen index, nearest first (the nearest is selected).
  useEffect(() => {
    const ac = new AbortController();
    setExpiries([]); setExpiry(''); setData(null);
    fetchExpiries(backend, symbol, ac.signal)
      .then((list) => { setExpiries(list); setExpiry(list[0] ?? ''); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load expiries.'); });
    return () => ac.abort();
  }, [backend, symbol]);

  const load = useCallback((signal?: AbortSignal) => {
    if (!expiry) return Promise.resolve();
    return fetchTrendingOi(backend, symbol, expiry, interval, signal)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load data.'); });
  }, [backend, symbol, expiry, interval]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    const id = auto ? window.setInterval(() => load(ac.signal), REFRESH_MS) : undefined;
    return () => { ac.abort(); if (id) window.clearInterval(id); };
  }, [load, auto]);

  const meta = data?.meta;
  const rows = data?.rows ?? [];

  return (
    <>
      <section className="card">
        <h2>Live data</h2>
        <div className="row">
          <label className="field">Name
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!expiries.length}>
              {expiries.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="field">Time interval
            <select value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
              {INTERVALS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={() => load()} disabled={!expiry}>Refresh</button>
          <label className="field">Backend URL
            <input className="url" value={backendDraft} onChange={(e) => setBackendDraft(e.target.value)} onBlur={saveBackend}
              onKeyDown={(e) => e.key === 'Enter' && saveBackend()} spellCheck={false} />
          </label>
          <label className="field">Auto-refresh
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        {meta?.tokenExpired && <p className="error">Dhan token expired. Send a new one to the backend (POST /api/token, see its README).</p>}
        {meta?.lastError && !meta.tokenExpired && <p className="error">Last Dhan error: {meta.lastError}</p>}
        {meta?.message && <p className="muted">{meta.message}</p>}
      </section>

      {meta?.spot != null && (
        <section className="card asof">
          <span>As on <b>{meta.asOf} IST</b></span>
          <span>{meta.symbol} <b>{inr(2)(meta.spot)}</b></span>
          <span>Expiry <b>{meta.expiry}</b></span>
          <span>Strikes <b>{meta.strikeCount}</b></span>
          {!meta.marketOpen && <span className="pill flat">Market closed</span>}
        </section>
      )}

      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{meta?.symbol ?? symbol} · Trending OI · {interval} min</h2>
          <button className="btn" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: `${symbol}-${expiry}-trending-oi-${interval}m.csv` })} disabled={!rows.length}>Download CSV</button>
        </div>
        <div style={{ height: 640 }}>
          <AgGridReact<ToiRow>
            ref={gridRef}
            theme={gridTheme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.date + p.data.time}
            rowClassRules={{ 'r-live': (p) => !!p.data?.live }}
            suppressMovableColumns
          />
        </div>
        {meta && meta.strikes.length > 0 && <p className="muted">Selected strikes: {meta.strikes.join(', ')}</p>}
        <p className="muted">
          Change in OI = OI minus the previous day's settled OI, summed over a fixed set of strikes around ATM.
          Rows exist only from the time the backend started today.
        </p>
      </section>
    </>
  );
}
