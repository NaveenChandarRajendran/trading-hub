// Trade panel positions: each open Scalper position with its live P&L and Exit, and Exit all with the total.
import { useState } from 'react';
import { ApiError } from '../../shared/api';
import { EmptyState, Pill } from '../../shared/ui';
import { shortName, signedRupees, toneOf } from '../paper-trade/format';
import { liveUnrealized } from './BottomStrip';
import { api, type Position } from './logic/api';
import type { Scalper } from './useScalper';

export function PositionsBox({ sc, onNotice }: { sc: Scalper; onNotice: (kind: 'info' | 'error', text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const open = [...sc.positions.values()].filter((p) => p.open_qty > 0);
  const pnl = (p: Position) => p.realized + liveUnrealized(sc, p);
  const total = open.reduce((t, p) => t + pnl(p), 0);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      onNotice('info', done);
    } catch (e) {
      onNotice('error', e instanceof ApiError ? e.message : 'Exit failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sc-positions">
      <div className="sc-positions-head"><span className="card-title">Positions</span><span className="muted">{open.length} open</span></div>
      {!open.length ? <EmptyState>No open Scalper positions.</EmptyState> : (
        <>
          {open.map((p) => (
            <div key={p.security_id} className="sc-pos-row">
              <Pill tone="accent">B</Pill>
              <span className="sc-pos-name" title={p.name}>{shortName(p)} <span className="muted num">× {p.open_qty}</span></span>
              <b className={`num ${toneOf(pnl(p))}`}>{signedRupees(pnl(p))}</b>
              <button className="btn" disabled={busy} onClick={() => run(() => api.exit(p.security_id), `Exit sent for ${p.name}.`)}>Exit</button>
            </div>
          ))}
          <div className="sc-pos-foot">
            <button className="btn" disabled={busy} onClick={() => run(api.exitAll, 'Exit all sent.')}>Exit all</button>
            <span title="Open positions, before charges">P&amp;L (before charges) <b className={`num ${toneOf(total)}`}>{signedRupees(total)}</b></span>
          </div>
        </>
      )}
    </section>
  );
}
