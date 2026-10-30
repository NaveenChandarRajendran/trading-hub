// Momentum page (owner 29-Oct-2026): the two Momentum 20 stock books (₹5 lakh each, PAPER), their stocks and trades.
// Stocks are bought at the open after each month-end check and held about a month. Data: GET /api/momentum/state.
// Owner 30-Oct-2026: the same money row as the other strategy pages, rules inside the cards, stocks folded.
import { Link } from 'react-router-dom';
import { useMomentum } from './hooks';
import { MomentumCards, MomentumDetail } from './MomentumParts';
import { MoneyStrip } from './MoneyStrip';
import { sectionMoney } from './logic/capital';
import '../today/today.css';
import './strategies.css';

export default function MomentumApp() {
  const m = useMomentum();
  const money = sectionMoney('momentum', [], [], m.data).total;
  return (
    <div className="ds td sg">
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Momentum at a glance</h3>
          <span className="td-label">Paper trading · two books of ₹5 lakh each · <Link to="/capital">All strategies: Total Capital &amp; P&amp;L →</Link></span>
        </div>
        <MoneyStrip m={money} title="Momentum" loaded={m.data != null} brokerageNote="none on stock delivery" />
      </section>
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Momentum strategies</h3>
          <span className="td-label">Each month-end: rank NSE stocks by momentum, hold the top 20 for a month · click a card for its rules</span>
        </div>
        <MomentumCards s={m.data} failed={m.failed} />
      </section>
      <MomentumDetail s={m.data} failed={m.failed} />
    </div>
  );
}
