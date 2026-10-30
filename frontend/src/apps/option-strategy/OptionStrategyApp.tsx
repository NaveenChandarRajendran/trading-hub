import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ColGroupDef, ValueFormatterParams } from 'ag-grid-community';
import { inr, useGridTheme } from '../../shared/grid';
import { SYMBOLS, buildOptionChainUrl, upcomingExpiries } from './config/expiries';
import { ChainParseError, parseOptionChain, type OptionChain } from './logic/optionChain';
import { analyzeOptionChain, type MainRow } from './logic/oiCalculation';

const pinned = (p: ValueFormatterParams) => !!p.node?.rowPinned;
const num = (d = 0): ColDef<MainRow>['valueFormatter'] => (p) => inr(d)(p.value);
const ltp: ColDef<MainRow>['valueFormatter'] = (p) => (p.value ? inr(2)(p.value) : '-');

const columns: (ColDef<MainRow> | ColGroupDef<MainRow>)[] = [
  {
    headerName: 'CALLS',
    children: [
      { field: 'callOi', headerName: 'OI', valueFormatter: num(), cellClass: 'c-call' },
      { field: 'callChgOi', headerName: 'Chng in OI', valueFormatter: num(), cellClass: 'c-call' },
      { field: 'callNet', headerName: 'OI + Chng in OI', valueFormatter: num(), cellClass: 'c-net' },
      { field: 'netTotal', headerName: 'Call Net OI + Put Net OI', valueFormatter: num(), cellClass: 'c-call' },
      { field: 'callPct', headerName: 'Call % (Col 3/4)', cellClass: 'c-call', valueFormatter: (p) => (pinned(p) ? inr(0)(p.value) : inr(3)(p.value)) },
      { field: 'putPct', headerName: 'Put % (Col 14/4)', cellClass: 'c-call', valueFormatter: (p) => (pinned(p) ? inr(0)(p.value) : inr(3)(p.value)) },
      { field: 'interval', headerName: 'Interval', valueFormatter: num(), cellClass: 'c-call' },
      { field: 'ratio', headerName: 'Ratio', valueFormatter: (p) => inr(pinned(p) ? 0 : 4)(p.value), cellClass: 'c-call' },
      { field: 'average', headerName: 'Average', valueFormatter: (p) => inr(2)(p.value), cellClass: 'c-avg' },
      { field: 'callLtp', headerName: 'LTP', valueFormatter: ltp },
    ],
  },
  { field: 'strike', headerName: 'Strike', pinned: 'left', width: 100, valueFormatter: num(), cellClass: 'c-strike' },
  {
    headerName: 'PUTS',
    children: [
      { field: 'putLtp', headerName: 'LTP', valueFormatter: ltp },
      { field: 'putNet', headerName: 'OI + Chng in OI', valueFormatter: num(), cellClass: 'c-net' },
      { field: 'putChgOi', headerName: 'Chng in OI', valueFormatter: num(), cellClass: 'c-put' },
      { field: 'putOi', headerName: 'OI', valueFormatter: num(), cellClass: 'c-put' },
    ],
  },
];

const defaultColDef: ColDef = { sortable: true, resizable: true, flex: 1, minWidth: 115, wrapHeaderText: true, autoHeaderHeight: true, cellStyle: { textAlign: 'right' }, headerClass: 'ag-right-aligned-header' };

/** Average vs spot: above = bullish (green up arrow), below = bearish (red down arrow). */
function Pill({ value, spot }: { value: number; spot: number }) {
  const d = value - spot;
  const kind = d > 0 ? 'bull' : d < 0 ? 'bear' : 'flat';
  return <span className={`pill ${kind}`}>{d > 0 ? '▲' : d < 0 ? '▼' : '–'} {inr(2)(value)}</span>;
}

export default function OptionStrategyApp() {
  const gridTheme = useGridTheme();
  const gridRef = useRef<AgGridReact<MainRow>>(null);

  const [symbol, setSymbol] = useState<string>(SYMBOLS[1].value);
  const expiries = useMemo(() => upcomingExpiries(symbol), [symbol]);
  const [expiryPick, setExpiryPick] = useState('');
  const expiry = expiries.includes(expiryPick) ? expiryPick : expiries[0] ?? '';
  const url = expiry ? buildOptionChainUrl(symbol, expiry) : '';

  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [chain, setChain] = useState<OptionChain | null>(null);

  const calc = useMemo(() => (chain ? analyzeOptionChain(chain) : null), [chain]);

  const calculate = () => {
    try {
      setChain(parseOptionChain(raw));
      setError('');
    } catch (e) {
      setChain(null);
      setError(e instanceof ChainParseError ? e.message : 'Something went wrong while reading the data.');
    }
  };

  const f = (n: number, d = 0) => inr(d)(n);

  return (
    <>
      <section className="card">
        <h2>1 · Generate API link</h2>
        <div className="row">
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
          <input className="url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(url)}>Copy</button>
          <a className="btn" href={url} target="_blank" rel="noreferrer">Open</a>
        </div>
        <p className="muted">Open the link in your browser (visit nseindia.com first if it shows an empty page), select all, copy, and paste below.</p>
      </section>

      <section className="card">
        <h2>2 · Paste response</h2>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the full JSON here…" spellCheck={false} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={calculate} disabled={!raw.trim()}>Calculate</button>
          <button className="btn ghost" onClick={() => { setRaw(''); setChain(null); setError(''); }}>Clear</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {chain && calc && (
        <>
          <section className="card asof">
            <span>As on <b>{chain.timestamp} IST</b></span>
            <span>{chain.symbol} <b>{f(chain.underlying, 2)}</b></span>
            <span>Expiry <b>{chain.expiry}</b></span>
            <span>ATM <b>{f(chain.atmStrike)}</b></span>
          </section>

          <div className="two">
            <section className="card">
              <h2>Overall OI summary</h2>
              <table className="t">
                <thead><tr><th></th><th>OI</th><th>Chng in OI</th><th>Total</th></tr></thead>
                <tbody>
                  <tr className="rp"><td>Put</td><td>{f(calc.summary.putOi)}</td><td>{f(calc.summary.putChgOi)}</td><td>{f(calc.summary.putTotal)}</td></tr>
                  <tr className="rc"><td>Call</td><td>{f(calc.summary.callOi)}</td><td>{f(calc.summary.callChgOi)}</td><td>{f(calc.summary.callTotal)}</td></tr>
                </tbody>
              </table>
              <div className="final"><span>PCR</span><span>{f(calc.summary.pcr, 2)}</span></div>
              <div className="final"><span>Spot</span><span>{f(chain.underlying, 2)}</span></div>
            </section>

            <section className="card">
              <h2>Strike-window averages</h2>
              <table className="t">
                <thead><tr><th>Window</th><th>Strikes used</th><th>From</th><th>To</th><th>Average</th></tr></thead>
                <tbody>
                  {[calc.win.overall!, ...calc.win.windows].map((w) => (
                    <tr key={w.label}>
                      <td>{w.label === 'OVER ALL' ? 'Over all' : w.label.toLowerCase()}</td><td>{w.strikeCount}</td>
                      <td className="sk">{f(w.fromStrike)}</td><td className="sk">{f(w.toStrike)}</td>
                      <td><Pill value={w.average} spot={chain.underlying} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="final">
                <span>Average (5, 10, 15, 20, 25)</span>
                <Pill value={calc.win.overallAverage} spot={chain.underlying} />
              </div>
              {/* owner 30-Oct-2026: OI build-up leads; the father's final average stays below it */}
              <div className="final">
                <span>
                  OI build-up: puts {calc.verdict.putShare == null ? '—' : `${f(calc.verdict.putShare, 0)}%`} of OI + change,
                  {calc.verdict.morePutsAdded ? ' more puts' : ' more calls'} added today (puts = support)
                </span>
                <span className={`verdict ${calc.verdict.verdict}`}>{calc.verdict.verdict}</span>
              </div>
              <div className="final">
                <span className={calc.verdict.points >= 0 ? 'pos' : 'neg'}>
                  Father's sheet: final average {calc.verdict.points >= 0 ? '+' : ''}{f(calc.verdict.points, 2)} pts vs spot
                </span>
                <span className={`verdict ${calc.sheetVerdict}`}>{calc.sheetVerdict}</span>
              </div>
            </section>
          </div>

          <section className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>{chain.symbol} · OI &amp; OI change · {chain.strikes.length} strikes</h2>
              <button className="btn" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: `${chain.symbol}-${chain.expiry}-oi.csv` })}>Download CSV</button>
            </div>
            <div style={{ height: 640 }}>
              <AgGridReact<MainRow>
                ref={gridRef}
                theme={gridTheme}
                rowData={calc.rows}
                columnDefs={columns}
                defaultColDef={defaultColDef}
                pinnedBottomRowData={[{ ...calc.totals } as unknown as MainRow]}
                rowClassRules={{ 'r-atm': (p) => p.data?.strike === chain.atmStrike }}
                suppressMovableColumns
              />
            </div>
            <p className="muted">Bottom row: totals. Average and Strike show the mean, as in the Excel sheet.</p>
          </section>
        </>
      )}
    </>
  );
}
