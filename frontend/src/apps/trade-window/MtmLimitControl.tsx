// Day MTM limit of the strategy (backend mtm_limit.py): profit / loss in ₹ after charges. When day MTM reaches one,
// every pending order is cancelled, every position sold at market and buys are off for the rest of the day.
import { useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { api, type MtmLimit } from '../scalper/logic/api';
import type { Say } from './TradeWindowApp';

const text = (v: number | null | undefined) => (v == null ? '' : String(v));
const parse = (v: string) => (v.trim() === '' ? null : Number(v));

export function MtmLimitControl({ mtm, onSaved, say }: { mtm: MtmLimit | null; onSaved: () => void; say: Say }) {
  const [profit, setProfit] = useState(text(mtm?.profit));
  const [loss, setLoss] = useState(text(mtm?.loss));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setProfit(text(mtm?.profit)); setLoss(text(mtm?.loss)); }, [mtm?.profit, mtm?.loss]);
  const dirty = profit !== text(mtm?.profit) || loss !== text(mtm?.loss);

  const saveLimit = async () => {
    const p = parse(profit), l = parse(loss);
    if ((p != null && !(p > 0)) || (l != null && !(l > 0))) { say('error', 'MTM limits must be above ₹0 (leave empty for off).'); return; }
    setBusy(true);
    try {
      await api.mtmLimit(p, l);
      onSaved();
      say('info', p == null && l == null ? 'MTM limit off.' : `MTM limit set: profit ${p ?? 'off'} / loss ${l ?? 'off'} (₹, after charges).`);
    } catch (e) {
      say('error', e instanceof ApiError ? e.message : 'Could not save the MTM limit.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">MTM limit (₹ per day)
      <span className="tw-mtm" title="Day MTM after charges. At either limit: pending orders cancelled, all positions sold at market, no new buys today.">
        <input className="num" type="number" min={1} placeholder="Profit" aria-label="Profit limit" value={profit} onChange={(e) => setProfit(e.target.value)} />
        <input className="num" type="number" min={1} placeholder="Loss" aria-label="Loss limit" value={loss} onChange={(e) => setLoss(e.target.value)} />
        <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void saveLimit()}>Set</button>
      </span>
    </div>
  );
}
