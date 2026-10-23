// Every strike, mirrored like an option chain: CALLS (Prem A, Prem B, Chg, Chg %, Ratio) | Strike | PUTS (mirrored).
import type { RefObject } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { CellClassParams, ColDef, ColGroupDef, ICellRendererParams } from 'ag-grid-community';
import { inr, signed, useGridTheme } from '../../shared/grid';
import { Pill } from '../../shared/ui';
import type { OptSide, SideChange, StrikeChange } from './logic/premium';

const AUTO_HEIGHT_MAX_ROWS = 20; // up to this many strikes the grid sizes to its rows, then 560px and scrolls
const GRID_HEIGHT = 560;

const f2 = inr(2);
const blank = (v: number | null | undefined, fmt: (n: number) => string) => (v == null ? '' : fmt(v));
const tone = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

type Row = StrikeChange;
type Field = keyof Pick<SideChange, 'premA' | 'premB' | 'chg' | 'chgPct' | 'ratio' | 'efficiency'>;

/** "No trades" lives in the Chg cell; Chg % and Ratio stay blank for that side. */
function ChgCell({ data, side }: ICellRendererParams<Row> & { side: OptSide }) {
  const s = data?.[side];
  if (!s) return null;
  if (s.noTrades) return <span className="pa-none">No trades</span>;
  return <span>{signed(2)(s.chg)}</span>;
}

function StrikeCell({ data, atmA, atmB }: ICellRendererParams<Row> & { atmA: number; atmB: number }) {
  if (!data) return null;
  return (
    <span className="pa-strike">
      {inr(0)(data.strike)}
      {data.strike === atmA && <Pill tone="neutral">ATM A</Pill>}
      {data.strike === atmB && <Pill tone="accent">ATM B</Pill>}
    </span>
  );
}

function sideColumns(side: OptSide, mirrored: boolean): ColDef<Row>[] {
  const v = (field: Field) => (p: { data?: Row }) => p.data?.[side][field] ?? null;
  const name = side === 'ce' ? 'Call' : 'Put';
  const cols: ColDef<Row>[] = [
    { colId: `${side}-premA`, headerName: 'Prem A', headerTooltip: `${name} premium in snapshot A`, valueGetter: v('premA'), valueFormatter: (p) => (p.value == null ? '—' : f2(p.value)) },
    { colId: `${side}-premB`, headerName: 'Prem B', headerTooltip: `${name} premium in snapshot B`, valueGetter: v('premB'), valueFormatter: (p) => (p.value == null ? '—' : f2(p.value)) },
    { colId: `${side}-chg`, headerName: 'Chg', headerTooltip: 'Later − earlier premium, points', valueGetter: v('chg'),
      cellRenderer: ChgCell, cellRendererParams: { side }, cellClass: (p: CellClassParams<Row>) => tone(p.value) },
    { colId: `${side}-chgPct`, headerName: 'Chg %', headerTooltip: 'Chg ÷ Prem A × 100', valueGetter: v('chgPct'),
      valueFormatter: (p) => blank(p.value, (n) => `${signed(2)(n)}%`), cellClass: (p: CellClassParams<Row>) => tone(p.value) },
    { colId: `${side}-ratio`, headerName: 'Ratio', headerTooltip: 'Spot points per 1 premium point; lower means the premium moved more',
      valueGetter: v('ratio'), valueFormatter: (p) => (p.data?.[side].noTrades ? '' : p.value == null ? '—' : f2(p.value)) },
    // CSV only: premium points per spot point
    { colId: `${side}-eff`, headerName: `${name} efficiency`, hide: true, valueGetter: v('efficiency') },
  ];
  return mirrored ? [...cols].reverse() : cols;
}

const defaultColDef: ColDef = { sortable: false, resizable: true, flex: 1, minWidth: 92, cellClass: 'num', cellStyle: { textAlign: 'right' }, headerClass: 'ag-right-aligned-header' };

export function FullTable({ gridRef, rows, atmA, atmB, fileName }: {
  gridRef: RefObject<AgGridReact<Row> | null>;
  rows: Row[];
  atmA: number;
  atmB: number;
  fileName: string;
}) {
  const theme = useGridTheme();
  const columns: (ColDef<Row> | ColGroupDef<Row>)[] = [
    { headerName: 'CALLS', headerClass: 'pa-call', children: sideColumns('ce', false) },
    { field: 'strike', headerName: 'Strike', minWidth: 150, cellRenderer: StrikeCell, cellRendererParams: { atmA, atmB },
      cellClass: 'pa-strike-cell', cellStyle: { textAlign: 'center' }, headerClass: 'pa-center-header' },
    { headerName: 'PUTS', headerClass: 'pa-put', children: sideColumns('pe', true) },
  ];
  const autoHeight = rows.length <= AUTO_HEIGHT_MAX_ROWS;
  return (
    <>
      <div className="card-head">
        <h3 className="card-title">All strikes · {rows.length}</h3>
        <button className="btn ghost" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName, allColumns: true })}>CSV</button>
      </div>
      <div className="pa-grid" style={{ height: autoHeight ? undefined : GRID_HEIGHT }}>
        <AgGridReact<Row>
          ref={gridRef}
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          domLayout={autoHeight ? 'autoHeight' : 'normal'}
          getRowId={(p) => String(p.data.strike)}
          rowClassRules={{ 'pa-atm': (p) => p.data?.strike === atmB }}
          onFirstDataRendered={(e) => {
            const n = e.api.getRowNode(String(atmB));
            if (n) e.api.ensureNodeVisible(n, 'middle');
          }}
          suppressMovableColumns
        />
      </div>
    </>
  );
}
