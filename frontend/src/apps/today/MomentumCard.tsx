// Momentum 20 stock books on the Today page (owner 28-Oct-2026): two Rs 5 lakh PAPER books, one glance each.
// Data: GET /api/momentum/state (backend momentum_book.py). Logic: logic/momentum.ts.
import { useEffect, useState } from 'react';
import { API_BASE, getJson } from '../../shared/api';
import { price, signedRupees, toneOf } from '../paper-trade/format';
import { bookStatus, bookedPnl, switchText, type MomBook, type MomState } from './logic/momentum';

const REFRESH_MS = 60000;
const pctText = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

function Book({ b, s }: { b: MomBook; s: MomState }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`td-mom-book ${toneOf(b.pnl) === 'up' ? 'gain' : toneOf(b.pnl) === 'down' ? 'loss' : ''}`}>
      <div className="td-mom-row">
        <div className="td-strat-name">
          <span className="td-who">{b.name}</span>
          <span className="td-strat-where">{bookStatus(b, s)}</span>
        </div>
        <div className="td-mom-fig"><span className="td-label">Value</span><span>₹{Math.round(b.value).toLocaleString('en-IN')}</span></div>
        <div className={`td-mom-fig td-strat-pnl ${toneOf(b.pnl)}`}><span className="td-label">Since start</span><span>{signedRupees(b.pnl)} ({pctText(b.pnlPct)})</span></div>
        <div className="td-mom-fig"><span className="td-label">Booked</span><span className={toneOf(bookedPnl(b))}>{signedRupees(bookedPnl(b))}</span></div>
        {b.holdings.length > 0 && <button type="button" className="btn ghost" onClick={() => setOpen(!open)}>{open ? 'Hide stocks' : 'Show stocks'}</button>}
      </div>
      {open && (
        <div className="td-scroll">
          <table className="t td-table">
            <thead><tr><th className="txt">Stock</th><th>Since</th><th>Qty</th><th>Bought</th><th>Now</th><th>P&amp;L</th></tr></thead>
            <tbody>
              {b.holdings.map((h) => (
                <tr key={h.sym} className={`td-row ${h.pnl > 0 ? 'gain' : h.pnl < 0 ? 'loss' : ''}`}>
                  <td className="txt">{h.sym}</td><td className="num">{h.since}</td><td className="num">{h.qty.toFixed(1)}</td>
                  <td className="num">{price(h.entry)}</td><td className="num">{price(h.last)}</td>
                  <td className={`num ${toneOf(h.pnl)}`}>{signedRupees(h.pnl)} ({pctText(h.pnlPct)})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function MomentumCard() {
  const [s, setS] = useState<MomState | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => getJson<MomState>(API_BASE, '/api/momentum/state').then((d) => { if (live) { setS(d); setErr(''); } }).catch(() => live && setErr('Momentum books not available (backend off or not set up).'));
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => { live = false; window.clearInterval(id); };
  }, []);
  if (!s && !err) return null;
  return (
    <section className="card td-mom">
      <h2 className="td-title">Momentum 20 · stock books (paper)</h2>
      {err && <p className="td-foot">{err}</p>}
      {s && (
        <>
          <p className="td-sub">{switchText(s.signal)} · next month-end check {s.nextCheck}{s.busy ? ' · updating…' : ''}</p>
          {s.error && <p className="td-foot down">{s.error}</p>}
          {s.books.map((b) => <Book key={b.key} b={b} s={s} />)}
          {s.signal && <p className="td-foot">Top 20 at the last check: {s.signal.top.join(', ')}</p>}
        </>
      )}
    </section>
  );
}
