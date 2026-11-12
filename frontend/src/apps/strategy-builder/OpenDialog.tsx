// "Open a draft or portfolio": your saved drafts, and the open positions of each of your options strategies (opened in
// a tab at their average price, so the payoff is the live P&L of what is held).
import { useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import type { Strategy } from '../../shared/strategy/api';
import { Dialog, EmptyState } from '../../shared/ui';
import { builderApi, optionsApi, type Draft, type OptionBook } from './logic/api';
import { shortExpiry } from './logic/legs';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function OpenDialog({ open, onClose, strategies, onOpenDraft, onOpenHeld }: {
  open: boolean;
  onClose: () => void;
  strategies: Strategy[] | null; // options strategies
  onOpenDraft: (d: Draft) => void;
  onOpenHeld: (b: OptionBook) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [books, setBooks] = useState<Record<number, OptionBook | 'error'>>({});
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    builderApi.drafts(ctrl.signal).then(setDrafts).catch((e) => { if (e.name !== 'AbortError') setErr(e instanceof ApiError ? e.message : 'Could not load your drafts.'); });
    for (const s of strategies ?? []) {
      optionsApi.positions(s.id, ctrl.signal).then((b) => setBooks((x) => ({ ...x, [s.id]: b })))
        .catch((e) => { if (e.name !== 'AbortError') setBooks((x) => ({ ...x, [s.id]: 'error' })); });
    }
    return () => ctrl.abort();
  }, [open, strategies]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title="Open a draft or portfolio" wide>
      {err && <p className="down sb-small">{err}</p>}
      <div className="sb-open-cols">
        <section aria-label="Drafts">
          <h3 className="card-title">Drafts</h3>
          {drafts == null ? <p className="muted sb-small">Loading…</p> : !drafts.length ? <EmptyState>No saved drafts yet.</EmptyState> : (
            <ul className="sb-open-list">
              {drafts.map((d) => (
                <li key={d.id}>
                  <button type="button" className="btn" onClick={() => onOpenDraft(d)}>{d.name}</button>
                  <span className="muted sb-small">{d.symbol} · {d.legs.length} leg{d.legs.length === 1 ? '' : 's'} · saved {when(d.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Portfolios">
          <h3 className="card-title">Portfolios (open positions)</h3>
          {strategies == null ? <p className="muted sb-small">Loading…</p> : !strategies.length ? <EmptyState>No options strategy yet: Paper trade creates one.</EmptyState> : (
            <ul className="sb-open-list">
              {strategies.map((s) => {
                const b = books[s.id];
                const held = b && b !== 'error' ? b.positions.filter((p) => p.qty) : [];
                const expiries = [...new Set(held.map((p) => shortExpiry(p.expiry)))].join(', ');
                return (
                  <li key={s.id}>
                    <button type="button" className="btn" disabled={!held.length} onClick={() => b && b !== 'error' && onOpenHeld(b)}>{s.name}</button>
                    <span className="muted sb-small">{b == null ? 'Loading…' : b === 'error' ? 'Positions unavailable'
                      : held.length ? `${held.length} open leg${held.length === 1 ? '' : 's'} · ${expiries}` : 'Nothing open'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
