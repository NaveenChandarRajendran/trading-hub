import { ApiError } from '../../shared/api';
import { EmptyState, Pill } from '../../shared/ui';
import { STATUS_TONE, hms, price, shortName, signedRupees, toneOf } from './format';
import { api, type Chain, type Order, type Position } from './logic/api';
import { keyOf } from './logic/feed';
import { OptionChain } from './OptionChain';
import type { TicketTarget } from './OrderTicket';
import type { Paper } from './usePaper';

/** "165.95" (limit), "trg 125.95" (SL-M), "89.00 · trg 90.00" (SL). */
const orderPrice = (o: Order) =>
  [o.price != null ? price(o.price) : '', o.trigger_price != null ? `trg ${price(o.trigger_price)}` : ''].filter(Boolean).join(' · ') || 'Market';

const OPEN = (o: Order) => o.status === 'PENDING' || o.status === 'TRIGGERED';

export const liveLtp = (paper: Paper, p: Position) => paper.ticks.get(keyOf('NSE_FNO', p.security_id))?.ltp ?? p.ltp;
export const liveUnrealized = (paper: Paper, p: Position) => {
  const ltp = liveLtp(paper, p);
  return ltp != null && p.open_qty ? (ltp - p.avg_buy) * p.open_qty : 0;
};

export function TradeView({ paper, chain, onTicket, onNotice }: {
  paper: Paper;
  chain: Chain;
  onTicket: (t: TicketTarget) => void;
  onNotice: (kind: 'info' | 'error', text: string) => void;
}) {
  const positions = [...paper.positions.values()].sort((a, b) => b.open_qty - a.open_qty);
  const openOrders = [...paper.orders.values()].filter(OPEN).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      onNotice('info', done);
    } catch (e) {
      onNotice('error', e instanceof ApiError ? e.message : 'Request failed.');
    }
  };

  return (
    <div className="split pt-split">
      <OptionChain paper={paper} chain={chain} onTicket={onTicket} />

      <div className="pt-stack">
        <section className="card">
          <div className="card-head">
            <h3 className="card-title">Positions</h3>
            <button className="btn" disabled={!positions.some((p) => p.open_qty > 0)}
              onClick={() => confirm('Exit every open position at market?') && act(api.exitAll, 'Exit all sent.')}>Exit all</button>
          </div>
          {!positions.length ? <EmptyState>No positions yet today.</EmptyState> : (
            <div className="pt-scroll">
              <table className="t">
                <thead><tr><th>Instrument</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th><th /></tr></thead>
                <tbody>
                  {positions.map((p) => {
                    const pnl = p.realized + liveUnrealized(paper, p);
                    return (
                      <tr key={p.security_id} className={p.open_qty ? '' : 'pt-closed'}>
                        <td title={p.name}>{shortName(p)}</td>
                        <td className="num">{p.open_qty ? <>{p.open_qty} <span className="muted">({p.open_lots} lot{p.open_lots === 1 ? '' : 's'})</span></> : 'Closed'}</td>
                        <td>{price(p.avg_buy)}</td>
                        <td>{price(liveLtp(paper, p))}</td>
                        <td className={toneOf(pnl)}>{signedRupees(pnl)}</td>
                        <td>
                          {p.open_qty > 0 && (
                            <span className="pt-row-actions">
                              <button className="btn" onClick={() => onTicket({ side: 'SELL', securityId: p.security_id, name: p.name, lotSize: p.lot_size })}>Sell</button>
                              <button className="btn" onClick={() => act(() => api.exit(p.security_id), `Exit sent for ${p.name}.`)}>Exit</button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h3 className="card-title">Open orders</h3><span className="muted">{openOrders.length} pending</span></div>
          {!openOrders.length ? <EmptyState>No pending orders.</EmptyState> : (
            <div className="pt-scroll">
              <table className="t">
                <thead><tr><th>Time</th><th>Instrument</th><th>Qty</th><th title="Order type, limit price · trigger">Order</th><th /></tr></thead>
                <tbody>
                  {openOrders.map((o) => (
                    <tr key={o.id}>
                      <td>{hms(o.created_at).slice(0, 5)}</td>
                      <td title={o.name}><span className={`pt-side ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side}</span> {shortName(o)}</td>
                      <td className="num">{o.qty}</td>
                      <td>{o.status === 'TRIGGERED' && <Pill tone={STATUS_TONE[o.status]}>TRIGGERED</Pill>} {o.order_type} {orderPrice(o)}</td>
                      <td>
                        <span className="pt-row-actions">
                          <button className="btn" onClick={() => onTicket({ side: o.side, securityId: o.security_id, name: o.name, lotSize: o.lot_size, order: o })}>Modify</button>
                          <button className="btn" onClick={() => act(() => api.cancel(o.id), `Order ${o.id} cancelled.`)}>Cancel</button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
