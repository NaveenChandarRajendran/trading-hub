// Momentum page (owner 29-Oct-2026): the two Momentum 20 stock books (₹5 lakh each, PAPER), their stocks and trades.
// Stocks are bought at the open after each month-end check and held about a month. Data: GET /api/momentum/state.
import { useMomentum } from './hooks';
import { MomentumCards, MomentumDetail } from './MomentumParts';
import '../today/today.css';
import './strategies.css';

export default function MomentumApp() {
  const m = useMomentum();
  return (
    <div className="ds td sg">
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Momentum 20 books</h3>
          <span className="td-label">Each month-end: rank all NSE stocks by momentum, hold the top 20 for a month (paper, ₹5 lakh each)</span>
        </div>
        <MomentumCards s={m.data} failed={m.failed} />
      </section>
      <MomentumDetail s={m.data} failed={m.failed} />
    </div>
  );
}
