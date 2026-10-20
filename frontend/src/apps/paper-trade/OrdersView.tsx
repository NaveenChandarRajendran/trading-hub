import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ApiError } from '../../shared/api';
import { inr, useGridTheme } from '../../shared/grid';
import { Alert, EmptyState, Pill } from '../../shared/ui';
import { STATUS_TONE, hms, price, shortName } from './format';
import { api, type Order, type Trade } from './logic/api';
import type { Paper } from './usePaper';

const left = { textAlign: 'left' } as const;
const right = { textAlign: 'right' } as const;
const num = (d: number) => (p: { value: number | null }) => (p.value == null ? '–' : inr(d)(p.value));
const SideCell = ({ value }: ICellRendererParams) => <span className={`pt-side ${value === 'BUY' ? 'buy' : 'sell'}`}>{value}</span>;
const StatusCell = ({ value }: ICellRendererParams<Order>) => <Pill tone={STATUS_TONE[value as Order['status']]}>{value}</Pill>;

const orderCols: ColDef<Order>[] = [
  { field: 'created_at', headerName: 'Time', width: 90, pinned: 'left', cellStyle: left, valueFormatter: (p) => hms(p.value) },
  { field: 'name', headerName: 'Instrument', width: 160, cellStyle: left, tooltipField: 'name', valueFormatter: (p) => (p.data ? shortName(p.data) : '') },
  { field: 'side', headerName: 'Side', width: 70, cellStyle: left, cellRenderer: SideCell },
  { field: 'order_type', headerName: 'Type', width: 80, cellStyle: left },
  { field: 'qty', headerName: 'Qty', width: 80, headerTooltip: 'Units (lots x lot size)' },
  { field: 'price', headerName: 'Price', width: 90, valueFormatter: (p) => price(p.value) },
  { field: 'trigger_price', headerName: 'Trigger', width: 90, valueFormatter: (p) => price(p.value) },
  { field: 'avg_price', headerName: 'Avg fill', width: 95, valueFormatter: (p) => price(p.value),
    headerTooltip: 'Average fill price (depth walk for market orders)' },
  { field: 'status', headerName: 'Status', width: 120, cellStyle: left, cellRenderer: StatusCell },
  { field: 'reason', headerName: 'Note', minWidth: 140, flex: 3, cellStyle: left, tooltipField: 'reason',
    valueGetter: (p) => [p.data?.slippage_capped ? 'Depth ran out: rest filled at the worst visible level.' : '', p.data?.reason].filter(Boolean).join(' ') },
];

const tradeCols: ColDef<Trade>[] = [
  { field: 'time', headerName: 'Time', width: 90, pinned: 'left', cellStyle: left, valueFormatter: (p) => hms(p.value) },
  { field: 'name', headerName: 'Instrument', minWidth: 160, flex: 1, cellStyle: left, tooltipField: 'name', valueFormatter: (p) => (p.data ? shortName(p.data) : '') },
  { field: 'side', headerName: 'Side', width: 80, cellStyle: left, cellRenderer: SideCell },
  { field: 'qty', headerName: 'Qty', width: 80 },
  { field: 'price', headerName: 'Price', width: 90, valueFormatter: num(2) },
  { field: 'value', headerName: 'Value', width: 110, valueFormatter: num(2) },
  { headerName: 'Charges', width: 100, valueGetter: (p) => p.data?.charges.total ?? null, valueFormatter: num(2),
    headerTooltip: 'Brokerage + STT + exchange + SEBI + stamp + GST' },
  { field: 'order_id', headerName: 'Order', width: 150, cellStyle: left },
];

const defaultColDef: ColDef = { sortable: true, resizable: true, cellStyle: right, cellClass: 'num' };

export function OrdersView({ paper }: { paper: Paper }) {
  const gridTheme = useGridTheme();
  const today = paper.today;
  const [picked, setPicked] = useState<string | null>(null); // null = follow the backend's trading day
  const date = picked ?? today;
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState('');
  const ordersGrid = useRef<AgGridReact<Order>>(null);
  const tradesGrid = useRef<AgGridReact<Trade>>(null);
  const live = date === today ? paper.orders : null; // today's book also updates from the live connection

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([api.orders(date, ctrl.signal), api.trades(date, ctrl.signal)])
      .then(([o, t]) => {
        setOrders(o.rows);
        setTrades([...t.rows].sort((a, b) => b.time.localeCompare(a.time)));
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the order book.');
      });
    return () => ctrl.abort();
  }, [date, paper.tradeVersion]);

  const rows = useMemo(
    () => [...(live ? live.values() : orders ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [live, orders],
  );

  return (
    <>
      <section className="card">
        <div className="toolbar">
          <label className="field">Date
            <input type="date" value={date} max={today} onChange={(e) => e.target.value && setPicked(e.target.value)} />
          </label>
          <span className="muted">{rows.length} order{rows.length === 1 ? '' : 's'} · {trades?.length ?? 0} fill{trades?.length === 1 ? '' : 's'}</span>
        </div>
        {error && <div className="pt-gap"><Alert kind="error">{error}</Alert></div>}
      </section>
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Order book</h3>
          <button className="btn ghost" disabled={!rows.length}
            onClick={() => ordersGrid.current?.api.exportDataAsCsv({ fileName: `paper-orders-${date}.csv` })}>CSV</button>
        </div>
        {orders == null && !error ? <p className="muted">Loading…</p> : !rows.length ? <EmptyState>No orders on this day.</EmptyState> : (
          <div className="pt-grid">
            <AgGridReact<Order> ref={ordersGrid} theme={gridTheme} rowData={rows} columnDefs={orderCols} defaultColDef={defaultColDef}
              getRowId={(p) => p.data.id} domLayout="autoHeight" tooltipShowDelay={300} />
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Trades (fills)</h3>
          <button className="btn ghost" disabled={!trades?.length}
            onClick={() => tradesGrid.current?.api.exportDataAsCsv({ fileName: `paper-trades-${date}.csv` })}>CSV</button>
        </div>
        {trades == null && !error ? <p className="muted">Loading…</p> : !trades?.length ? <EmptyState>No trades on this day.</EmptyState> : (
          <div className="pt-grid">
            <AgGridReact<Trade> ref={tradesGrid} theme={gridTheme} rowData={trades} columnDefs={tradeCols} defaultColDef={defaultColDef}
              getRowId={(p) => p.data.id} domLayout="autoHeight" />
          </div>
        )}
      </section>
    </>
  );
}
