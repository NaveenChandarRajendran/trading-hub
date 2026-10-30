// Day MTM limit of the strategy (backend mtm_limit.py): profit / loss in ₹ after charges, and a profit lock (armed once
// day MTM is above it, fires when MTM falls back to it). When one is reached, every pending order is cancelled, every
// position sold at market and buys are off for the rest of the day.
import { useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { api, type MtmLimit } from '../scalper/logic/api';
import type { Say } from './TradeWindowApp';

const text = (v: number | null | undefined) => (v == null ? '' : String(v));
const parse = (v: string) => (v.trim() === '' ? null : Number(v));

export function MtmLimitControl({ mtm, onSaved, say }: { mtm: MtmLimit | null; onSaved: () => void; say: Say }) {
  const [profit, setProfit] = useState(text(mtm?.profit));
  const [loss, setLoss] = useState(text(mtm?.loss));
  const [lock, setLock] = useState(text(mtm?.lock));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setProfit(text(mtm?.profit)); setLoss(text(mtm?.loss)); setLock(text(mtm?.lock)); }, [mtm?.profit, mtm?.loss, mtm?.lock]);
  const dirty = profit !== text(mtm?.profit) || loss !== text(mtm?.loss) || lock !== text(mtm?.lock);

  const saveLimit = async () => {
    const p = parse(profit), l = parse(loss), k = parse(lock);
    if ((p != null && !(p > 0)) || (l != null && !(l > 0))) { say('error', 'MTM limits must be above ₹0 (leave empty for off).'); return; }
    if (k != null && (!(k >= 0) || (p != null && k >= p))) { say('error', 'The profit lock must be ₹0 or more and below the profit target.'); return; }
    setBusy(true);
    try {
      const r = await api.mtmLimit(p, l, k);
      onSaved();
      say('info', p == null && l == null && k == null ? 'MTM limit off.'
        : `MTM limit set: profit ${p ?? 'off'} / loss ${l ?? 'off'} / lock ${k ?? 'off'} (₹, after charges)`
          + (k != null ? (r.mtm.lockArmed ? '. Lock armed: you exit with at least this profit.' : '. Lock arms once day MTM is above it.') : '.'));
    } catch (e) {
      say('error', e instanceof ApiError ? e.message : 'Could not save the MTM limit.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field tw-mtm-field">MTM limit (₹ per day)
      <span className="tw-mtm" title="Day MTM after charges. Profit: exit at +this. Loss: exit at −this. Lock: once MTM has been above it, exit when MTM falls back to it (profit kept). Then: pending orders cancelled, all positions sold at market, no new buys today.">
        <input className="num" type="number" min={1} placeholder="Profit" aria-label="Profit limit" value={profit} onChange={(e) => setProfit(e.target.value)} />
        <input className="num" type="number" min={1} placeholder="Loss" aria-label="Loss limit" value={loss} onChange={(e) => setLoss(e.target.value)} />
        <input className="num" type="number" min={0} placeholder="Lock" aria-label="Profit lock" value={lock} onChange={(e) => setLock(e.target.value)} />
        <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void saveLimit()}>Set</button>
      </span>
    </div>
  );
}
