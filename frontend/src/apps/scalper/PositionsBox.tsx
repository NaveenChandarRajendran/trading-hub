// Trade panel positions: each open Scalper position with its live P&L, 25 / 50 / 75 % partial exits, Exit and the
// trailing stop, and Exit all with the total.
import { useState } from 'react';
import { ApiError } from '../../shared/api';
import { EmptyState, Pill } from '../../shared/ui';
import { shortName, signedRupees, toneOf } from '../paper-trade/format';
import { liveLtp, liveUnrealized } from './BottomStrip';
import { api, type Position } from './logic/api';
import { EXIT_PCTS, exitTitle } from './logic/exitPlan';
import { TrailControl } from './TrailControl';
import type { Scalper } from './useScalper';

export function PositionsBox({ sc, enabled, onNotice }: {
  sc: Scalper;
  enabled: boolean; // market open, live prices
  onNotice: (kind: 'info' | 'error', text: string) => void;
}) {
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
      {!open.length ? <EmptyState>No open positions in this strategy.</EmptyState> : (
        <>
          {open.map((p) => (
            <div key={p.security_id} className="sc-pos-row">
              <Pill tone="accent">B</Pill>
              <span className="sc-pos-name" title={p.name}>{shortName(p)} <span className="muted num">× {p.open_qty}</span></span>
              <b className={`num ${toneOf(pnl(p))}`}>{signedRupees(pnl(p))}</b>
              <span className="sc-pos-actions">
                {'trail' in p && ( // a backend with partial exits / trailing (older ones would sell everything)
                  <>
                    {EXIT_PCTS.map((pct) => (
                      <button key={pct} className="btn sc-pct" disabled={busy || !enabled} title={exitTitle(p.open_lots, pct)}
                        onClick={() => run(() => api.exit(p.security_id, pct), `Sold ${pct}% of ${p.name} (paper).`)}>{pct}%</button>
                    ))}
                    <TrailControl pos={p} ltp={liveLtp(sc, p)} enabled={enabled && !busy}
                      onDone={(pos, text) => { sc.putPosition(pos); onNotice('info', text); }} onError={(text) => onNotice('error', text)} />
                  </>
                )}
                <button className="btn" disabled={busy} onClick={() => run(() => api.exit(p.security_id), `Exit sent for ${p.name}.`)}>Exit</button>
              </span>
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
