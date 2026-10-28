// Paper trade a design: pick (or create) an options strategy, check the basket — legs at today's bid / ask, net
// premium, Dhan's margin, charges, the strategy's free funds — and place it all-or-nothing (PAPER ONLY; backend
// options_engine.py). Manual strategies stay buy-only and are not offered here.
import { useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { optionStrategies, strategyApi, type Strategy } from '../../shared/strategy/api';
import { Alert } from '../../shared/ui';
import { price, rupees } from '../paper-trade/format';
import { optionsApi, type Margin, type OptionBook } from './logic/api';
import { midPrice, shortExpiry, type Quote } from './logic/legs';
import type { Leg } from './logic/payoff';

const PICK_KEY = 'builder.options.strategy';
export const rememberedStrategy = () => {
  try { return Number(localStorage.getItem(PICK_KEY)) || null; } catch { return null; }
};
const remember = (id: number) => { try { localStorage.setItem(PICK_KEY, String(id)); } catch { /* not remembered */ } };

export function PaperTradeDialog({ legs, multiplier, quoteOf, securityOf, net, charges, margin, onClose, onPlaced }: {
  legs: Leg[]; // priced, ticked or not
  multiplier: number;
  quoteOf: (l: Leg) => Quote | null;
  securityOf: (l: Leg) => number | null;
  net: number; // + credit / − debit at the design's prices
  charges: number | null;
  margin: Margin | null;
  onClose: () => void;
  onPlaced: (strategyId: number, book: OptionBook) => void;
}) {
  const [list, setList] = useState<Strategy[] | null>(null);
  const [pick, setPick] = useState<number | null>(rememberedStrategy);
  const [book, setBook] = useState<OptionBook | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('Options');
  const [newCapital, setNewCapital] = useState('200000');

  useEffect(() => {
    const ctrl = new AbortController();
    strategyApi.list(false, ctrl.signal).then((all) => {
      const opts = optionStrategies(all);
      setList(opts);
      setPick((p) => (p && opts.some((s) => s.id === p) ? p : opts[0]?.id ?? null));
    }).catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load your strategies.'); });
    return () => ctrl.abort();
  }, []);
  useEffect(() => {
    if (pick == null) { setBook(null); return; }
    const ctrl = new AbortController();
    optionsApi.positions(pick, ctrl.signal).then(setBook).catch(() => setBook(null));
    return () => ctrl.abort();
  }, [pick]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const on = legs.filter((l) => l.include && l.lots > 0);
  const missing = on.filter((l) => securityOf(l) == null);
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const st = await strategyApi.create(newName.trim(), Number(newCapital), 'Strategy Builder paper trades', 'options');
      setList((ls) => [...(ls ?? []), st]);
      setPick(st.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not create the strategy.'); } finally { setBusy(false); }
  };
  const place = async () => {
    if (pick == null) return;
    setBusy(true);
    setError('');
    try {
      const r = await optionsApi.basket(pick, on.map((l) => ({ securityId: securityOf(l)!, side: l.side, lots: l.lots * multiplier })));
      remember(pick);
      onPlaced(pick, r);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'The basket was not placed.'); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal sb-trade" role="dialog" aria-modal="true" aria-label="Paper trade this design">
        <div className="card-head">
          <h3 className="card-title">Paper trade this design</h3>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {list == null ? <p className="muted sb-small">Loading…</p> : !list.length ? (
          <div className="sb-trade-new">
            <p className="sb-small">Short legs and holding to expiry need an <b>Options</b> strategy (Manual ones are buy-only). Create one:</p>
            <div className="sb-trade-row">
              <label className="field">Name<input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
              <label className="field">Capital (₹)<input className="num" type="number" min={10000} step={10000} value={newCapital} onChange={(e) => setNewCapital(e.target.value)} /></label>
              <button type="button" className="btn primary" disabled={busy || !newName.trim()} onClick={create}>Create</button>
            </div>
          </div>
        ) : (
          <label className="field">Into strategy
            <select value={pick ?? ''} onChange={(e) => setPick(Number(e.target.value))}>
              {list.map((s) => <option key={s.id} value={s.id}>{s.name} · capital {rupees(s.capital, 0)}</option>)}
            </select>
          </label>
        )}
        <table className="t sb-trade-legs">
          <thead><tr><th>Leg</th><th>Lots</th><th title="Sells fill at the bid, buys at the ask">Est. fill</th></tr></thead>
          <tbody>
            {on.map((l) => {
              const q = quoteOf(l);
              const est = l.side === 'S' ? q?.bid ?? midPrice(q) : q?.ask ?? midPrice(q);
              return (
                <tr key={l.id}>
                  <td className={l.side === 'B' ? 'up' : 'down'}>{l.side === 'B' ? 'Buy' : 'Sell'} {inr(0)(l.strike)} {l.type} <span className="muted">{shortExpiry(l.expiry)}</span></td>
                  <td className="num">{l.lots * multiplier} <span className="muted">({l.lots * multiplier * l.lotSize} qty)</span></td>
                  <td className="num">{price(est)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <dl className="sb-trade-sum">
          <div><dt>{net >= 0 ? 'Net credit' : 'Net debit'}</dt><dd className="num">{rupees(Math.abs(net))}</dd></div>
          <div><dt>Margin (Dhan)</dt><dd className="num">{margin ? rupees(margin.total) : '–'}</dd></div>
          <div><dt>Charges (in)</dt><dd className="num">{charges != null ? `≈ ${rupees(charges / 2)}` : '–'}</dd></div>
          <div><dt>Available in strategy</dt><dd className="num">{book ? rupees(book.funds.available) : '–'}</dd></div>
        </dl>
        {book && book.positions.length > 0 && <p className="muted sb-small">This strategy already holds {book.positions.length} leg(s); the margin is asked again for the whole book.</p>}
        {missing.length > 0 && <Alert kind="warn">{missing.length} leg(s) have no instrument ID yet: wait for the chain to load.</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        <p className="muted sb-small">Paper only. All legs fill at market or none do; refused when Dhan's margin is unavailable, funds are short or the market is closed.</p>
        <div className="sb-trade-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || pick == null || !on.length || missing.length > 0} onClick={place}>
            {busy ? 'Placing…' : `Place ${on.length}-leg basket (paper)`}
          </button>
        </div>
      </div>
    </div>
  );
}
