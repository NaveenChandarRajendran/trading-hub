// The legs of one design: include tick, Buy / Sell, expiry, strike (dropdown with every strike, − / + one strike),
// CE / PE, lots, price (live mid by default; type to override, ↺ back to live) and a row menu (duplicate, delete).
// Legs are added on the option chain (OptionChainPanel.tsx) or by a template.
import { useEffect, useRef, useState } from 'react';
import { inr } from '../../shared/grid';
import { price as fmtPrice } from '../paper-trade/format';
import { pickerItems } from '../scalper/logic/picker';
import { StrikePicker } from '../scalper/StrikePicker';
import { MAX_LEGS, duplicateLeg, midPrice, shortExpiry, stepStrike, type BuilderLeg } from './logic/legs';
import type { Market } from './useMarket';

function RowMenu({ onDuplicate, onDelete, canDuplicate }: { onDuplicate: () => void; onDelete: () => void; canDuplicate: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);
  return (
    <span className="sb-menu" ref={box}>
      <button type="button" className="btn ghost icon" aria-label="Leg menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <span className="card sb-menu-pop" role="menu">
          <button type="button" className="btn ghost" role="menuitem" disabled={!canDuplicate} onClick={() => { setOpen(false); onDuplicate(); }}>Duplicate</button>
          <button type="button" className="btn ghost sb-danger" role="menuitem" onClick={() => { setOpen(false); onDelete(); }}>Delete</button>
        </span>
      )}
    </span>
  );
}

export function LegsTable({ legs, onChange, market }: {
  legs: BuilderLeg[];
  onChange: (legs: BuilderLeg[]) => void;
  market: Market;
}) {
  const set = (id: string, patch: Partial<BuilderLeg>) => onChange(legs.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  if (!legs.length) return null;

  return (
    <div className="sb-legs">
      <table className="t sb-legs-table">
        <thead>
          <tr><th aria-label="Include" /><th>B/S</th><th>Expiry</th><th>Strike</th><th>Type</th><th>Lots</th><th title="Price · implied volatility">Price · IV</th><th /></tr>
        </thead>
        <tbody>
          {legs.map((l) => {
            const strikes = market.strikesOf(l.expiry);
            const q = market.quoteOf(l.expiry, l.strike, l.type);
            const live = midPrice(q);
            const picker = pickerItems(strikes, market.spot, l.type, (k) => market.quoteOf(l.expiry, k, l.type)?.ltp);
            return (
              <tr key={l.id} className={l.include ? '' : 'sb-off'}>
                <td><input type="checkbox" checked={l.include} aria-label="Include this leg" onChange={(e) => set(l.id, { include: e.target.checked })} /></td>
                <td>
                  <button type="button" className={`btn sb-side ${l.side === 'B' ? 'buy' : 'sell'}`} title="Buy / Sell"
                    onClick={() => set(l.id, { side: l.side === 'B' ? 'S' : 'B' })}>{l.side}</button>
                </td>
                <td>
                  <select value={l.expiry} aria-label="Expiry" onChange={(e) => set(l.id, { expiry: e.target.value, priceOverride: null })}>
                    {(market.expiries.length ? market.expiries : [l.expiry]).map((ex) => <option key={ex} value={ex}>{shortExpiry(ex)}</option>)}
                  </select>
                </td>
                <td>
                  <span className="sb-strike">
                    <button type="button" className="btn icon" aria-label="One strike lower" onClick={() => set(l.id, { strike: stepStrike(strikes, l.strike, -1), priceOverride: null })}>−</button>
                    <StrikePicker label="Strike" value={l.strike} items={picker.items} atmIndex={picker.atmIndex}
                      onPick={(k) => set(l.id, { strike: k, priceOverride: null })} />
                    <button type="button" className="btn icon" aria-label="One strike higher" onClick={() => set(l.id, { strike: stepStrike(strikes, l.strike, 1), priceOverride: null })}>+</button>
                  </span>
                </td>
                <td>
                  <button type="button" className={`btn sb-type ${l.type === 'CE' ? 'ce' : 'pe'}`} title="Call / Put"
                    onClick={() => set(l.id, { type: l.type === 'CE' ? 'PE' : 'CE', priceOverride: null })}>{l.type}</button>
                </td>
                <td>
                  <input className="num sb-lots" type="number" min={1} max={100} value={l.lots} aria-label="Lots"
                    onChange={(e) => set(l.id, { lots: Math.max(1, Math.min(100, Math.round(Number(e.target.value)) || 1)) })} />
                </td>
                <td>
                  <span className="sb-price">
                    <input className="num" type="number" min={0} step={0.05} aria-label="Price" disabled={l.locked}
                      title={l.locked ? 'The average buy price of the position' : undefined}
                      value={l.priceOverride ?? (live ?? '')} placeholder="–"
                      onChange={(e) => set(l.id, { priceOverride: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} />
                    {l.priceOverride != null && !l.locked
                      ? <button type="button" className="btn ghost icon" title={`Back to live ${fmtPrice(live)}`} aria-label="Back to the live price" onClick={() => set(l.id, { priceOverride: null })}>↺</button>
                      : <span className="sb-iv muted num" title="Implied volatility from the option chain">{q?.iv ? `${inr(1)(q.iv)}%` : '–'}</span>}
                  </span>
                </td>
                <td>
                  <RowMenu canDuplicate={legs.length < MAX_LEGS} onDuplicate={() => onChange(duplicateLeg(legs, l.id))}
                    onDelete={() => onChange(legs.filter((x) => x.id !== l.id))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {legs.length > 0 && <span className="muted sb-small">{legs.length} of {MAX_LEGS} legs</span>}
    </div>
  );
}
