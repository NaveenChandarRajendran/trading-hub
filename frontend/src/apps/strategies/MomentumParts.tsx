// Momentum 20 stock books (owner 28-Oct-2026): two ₹5 lakh PAPER books, with and without the Nifty 200-day switch.
// Cards for Today and the Momentum page; the page adds each book's stocks and its trades. Data: GET /api/momentum/state.
import { Link } from 'react-router-dom';
import { EmptyState } from '../../shared/ui';
import { price, signedRupees, toneOf } from '../paper-trade/format';
import { bookStatus, bookedPnl, switchText, type MomBook, type MomState } from '../today/logic/momentum';
import { Money } from '../today/TradeTables';

const pctText = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const rs = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const short = (b: MomBook) => (b.key === 'momSwitch' ? 'With Nifty switch' : 'Always invested');
const kind = (b: MomBook) => (b.holdings.length ? 'trade' : b.pnl > 0 ? 'up' : b.pnl < 0 ? 'down' : 'wait');

export function MomentumCards({ s, failed, compact = false }: { s: MomState | undefined; failed: boolean; compact?: boolean }) {
  if (!s) return <p className="td-foot">{failed ? 'Momentum books are not running (backend off or not set up yet).' : 'Loading…'}</p>;
  return (
    <div className="sg-cards">
      {s.books.map((b) => {
        const card = (
          <>
            <span className="sg-card-top"><span className="td-tag s4" title={b.name}>{short(b)}</span><Money v={b.pnl} /></span>
            <span className={`sg-chip ${kind(b)}`}>{b.holdings.length ? `Holding ${b.holdings.length} stocks` : 'In cash'}</span>
            <span className="sg-line">Value {rs(b.value)} of {rs(b.capital)} ({pctText(b.pnlPct)})</span>
            <span className="sg-line">{bookStatus(b, s)}</span>
          </>
        );
        return compact
          ? <Link key={b.key} to="/strategies/momentum" className={`sg-card ${kind(b)}`}>{card}</Link>
          : <div key={b.key} className={`sg-card static ${kind(b)}`}>{card}</div>;
      })}
    </div>
  );
}

function BookDetail({ b }: { b: MomBook }) {
  const sells = b.trades.filter((t) => t.side === 'SELL');
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="td-title">{b.name}</h3>
        <span className="td-label">Cash {rs(b.cash)} · booked <span className={toneOf(bookedPnl(b))}>{signedRupees(bookedPnl(b))}</span> · {sells.length} sold so far</span>
      </div>
      {!b.holdings.length ? <EmptyState>No stocks held right now.</EmptyState> : (
        <div className="td-scroll">
          <table className="t td-table">
            <thead><tr><th className="txt">Stock</th><th>Since</th><th>Qty</th><th>Bought at</th><th>Now</th><th>Money in</th><th>Value</th><th>P&amp;L</th></tr></thead>
            <tbody>
              {b.holdings.map((h) => (
                <tr key={h.sym} className={`td-row ${h.pnl > 0 ? 'gain' : h.pnl < 0 ? 'loss' : ''}`}>
                  <td className="txt"><b>{h.sym}</b></td><td className="num">{h.since}</td><td className="num">{h.qty.toFixed(0)}</td>
                  <td className="num">{price(h.entry)}</td><td className="num">{price(h.last)}</td><td className="num">{rs(h.money)}</td>
                  <td className="num">{rs(h.value)}</td>
                  <td><span className="td-level"><Money v={h.pnl} /><span className={`td-pct ${toneOf(h.pnl)}`}>{pctText(h.pnlPct)}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {b.trades.length > 0 && (
        <details className="sg-trades">
          <summary>All trades of this book ({b.trades.length})</summary>
          <div className="td-scroll">
            <table className="t td-table">
              <thead><tr><th className="txt">Day</th><th className="txt">Stock</th><th className="txt">Side</th><th>Qty</th><th>Price</th><th>Charges</th><th>P&amp;L</th></tr></thead>
              <tbody>
                {[...b.trades].reverse().map((t, i) => (
                  <tr key={`${t.day}-${t.sym}-${t.side}-${i}`}>
                    <td className="txt">{t.day}</td><td className="txt">{t.sym}</td>
                    <td className="txt"><span className={`td-dir ${t.side === 'SELL' ? 'sold' : 'bought'}`}>{t.side === 'SELL' ? 'SOLD' : 'BOUGHT'}</span></td>
                    <td className="num">{t.qty.toFixed(0)}</td><td className="num">{price(t.price)}</td><td className="num">{price(t.charges)}</td>
                    <td>{t.side === 'SELL' ? <Money v={t.pnl ?? null} /> : <span className="td-none">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

export function MomentumDetail({ s, failed }: { s: MomState | undefined; failed: boolean }) {
  if (!s) return <section className="card"><EmptyState>{failed ? 'Momentum books are not running (backend off or not set up yet).' : 'Loading…'}</EmptyState></section>;
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">The market switch</h3>
          <span className="td-label">Next month-end check {s.nextCheck}{s.busy ? ' · updating…' : ''}</span>
        </div>
        <p className="sg-how">{switchText(s.signal)}. The book <b>with</b> the switch holds stocks only while Nifty is above its 200-day average;
          the other book always holds the top 20.</p>
        {s.error && <p className="td-foot down">{s.error}</p>}
        {s.signal && <p className="sg-how"><b>Top 20 at the last check:</b> {s.signal.top.join(', ')}</p>}
      </section>
      {s.books.map((b) => <BookDetail key={b.key} b={b} />)}
    </>
  );
}
