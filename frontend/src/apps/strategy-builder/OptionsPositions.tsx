// Paper positions of an options strategy (backend options_service.positions): every open leg (long or short) with its
// average, LTP and P&L, the strategy's booked P&L, margin blocked and free funds; Exit a leg / Exit all at market; open
// the legs in a tab to see their live payoff. Re-read every 5 s. PAPER ONLY.
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { optionStrategies, strategyApi, type Strategy } from '../../shared/strategy/api';
import { Alert, EmptyState, Pill } from '../../shared/ui';
import { price, rupees, signedRupees, toneOf } from '../paper-trade/format';
import { optionsApi, type OptionBook } from './logic/api';
import { shortExpiry } from './logic/legs';
import { rememberedStrategy } from './PaperTradeDialog';

const REFRESH_MS = 5000;

export function OptionsPositions({ show, onOpenInTab, onMessage }: {
  show: { strategyId: number; nonce: number } | null; // after a placed basket: switch to that strategy and re-read
  onOpenInTab: (book: OptionBook) => void;
  onMessage: (kind: 'info' | 'error', text: string) => void;
}) {
  const [list, setList] = useState<Strategy[]>([]);
  const [pick, setPick] = useState<number | null>(rememberedStrategy);
  const [book, setBook] = useState<OptionBook | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    strategyApi.list(false).then((all) => {
      const opts = optionStrategies(all);
      setList(opts);
      setPick((p) => (p && opts.some((s) => s.id === p) ? p : opts[0]?.id ?? null));
    }).catch(() => undefined);
  }, [show?.nonce]);
  useEffect(() => { if (show) setPick(show.strategyId); }, [show?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const read = useCallback((signal?: AbortSignal) => {
    if (pick == null) return;
    optionsApi.positions(pick, signal).then((b) => { setBook(b); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Positions unavailable.'); });
  }, [pick]);
  useEffect(() => {
    const ctrl = new AbortController();
    read(ctrl.signal);
    const t = setInterval(() => read(), REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [read, show?.nonce]);

  const exit = async (securityId?: number) => {
    if (pick == null) return;
    const what = securityId == null ? 'every open leg' : 'this leg';
    if (!window.confirm(`Exit ${what} at market (paper)?`)) return;
    setBusy(true);
    try {
      const r = await optionsApi.exit(pick, securityId);
      setBook(r);
      const booked = r.fills.reduce((t, f) => t + f.realized, 0);
      onMessage('info', `Exited ${r.fills.length} leg${r.fills.length === 1 ? '' : 's'}: ${signedRupees(booked)} booked (before charges).`);
    } catch (e) { onMessage('error', e instanceof ApiError ? e.message : 'Exit failed.'); } finally { setBusy(false); }
  };

  if (!list.length) return null; // no options strategy yet: Paper trade offers to create one
  const f = book?.funds;
  const booked = f ? f.realized - f.charges : 0;
  return (
    <section className="card sb-op">
      <div className="card-head">
        <span className="card-title">Paper positions</span>
        <select value={pick ?? ''} onChange={(e) => setPick(Number(e.target.value))} aria-label="Options strategy">
          {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {book && (
          <span className="sb-op-nums">
            <span>Live P&amp;L <b className={`num ${toneOf(book.unrealized)}`}>{signedRupees(book.unrealized)}</b></span>
            <span>Booked <b className={`num ${toneOf(booked)}`}>{signedRupees(booked)}</b></span>
            <span>Margin <b className="num">{rupees(f!.blockedMargin)}</b></span>
            <span>Available <b className="num">{rupees(f!.available)}</b></span>
          </span>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {book?.meta.lastError && <Alert kind="warn">{book.meta.lastError}</Alert>}
      {!book ? <p className="muted sb-small">Loading…</p> : !book.positions.length ? <EmptyState>No open legs in {book.strategy.name}.</EmptyState> : (
        <>
          <table className="t">
            <thead><tr><th>Leg</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th><th /></tr></thead>
            <tbody>
              {book.positions.map((p) => (
                <tr key={p.security_id}>
                  <td className={p.qty > 0 ? 'up' : 'down'}>
                    {p.qty > 0 ? 'Long' : 'Short'} {inr(0)(p.strike)} {p.optionType} <span className="muted">{shortExpiry(p.expiry)}</span>
                    {p.settlementPending && <> <Pill tone="warn">settlement pending</Pill></>}
                  </td>
                  <td className="num">{p.qty} <span className="muted">({Math.abs(p.lots)} lot{Math.abs(p.lots) === 1 ? '' : 's'})</span></td>
                  <td className="num">{price(p.avg)}</td>
                  <td className="num">{price(p.ltp)}</td>
                  <td className={`num ${toneOf(p.unrealized)}`}>{signedRupees(p.unrealized)}</td>
                  <td><button type="button" className="btn" disabled={busy || !book.meta.acceptingOrders} onClick={() => exit(p.security_id)}>Exit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sb-op-actions">
            <button type="button" className="btn" onClick={() => onOpenInTab(book)}>Open in a tab (live payoff)</button>
            <button type="button" className="btn" disabled={busy || !book.meta.acceptingOrders} onClick={() => exit()}>Exit all</button>
            {!book.meta.acceptingOrders && <span className="muted sb-small">Exits 09:15–15:15 IST. Open legs settle at 15:30 on their expiry day.</span>}
          </div>
        </>
      )}
    </section>
  );
}
