import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { CellClassParams, ColDef, ColGroupDef, ValueFormatterParams } from 'ag-grid-community';
import { toOptionChain } from '../../shared/dhan/chainAdapter';
import { useLiveChain } from '../../shared/live/useLiveChain';
import { inr, signed, useGridTheme } from '../../shared/grid';
import { EmptyState, Pill, Stat, type Tone } from '../../shared/ui';
import { LiveToolbar } from '../../shared/ui/LiveToolbar';
import { analyzeOptionChain, type MainRow } from '../option-strategy/logic/oiCalculation';
import './oi-change-live.css';

const pinned = (p: ValueFormatterParams) => !!p.node?.rowPinned;
const num = (d = 0): ColDef<MainRow>['valueFormatter'] => (p) => inr(d)(p.value);
const chg: ColDef<MainRow>['valueFormatter'] = (p) => signed(0)(p.value);
const ltp: ColDef<MainRow>['valueFormatter'] = (p) => (p.value ? inr(2)(p.value) : '–');
const posNeg = (p: CellClassParams<MainRow>) => (p.value > 0 ? 'num up' : p.value < 0 ? 'num down' : 'num');
const pct: ColDef<MainRow>['valueFormatter'] = (p) => (pinned(p) ? inr(0)(p.value) : inr(3)(p.value));

const columns: (ColDef<MainRow> | ColGroupDef<MainRow>)[] = [
  {
    headerName: 'Calls',
    headerClass: 'ocl-call',
    children: [
      { field: 'callOi', headerName: 'OI', headerTooltip: 'Call OI (contracts)', valueFormatter: num() },
      { field: 'callChgOi', headerName: 'Chg OI', headerTooltip: 'Change in call OI vs previous-day settled OI (contracts)', valueFormatter: chg, cellClass: posNeg },
      { field: 'callNet', headerName: 'OI + Chg', headerTooltip: 'Call OI + change in call OI (col 3)', valueFormatter: num() },
      { field: 'netTotal', headerName: 'Net Total', headerTooltip: 'Call net OI + put net OI (col 4)', valueFormatter: num() },
      { field: 'callPct', headerName: 'Call %', headerTooltip: 'Call net / net total (col 3 / 4)', valueFormatter: pct },
      { field: 'putPct', headerName: 'Put %', headerTooltip: 'Put net / net total (col 14 / 4)', valueFormatter: pct },
      { field: 'interval', headerName: 'Interval', valueFormatter: num() },
      { field: 'ratio', headerName: 'Ratio', headerTooltip: 'Call % × interval', valueFormatter: (p) => inr(pinned(p) ? 0 : 4)(p.value) },
      { field: 'average', headerName: 'Average', headerTooltip: 'Strike − ratio', valueFormatter: num(2) },
      { field: 'callLtp', headerName: 'LTP', valueFormatter: ltp },
    ],
  },
  { field: 'strike', headerName: 'Strike', pinned: 'left', width: 100, valueFormatter: num(), cellClass: 'ocl-strike' },
  {
    headerName: 'Puts',
    headerClass: 'ocl-put',
    children: [
      { field: 'putLtp', headerName: 'LTP', valueFormatter: ltp },
      { field: 'putNet', headerName: 'OI + Chg', headerTooltip: 'Put OI + change in put OI (col 14)', valueFormatter: num() },
      { field: 'putChgOi', headerName: 'Chg OI', headerTooltip: 'Change in put OI vs previous-day settled OI (contracts)', valueFormatter: chg, cellClass: posNeg },
      { field: 'putOi', headerName: 'OI', headerTooltip: 'Put OI (contracts)', valueFormatter: num() },
    ],
  },
];

const defaultColDef: ColDef = { sortable: true, resizable: true, flex: 1, minWidth: 100, cellClass: 'num', headerClass: 'ag-right-aligned-header', cellStyle: { textAlign: 'right' } };

/** Average vs spot: above = bullish, below = bearish. */
const toneVs = (value: number, spot: number): Tone => (value > spot ? 'up' : value < spot ? 'down' : 'neutral');

function AvgPill({ value, spot }: { value: number; spot: number }) {
  const t = toneVs(value, spot);
  return <Pill tone={t}>{t === 'up' ? '▲' : t === 'down' ? '▼' : '–'} {inr(2)(value)}</Pill>;
}

export default function OiChangeLiveApp() {
  const gridTheme = useGridTheme();
  const gridRef = useRef<AgGridReact<MainRow>>(null);
  const live = useLiveChain({ appId: 'oi-change-live' });
  const { data } = live;

  const chain = useMemo(() => (data ? toOptionChain(data, live.expiries) : null), [data, live.expiries]);
  const calc = useMemo(() => (chain && chain.strikes.length ? analyzeOptionChain(chain) : null), [chain]);
  const f = (n: number, d = 0) => inr(d)(n);

  let body;
  if (!chain) {
    body = live.error ? null : <EmptyState>{live.loading || live.expiries.length === 0 ? 'Loading option chain…' : 'Press Refresh to load the option chain.'}</EmptyState>;
  } else if (!calc) {
    body = <EmptyState>Dhan returned no strikes for this expiry. Pick another expiry.</EmptyState>;
  } else {
    const spot = chain.underlying;
    const { verdict, points } = calc.verdict;
    body = (
      <>
        <div className="stats">
          <Stat label={`${chain.symbol} spot`} value={f(spot, 2)} delta={`ATM ${f(chain.atmStrike)}`} />
          <Stat label="PCR (OI + chg)" value={f(calc.summary.pcr, 2)} />
          <Stat label="Final average (5–25)" value={f(calc.win.overallAverage, 2)}
            delta={`${signed(2)(points)} pts vs spot`} tone={toneVs(calc.win.overallAverage, spot)} />
          <Stat label="Verdict (OI build-up)" value={<span className={`ocl-verdict ${verdict === 'BULLISH' ? 'up' : verdict === 'BEARISH' ? 'down' : 'neutral'}`}>{verdict}</span>}
            delta={calc.verdict.putShare == null ? undefined : `puts ${f(calc.verdict.putShare, 0)}% · puts = support`} />
        </div>

        <div className="split">
          <section className="card">
            <div className="card-head"><h2 className="card-title">Overall OI summary (contracts)</h2></div>
            <table className="t">
              <thead><tr><th></th><th>OI</th><th>Chg OI</th><th>Total</th></tr></thead>
              <tbody>
                <tr><td className="ocl-put-label">Put</td><td>{f(calc.summary.putOi)}</td><td>{signed(0)(calc.summary.putChgOi)}</td><td>{f(calc.summary.putTotal)}</td></tr>
                <tr><td className="ocl-call-label">Call</td><td>{f(calc.summary.callOi)}</td><td>{signed(0)(calc.summary.callChgOi)}</td><td>{f(calc.summary.callTotal)}</td></tr>
              </tbody>
            </table>
            <p className="card-foot">PCR = (put OI + put chg) / (call OI + call chg) = {f(calc.summary.pcr, 2)}</p>
          </section>

          <section className="card">
            <div className="card-head"><h2 className="card-title">Strike-window averages</h2></div>
            <table className="t">
              <thead><tr><th>Window</th><th>Strikes</th><th>From</th><th>To</th><th>Average</th></tr></thead>
              <tbody>
                {[calc.win.overall!, ...calc.win.windows].map((w) => (
                  <tr key={w.label}>
                    <td>{w.label === 'OVER ALL' ? 'Over all' : `ATM ± ${w.label.split(' ')[0]}`}</td><td>{w.strikeCount}</td>
                    <td>{f(w.fromStrike)}</td><td>{f(w.toStrike)}</td>
                    <td><AvgPill value={w.average} spot={spot} /></td>
                  </tr>
                ))}
                <tr className="hl">
                  <td>Final (mean of 5–25)</td><td></td><td></td><td></td>
                  <td><AvgPill value={calc.win.overallAverage} spot={spot} /></td>
                </tr>
              </tbody>
            </table>
            <p className="card-foot">Verdict = OI build-up: puts 55%+ of OI + change and more puts added today = Bullish (support); the mirror = Bearish; else Neutral. The final average vs spot is the course sheet's number.</p>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{chain.symbol} · {chain.expiry} · OI &amp; OI change · {chain.strikes.length} strikes</h2>
            <button className="btn ghost" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: `${chain.symbol}-${chain.expiry}-oi-live.csv` })}>CSV</button>
          </div>
          <div className="ocl-grid">
            <AgGridReact<MainRow>
              ref={gridRef}
              theme={gridTheme}
              rowData={calc.rows}
              columnDefs={columns}
              defaultColDef={defaultColDef}
              pinnedBottomRowData={[{ ...calc.totals } as unknown as MainRow]}
              rowClassRules={{ 'ocl-atm': (p) => p.data?.strike === chain.atmStrike }}
              getRowId={(p) => String(p.data.strike)}
              onFirstDataRendered={(e) => {
                const atm = e.api.getRowNode(String(chain.atmStrike)); // start at the money; later refreshes keep the scroll
                if (atm) e.api.ensureNodeVisible(atm, 'middle');
              }}
              suppressMovableColumns
            />
          </div>
          <p className="card-foot">
            Live from Dhan. OI in contracts (Dhan units ÷ lot size {data!.meta.lotSize}); change in OI is against Dhan's
            previous-day settled OI, so it can differ slightly from NSE. Bottom row: totals; Average and Strike show the mean,
            as in the Excel sheet.
          </p>
        </section>
      </>
    );
  }

  return (
    <div className="ds ocl">
      <LiveToolbar live={live} />
      {body}
    </div>
  );
}
