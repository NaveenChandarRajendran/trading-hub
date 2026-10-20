import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { Alert, Segmented } from '../../shared/ui';
import { price, rupees } from './format';
import { api, type Order, type OrderType, type Side } from './logic/api';
import { keyOf } from './logic/feed';
import { ORDER_TYPES, TICK_SIZE, checkTicket, needsPrice, needsTrigger } from './logic/ticket';
import type { Paper } from './usePaper';

export interface TicketTarget {
  side: Side;
  securityId: number;
  name: string;
  lotSize: number;
  order?: Order; // set when modifying a pending order
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

export function OrderTicket({ target, paper, onClose, onDone }: {
  target: TicketTarget;
  paper: Paper;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const o = target.order;
  const tick = paper.ticks.get(keyOf('NSE_FNO', target.securityId));
  const [orderType, setOrderType] = useState<OrderType>(o?.order_type ?? 'MARKET');
  const [lots, setLots] = useState(String(o?.lots ?? 1));
  const [px, setPx] = useState(o?.price != null ? String(o.price) : tick?.ltp ? tick.ltp.toFixed(2) : '');
  const [trigger, setTrigger] = useState(o?.trigger_price != null ? String(o.trigger_price) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pos = paper.positions.get(target.securityId);
  const pendingSell = [...paper.orders.values()]
    .filter((x) => x.security_id === target.securityId && x.side === 'SELL' && (x.status === 'PENDING' || x.status === 'TRIGGERED') && x.id !== o?.id)
    .reduce((t, x) => t + x.qty, 0);

  const check = useMemo(() => checkTicket({
    side: target.side, orderType, lots: Number(lots), lotSize: target.lotSize,
    price: needsPrice(orderType) ? num(px) : null, trigger: needsTrigger(orderType) ? num(trigger) : null,
    ltp: tick?.ltp ?? null, ask: tick?.ask ?? null, openQty: pos?.open_qty ?? 0, pendingSellQty: pendingSell,
    available: (paper.funds?.available ?? 0) + (o?.blocked ?? 0), // a modified BUY releases what it blocks now
    rates: paper.account?.chargeRates ?? null,
  }), [target, orderType, lots, px, trigger, tick, pos, pendingSell, paper.funds, paper.account, o]);
  // a TRIGGERED SL keeps its trigger: only the limit price can change
  const triggerLocked = o?.status === 'TRIGGERED';

  const submit = async () => {
    setBusy(true);
    setError('');
    const body = {
      lots: Number(lots),
      price: needsPrice(orderType) ? num(px) ?? undefined : undefined,
      triggerPrice: needsTrigger(orderType) && !triggerLocked ? num(trigger) ?? undefined : undefined,
    };
    try {
      if (o) {
        await api.modify(o.id, body);
        onDone(`Order ${o.id} modified.`);
      } else {
        const r = await api.place({ securityId: target.securityId, side: target.side, orderType, ...body });
        if (r.status === 'REJECTED') {
          setError(r.reason);
          setBusy(false);
          return;
        }
        onDone(`${target.side === 'BUY' ? 'Buy' : 'Sell'} ${r.qty} ${target.name}: ${r.status.toLowerCase()}.`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the order.');
      setBusy(false);
    }
  };

  const verb = o ? 'Modify' : target.side === 'BUY' ? 'Buy' : 'Sell';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal pt-ticket" role="dialog" aria-modal="true" aria-label={`${verb} ${target.name}`}>
        <div className="card-head">
          <h3 className="card-title">
            <span className={`pt-side ${target.side === 'BUY' ? 'buy' : 'sell'}`}>{target.side}</span> {target.name}
          </h3>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="pt-quote num">
          <span>LTP <b>{price(tick?.ltp)}</b></span>
          <span>Bid <b>{price(tick?.bid)}</b></span>
          <span>Ask <b>{price(tick?.ask)}</b></span>
        </div>
        {!o && <Segmented label="Order type" options={ORDER_TYPES} value={orderType} onChange={setOrderType} />}
        <div className="pt-fields">
          <label className="field">Lots
            <input type="number" min={1} step={1} value={lots} onChange={(e) => setLots(e.target.value)} autoFocus />
            <span className="pt-hint num">Qty {check.qty} ({target.lotSize} per lot)</span>
          </label>
          {needsPrice(orderType) && (
            <label className="field">Price
              <input type="number" min={TICK_SIZE} step={TICK_SIZE} value={px} onChange={(e) => setPx(e.target.value)} />
            </label>
          )}
          {needsTrigger(orderType) && (
            <label className="field">Trigger price
              <input type="number" min={TICK_SIZE} step={TICK_SIZE} value={trigger} disabled={triggerLocked}
                onChange={(e) => setTrigger(e.target.value)} />
              <span className="pt-hint">Triggers when LTP {target.side === 'SELL' ? '≤' : '≥'} this price</span>
            </label>
          )}
        </div>
        <dl className="pt-money num">
          {target.side === 'BUY' ? (
            <>
              <dt>Required</dt><dd>{rupees(check.required)}</dd>
              <dt>Available</dt><dd>{rupees(paper.funds?.available)}</dd>
            </>
          ) : (
            <>
              <dt>Premium</dt><dd>{rupees(check.premium)}</dd>
              <dt>Open qty</dt><dd>{pos?.open_qty ?? 0}</dd>
            </>
          )}
          <dt>Est. charges</dt><dd>{rupees(check.charges)}</dd>
        </dl>
        {(check.errors.length > 0 || error) && (
          <Alert kind="error">{error || check.errors[0]}</Alert>
        )}
        <div className="pt-ticket-actions">
          <span className="muted">Paper trade · simulated fill</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || check.errors.length > 0}>
            {busy ? 'Sending…' : verb}
          </button>
        </div>
      </div>
    </div>
  );
}
