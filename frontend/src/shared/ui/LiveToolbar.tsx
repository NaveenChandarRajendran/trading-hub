// Toolbar + alerts shared by the live (Dhan) option-chain pages. Render inside a `.ds` container.
import type { ReactNode } from 'react';
import { SYMBOLS } from '../../apps/option-strategy/config/expiries';
import { nseDate } from '../dhan/chainAdapter';
import { TOKEN_HELP, errorText, isTokenError } from '../live/liveStatus';
import { REFRESH_OPTIONS, type LiveChain } from '../live/useLiveChain';
import { Alert, Pill, Segmented, Status } from './index';

export function LiveToolbar({ live, children }: { live: LiveChain; children?: ReactNode }) {
  const { status, data, error } = live;
  const meta = data?.meta;
  return (
    <>
      <section className="card">
        <div className="toolbar">
          <label className="field">Index
            <select value={live.symbol} onChange={(e) => live.setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry
            <select value={live.expiry} onChange={(e) => live.setExpiry(e.target.value)} disabled={!live.expiries.length}>
              {!live.expiries.length && <option value="">…</option>}
              {live.expiries.map((x) => <option key={x} value={x}>{nseDate(x)}</option>)}
            </select>
          </label>
          {!live.manual && (
            <div className="field">Auto-refresh
              <Segmented label="Auto-refresh" options={REFRESH_OPTIONS} value={String(live.intervalSec) as (typeof REFRESH_OPTIONS)[number]['value']}
                onChange={(v) => live.setIntervalSec(Number(v))} />
            </div>
          )}
          {children}
          <div className="toolbar-end">
            {status.closed && <Pill tone="neutral">Market closed</Pill>}
            <Status kind={status.kind}>{status.label}</Status>
            <button className="btn" onClick={() => void live.refresh()} disabled={live.loading}>
              {live.loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
      </section>
      {error != null && (
        <Alert kind="error">
          {errorText(error)}
          {meta && !isTokenError(error) && ' Showing the last data received.'}
        </Alert>
      )}
      {!error && meta?.tokenExpired && <Alert kind="error">{TOKEN_HELP}</Alert>}
      {!error && meta && !meta.tokenExpired && meta.lastError && (
        <Alert kind="warn">The latest Dhan refresh failed ({meta.lastError}). Showing the last good data.</Alert>
      )}
    </>
  );
}
