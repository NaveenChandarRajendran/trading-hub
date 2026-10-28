// One Power Scalper ticket (CE or PE): strike dropdown, Follow ATM, lots stepper, one-click MARKET Buy / Sell (no
// confirmation; PAPER ONLY), best bid / ask with quantities and the day's range.
import { inr } from '../../shared/grid';
import { Pill } from '../../shared/ui';
import { price } from '../paper-trade/format';
import { MAX_LOTS } from './config/settings';
import type { ScalperTick } from './logic/api';
import type { PickerItem } from './logic/picker';
import { rangePct, type Side, type TicketCheck } from './logic/ticket';
import { StrikePicker } from './StrikePicker';

export function Ticket({ side, title, strike, picker, onStrike, follow, onFollow, lots, onLots, tick, check, busy, onBuy, onSell }: {
  side: Side;
  title: string; // "NIFTY 3 Nov"
  strike: number | null;
  picker: { items: PickerItem[]; atmIndex: number | null };
  onStrike: (k: number) => void;
  follow: boolean;
  onFollow: (on: boolean) => void;
  lots: number;
  onLots: (n: number) => void;
  tick?: ScalperTick;
  check: TicketCheck;
  busy: boolean;
  onBuy: () => void;
  onSell: () => void;
}) {
  const pos = rangePct(tick?.low, tick?.high, tick?.ltp);
  const setLots = (n: number) => onLots(Math.min(MAX_LOTS, Math.max(1, Math.round(n) || 1)));
  return (
    <section className="sc-ticket">
      <div className="sc-ticket-head">
        <Pill tone={side === 'CE' ? 'down' : 'up'}>{side}</Pill>
        <span className="sc-ticket-title">{title}</span>
        <StrikePicker label={`${side} strike`} value={strike} items={picker.items} atmIndex={picker.atmIndex} onPick={onStrike} />
        <label className="sc-follow" title="The strike follows spot while you hold no position or order on this side">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} /> Follow ATM
        </label>
        <span className="num sc-ticket-ltp">{price(tick?.ltp)}</span>
      </div>
      <div className="sc-ticket-row">
        <button type="button" className="btn sc-sell" disabled={busy || !!check.sell} title={check.sell || `Sell ${check.qty} at market`} onClick={onSell}>Sell</button>
        <div className="sc-stepper">
          <button type="button" className="btn" aria-label="One lot less" disabled={lots <= 1} onClick={() => setLots(lots - 1)}>−</button>
          <input type="number" min={1} max={MAX_LOTS} value={lots} aria-label={`${side} lots`} onChange={(e) => setLots(Number(e.target.value))} />
          <button type="button" className="btn" aria-label="One lot more" disabled={lots >= MAX_LOTS} onClick={() => setLots(lots + 1)}>+</button>
        </div>
        <button type="button" className="btn sc-buy" disabled={busy || !!check.buy} title={check.buy || `Buy ${check.qty} at market`} onClick={onBuy}>Buy</button>
      </div>
      <div className="sc-ticket-meta num">
        <span>Lots {lots} · Qty {check.qty || '–'}</span>
        <span className={check.short ? 'down' : undefined} title="Ask × quantity: what a Buy at market needs now (charges extra)">
          Need {check.cost == null ? '–' : `₹${inr(0)(check.cost)}`}
        </span>
        {check.openQty > 0 && <span>Open {check.openQty}</span>}
      </div>
      <div className="sc-book num">
        <span>Bid <b className="up">{price(tick?.bid)}</b> × {tick?.bidQty ?? '–'}</span>
        <span>Ask <b className="down">{price(tick?.ask)}</b> × {tick?.askQty ?? '–'}</span>
      </div>
      <div className="sc-range" title="Day range: low – high, marker at LTP">
        <span className="num muted">{price(tick?.low)}</span>
        <span className="sc-range-bar">{pos != null && <i className="sc-range-mark" style={{ left: `${pos}%` }} />}</span>
        <span className="num muted">{price(tick?.high)}</span>
      </div>
      {check.buy && <p className="muted sc-small">{check.buy}</p>}
    </section>
  );
}
