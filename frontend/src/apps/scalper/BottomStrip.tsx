// Power Scalper account strip: Positions / Orders, Open / Closed counts, today's Scalper P&L (live) and funds.
// Collapsed to its header on every load so the charts get the full height; ▴ (or a tab) opens it, its top edge
// drags to resize (the height is remembered in this browser).
import { useState, type CSSProperties } from 'react';
import { ApiError } from '../../shared/api';
import { EmptyState, Pill, Segmented } from '../../shared/ui';
import { STATUS_TONE, hms, price, rupees, shortName, signedRupees, toneOf } from '../paper-trade/format';
import { keyOf } from '../paper-trade/logic/feed';
import { STORAGE_PREFIX } from './config/settings';
import { api, type Order, type Position } from './logic/api';
import { STRIP_DEFAULT, clampStrip } from './logic/layout';
import type { Scalper } from './useScalper';

const TABS = [{ value: 'positions', label: 'Positions' }, { value: 'orders', label: 'Orders' }] as const;
const OPEN = (o: Order) => o.status === 'PENDING' || o.status === 'TRIGGERED';

export const liveLtp = (sc: Scalper, p: Position) => sc.ticks.get(keyOf('NSE_FNO', p.security_id))?.ltp ?? p.ltp;
export const liveUnrealized = (sc: Scalper, p: Position) => {
  const ltp = liveLtp(sc, p);
  return ltp != null && p.open_qty ? (ltp - p.avg_buy) * p.open_qty : 0;
};
/** Today's P&L of the strategy: realized - charges + live unrealized. */
export const dayPnl = (sc: Scalper) => {
  const f = sc.funds;
  if (!f) return null;
  return f.realized - f.charges + [...sc.positions.values()].reduce((t, p) => t + liveUnrealized(sc, p), 0);
};

const HEIGHT_KEY = STORAGE_PREFIX + 'stripHeight';
const savedHeight = () => {
  try {
    const h = Number(localStorage.getItem(HEIGHT_KEY));
    return h > 0 ? h : STRIP_DEFAULT;
  } catch {
    return STRIP_DEFAULT;
  }
};

export function BottomStrip({ sc, onNotice }: { sc: Scalper; onNotice: (kind: 'info' | 'error', text: string) => void }) {
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');
  const [which, setWhich] = useState<'open' | 'closed'>('open');
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(savedHeight);
  const [dragging, setDragging] = useState(false);
  const positions = [...sc.positions.values()];
  const open = positions.filter((p) => p.open_qty > 0);
  const closed = positions.filter((p) => p.open_qty <= 0);
  const orders = [...sc.orders.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const pnl = dayPnl(sc);
  const rows = which === 'open' ? open : closed;

  const exit = async (p: Position) => {
    try {
      await api.exit(p.security_id);
      onNotice('info', `Exit sent for ${p.name}.`);
    } catch (e) {
      onNotice('error', e instanceof ApiError ? e.message : 'Exit failed.');
    }
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = height;
    let h = h0;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      h = clampStrip(h0 + y0 - ev.clientY, window.innerHeight);
      setHeight(h);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragging(false);
      try {
        localStorage.setItem(HEIGHT_KEY, String(h));
      } catch {
        /* blocked storage */
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const style = { '--sc-strip-h': `${clampStrip(height, window.innerHeight)}px` } as CSSProperties;
  return (
    <section className={`card sc-bottom${expanded ? ' open' : ''}`} style={expanded ? style : undefined}>
      {expanded && (
        <div className={`sc-resize${dragging ? ' on' : ''}`} role="separator" aria-orientation="horizontal"
          aria-label="Drag to resize the positions panel" title="Drag to resize" onPointerDown={startResize} />
      )}
      <div className="sc-bottom-head">
        <button type="button" className="btn sc-bottom-toggle" aria-expanded={expanded}
          aria-label={expanded ? 'Hide positions and orders' : 'Show positions and orders'}
          title={expanded ? 'Hide (charts full height)' : 'Show positions and orders'} onClick={() => setExpanded((x) => !x)}>
          <span aria-hidden>{expanded ? '▼' : '▲'}</span>
        </button>
        <Segmented label="Account view" options={TABS} value={tab} onChange={(v) => { setTab(v); setExpanded(true); }} />
        {tab === 'positions' && (
          <Segmented label="Positions" value={which} onChange={(v) => { setWhich(v); setExpanded(true); }}
            options={[{ value: 'open', label: `Open ${open.length}` }, { value: 'closed', label: `Closed ${closed.length}` }]} />
        )}
        <span className="sc-bottom-stat" title="Realized + open P&L minus today's charges">P&amp;L today (after charges) <b className={`num ${toneOf(pnl)}`}>{signedRupees(pnl)}</b></span>
        <span className="sc-bottom-stat">Funds <b className="num">{rupees(sc.funds?.available)}</b></span>
      </div>
      {expanded && <div className="sc-table">
        {tab === 'positions' ? (!rows.length ? <EmptyState>{which === 'open' ? 'No open positions in this strategy.' : 'No closed positions today.'}</EmptyState> : (
          <table className="t">
            <thead><tr><th>Instrument</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th><th>Target</th><th>Stop</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => {
                const pl = p.realized + liveUnrealized(sc, p);
                return (
                  <tr key={p.security_id}>
                    <td title={p.name}>{shortName(p)}</td>
                    <td className="num">{p.open_qty || p.buy_qty}</td>
                    <td>{price(p.avg_buy)}</td>
                    <td>{price(liveLtp(sc, p))}</td>
                    <td className={toneOf(pl)}>{signedRupees(pl)}</td>
                    <td>{price(p.target)}</td>
                    <td>{price(p.stop)}</td>
                    <td>{p.open_qty > 0 && <button className="btn" onClick={() => exit(p)}>Exit</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )) : (!orders.length ? <EmptyState>No Scalper orders today.</EmptyState> : (
          <table className="t">
            <thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{hms(o.created_at)}</td>
                  <td title={o.name}>{shortName(o)}</td>
                  <td>{o.side}</td>
                  <td>{o.order_type}{OPEN(o) && o.trigger_price != null ? ` ${price(o.trigger_price)}` : ''}</td>
                  <td className="num">{o.qty}</td>
                  <td>{price(o.avg_price ?? o.price)}</td>
                  <td><Pill tone={STATUS_TONE[o.status]}>{o.status}</Pill></td>
                  <td className="muted sc-reason" title={o.reason}>{o.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>}
    </section>
  );
}
