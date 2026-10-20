import { useEffect, useMemo } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { EmptyState, Pill } from '../../shared/ui';
import { STRIKES_EACH_SIDE } from './config/settings';
import { STATUS_TONE, hms, lakh, longDate, pct, price, shortName, signedRupees, toneOf } from './format';
import { api, type Chain, type Order, type Position } from './logic/api';
import { changePct, chainWindow } from './logic/chain';
import { keyOf, type InstrumentKey } from './logic/feed';
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
  const spotKey = keyOf(chain.spot.segment, chain.spot.securityId);
  const spot = paper.ticks.get(spotKey)?.ltp ?? null;
  const win = useMemo(() => chainWindow(chain.rows, spot, STRIKES_EACH_SIDE), [chain.rows, spot]);

  // subscribe to the index and the strikes on screen; the backend adds open positions and pending orders itself
  const keys = useMemo(() => {
    const k: InstrumentKey[] = [spotKey];
    for (const r of win.rows) for (const leg of [r.ce, r.pe]) if (leg) k.push(keyOf('NSE_FNO', leg.securityId));
    return k;
  }, [spotKey, win.rows]);
  const keysId = keys.join(',');
  useEffect(() => paper.subscribe(keys), [keysId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lot = chain.lotSize ?? 1;
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
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Option chain · {chain.symbol} · {longDate(chain.expiry)}</h3>
          <span className="muted num">Lot {lot} · ATM ±{STRIKES_EACH_SIDE}</span>
        </div>
        {!win.rows.length ? (
          <EmptyState>
            {paper.meta?.marketOpen ? `Waiting for the live ${chain.symbol} price…` : `Market closed. Live prices appear from 09:15 IST.`}
          </EmptyState>
        ) : (
          <div className="pt-scroll">
            <table className="t pt-chain">
              <thead>
                <tr>
                  <th className="pt-call" title="Call open interest, lakh contracts">OI (L)</th><th className="pt-call">Chg %</th><th className="pt-call">LTP</th>
                  <th className="pt-strike">Strike</th>
                  <th className="pt-put">LTP</th><th className="pt-put">Chg %</th><th className="pt-put" title="Put open interest, lakh contracts">OI (L)</th>
                </tr>
              </thead>
              <tbody>
                {win.rows.map((r) => {
                  const ce = r.ce && paper.ticks.get(keyOf('NSE_FNO', r.ce.securityId));
                  const pe = r.pe && paper.ticks.get(keyOf('NSE_FNO', r.pe.securityId));
                  const cpc = changePct(ce?.ltp, ce?.close);
                  const ppc = changePct(pe?.ltp, pe?.close);
                  const ticket = (side: 'BUY' | 'SELL', leg: typeof r.ce) => leg && onTicket({ side, securityId: leg.securityId, name: leg.name, lotSize: lot });
                  return (
                    <tr key={r.strike} className={r.strike === win.atm ? 'hl' : ''}>
                      <td>{lakh(ce?.oi)}</td>
                      <td className={toneOf(cpc)}>{pct(cpc)}</td>
                      <td className="pt-leg pt-leg-ce">
                        {r.ce && <span className="pt-bs"><button className="btn pt-b" onClick={() => ticket('BUY', r.ce)}>B</button><button className="btn pt-s" onClick={() => ticket('SELL', r.ce)}>S</button></span>}
                        {price(ce?.ltp)}
                      </td>
                      <td className="pt-strike">{inr(0)(r.strike)}</td>
                      <td className="pt-leg pt-leg-pe">
                        {price(pe?.ltp)}
                        {r.pe && <span className="pt-bs"><button className="btn pt-b" onClick={() => ticket('BUY', r.pe)}>B</button><button className="btn pt-s" onClick={() => ticket('SELL', r.pe)}>S</button></span>}
                      </td>
                      <td className={toneOf(ppc)}>{pct(ppc)}</td>
                      <td>{lakh(pe?.oi)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="card-foot">Hover a row and press B or S. Sell closes an open position only (option buying, no short selling).</p>
      </section>

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
