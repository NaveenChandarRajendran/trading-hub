import { Fragment, useEffect, useMemo } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { EmptyState, Pill } from '../../shared/ui';
import { STRIKES_EACH_SIDE } from './config/settings';
import { STATUS_TONE, hms, lakh, longDate, pct, price, shortName, signedRupees, toneOf } from './format';
import { api, type Chain, type Order, type Position } from './logic/api';
import { changePct, chainWindow, itm, spotGapAfter } from './logic/chain';
import { strikePcr, type LegExtra } from './logic/greeks';
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

const lakhSigned = (v: number | null | undefined) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${inr(2)(Math.abs(v) / 100000)}`);
const fx = (d: number) => (v: number | null | undefined) => (v == null ? '–' : inr(d)(v));
const pctPlain = (v: number | null | undefined) => (v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${inr(2)(Math.abs(v))}%`);

/** One side's columns, outer -> inner, as on Dhan's Advanced Option Chain (LTP sits next to the strike). */
type Cell = { v: string; tone?: string; sub?: string };
type Leg = { x: LegExtra | null; oi?: number; ltp?: number; chg: number | null; close?: number };
const SIDE: { h: string; title: string; cell: (l: Leg) => Cell }[] = [
  { h: 'Vega', title: 'Vega', cell: (l) => ({ v: fx(2)(l.x?.vega) }) },
  { h: 'Theta', title: 'Theta (₹ per day)', cell: (l) => ({ v: fx(2)(l.x?.theta) }) },
  { h: 'Gamma', title: 'Gamma', cell: (l) => ({ v: fx(4)(l.x?.gamma) }) },
  { h: 'Delta', title: 'Delta', cell: (l) => ({ v: fx(3)(l.x?.delta) }) },
  { h: 'IV', title: 'Implied volatility %', cell: (l) => ({ v: fx(2)(l.x?.iv) }) },
  { h: 'Volume (L)', title: 'Volume today, lakh contracts', cell: (l) => ({ v: lakh(l.x?.volume) }) },
  { h: 'OI Chg (L)', title: "Change in OI vs the previous day's settled OI, lakh contracts (and %)", cell: (l) => ({ v: lakhSigned(l.x?.oiChg), tone: toneOf(l.x?.oiChg), sub: pctPlain(l.x?.oiChgPct) }) },
  { h: 'OI (L)', title: 'Open interest, lakh contracts', cell: (l) => ({ v: lakh(l.oi ?? l.x?.oi) }) },
  { h: 'LTP Chg', title: 'LTP change vs the previous close (and %)', cell: (l) => ({ v: l.ltp != null && l.close ? `${l.ltp - l.close > 0 ? '+' : l.ltp - l.close < 0 ? '−' : ''}${inr(2)(Math.abs(l.ltp - l.close))}` : '–', tone: toneOf(l.chg), sub: pct(l.chg) }) },
];

export function TradeView({ paper, chain, extras, chainSpot, onTicket, onNotice }: {
  paper: Paper;
  chain: Chain;
  extras: Map<number, { ce: LegExtra | null; pe: LegExtra | null }>;
  chainSpot: number | null; // spot from the Dhan chain: used while there is no live tick (market closed)
  onTicket: (t: TicketTarget) => void;
  onNotice: (kind: 'info' | 'error', text: string) => void;
}) {
  const spotKey = keyOf(chain.spot.segment, chain.spot.securityId);
  const spot = paper.ticks.get(spotKey)?.ltp ?? chainSpot ?? null;
  const win = useMemo(() => chainWindow(chain.rows, spot, STRIKES_EACH_SIDE), [chain.rows, spot]);
  const gapAfter = spotGapAfter(win.rows, spot); // the live spot line sits below this row
  const span = SIDE.length + 1;

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
    <div className="pt-stack">
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Option chain · {chain.symbol} · {longDate(chain.expiry)}</h3>
          <span className="pt-chain-meta">
            <span className="muted num">Lot {lot} · ATM ±{STRIKES_EACH_SIDE}</span>
            <span className="pt-legend" title="In the money: calls below spot, puts above spot"><i className="pt-swatch" />ITM</span>
          </span>
        </div>
        {!win.rows.length ? (
          <EmptyState>
            {paper.meta?.marketOpen ? `Waiting for the live ${chain.symbol} price…` : `Market closed. Loading the last session's chain…`}
          </EmptyState>
        ) : (
          <div className="pt-scroll">
            <table className="t pt-chain">
              <thead>
                <tr className="pt-group">
                  <th className="pt-call" colSpan={span}>CALLS</th>
                  <th className="pt-strike" rowSpan={2}>Strike</th>
                  <th className="pt-strike" rowSpan={2} title="Put OI ÷ call OI at this strike">PCR</th>
                  <th className="pt-put" colSpan={span}>PUTS</th>
                </tr>
                <tr>
                  {SIDE.map((c) => <th key={`c${c.h}`} className="pt-call" title={c.title}>{c.h}</th>)}
                  <th className="pt-call">LTP</th>
                  <th className="pt-put">LTP</th>
                  {[...SIDE].reverse().map((c) => <th key={`p${c.h}`} className="pt-put" title={c.title}>{c.h}</th>)}
                </tr>
              </thead>
              <tbody>
                {win.rows.map((r, i) => {
                  const ce = r.ce && paper.ticks.get(keyOf('NSE_FNO', r.ce.securityId));
                  const pe = r.pe && paper.ticks.get(keyOf('NSE_FNO', r.pe.securityId));
                  const x = extras.get(r.strike);
                  const cl: Leg = { x: x?.ce ?? null, oi: ce?.oi, ltp: ce?.ltp ?? x?.ce?.ltp ?? undefined, close: ce?.close ?? x?.ce?.close ?? undefined, chg: null };
                  const pl: Leg = { x: x?.pe ?? null, oi: pe?.oi, ltp: pe?.ltp ?? x?.pe?.ltp ?? undefined, close: pe?.close ?? x?.pe?.close ?? undefined, chg: null };
                  cl.chg = changePct(cl.ltp, cl.close);
                  pl.chg = changePct(pl.ltp, pl.close);
                  const ticket = (side: 'BUY' | 'SELL', leg: typeof r.ce) => leg && onTicket({ side, securityId: leg.securityId, name: leg.name, lotSize: lot });
                  const money = spot != null ? itm(r.strike, spot) : { ce: false, pe: false };
                  const ceItm = money.ce ? 'pt-itm' : '';
                  const peItm = money.pe ? 'pt-itm' : '';
                  const sp = strikePcr(x?.ce, x?.pe);
                  const td = (c: (typeof SIDE)[number], l: Leg, side: string, cls: string) => {
                    const v = c.cell(l);
                    return <td key={`${side}${c.h}`} className={`${v.tone ?? ''} ${cls}`}>{v.v}{v.sub ? <span className="pt-cell-sub"> {v.sub}</span> : null}</td>;
                  };
                  return (
                    <Fragment key={r.strike}>
                      <tr className={r.strike === win.atm ? 'hl' : ''}>
                        {SIDE.map((c) => td(c, cl, 'c', ceItm))}
                        <td className={`pt-leg pt-leg-ce ${ceItm}`}>
                          {r.ce && <span className="pt-bs"><button className="btn pt-b" onClick={() => ticket('BUY', r.ce)}>B</button><button className="btn pt-s" onClick={() => ticket('SELL', r.ce)}>S</button></span>}
                          {price(cl.ltp)}
                        </td>
                        <td className="pt-strike">{inr(0)(r.strike)}</td>
                        <td className="pt-strike pt-pcr">{sp == null ? '–' : inr(2)(sp)}</td>
                        <td className={`pt-leg pt-leg-pe ${peItm}`}>
                          {price(pl.ltp)}
                          {r.pe && <span className="pt-bs"><button className="btn pt-b" onClick={() => ticket('BUY', r.pe)}>B</button><button className="btn pt-s" onClick={() => ticket('SELL', r.pe)}>S</button></span>}
                        </td>
                        {[...SIDE].reverse().map((c) => td(c, pl, 'p', peItm))}
                      </tr>
                      {i === gapAfter && (
                        <tr className="pt-spot-row" aria-label={`${chain.symbol} spot ${inr(2)(spot)}`}>
                          <td colSpan={span} />
                          <td className="pt-strike" colSpan={2}><span className="pill accent pt-spot-pill">{chain.symbol} {inr(2)(spot)}</span></td>
                          <td colSpan={span} />
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="card-foot">Hover a row and press B or S. Sell closes an open position only (option buying, no short selling).
          LTP and OI are live; OI change, volume, IV and Greeks refresh with Dhan&apos;s option chain (every 15 s in market hours). Scroll sideways for all columns.</p>
      </section>

      <div className="split pt-split-even">
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
