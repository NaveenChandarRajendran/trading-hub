// Total Capital & P&L (owner 30-Oct-2026: "in a very nutshell, how much overall I invested in this paper trade journey
// and how it is going on ... to understand how I am going to split and use my capital when I want to go live").
// Every strategy's capital, what is in use now, its net P&L since paper trading started, brokerage and taxes.
// PAPER ONLY. Data: useToday (open trades now), the journal since START, the Momentum 20 books.
import { Link } from 'react-router-dom';
import { Alert } from '../../shared/ui';
import { useToday } from '../today/useToday';
import { summarize } from '../today/logic/today';
import { Money } from '../today/TradeTables';
import { longDate } from '../paper-trade/format';
import { useMomentum, useSinceStart } from '../strategies/hooks';
import { MoneyStrip } from '../strategies/MoneyStrip';
import { lakhs } from '../strategies/StrategyCards';
import { TOTAL_CAPITAL } from '../strategies/catalog';
import { START, addUp, allSections, moneyOf, returnPct, type Money as M } from '../strategies/logic/capital';
import '../today/today.css';
import '../strategies/strategies.css';

const COLORS = ['#5b8def', '#e2a03f', '#9b6ddf', '#3fb58f'];
const rs = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const pctText = (m: M) => { const p = returnPct(m); return p == null ? '–' : `${p > 0 ? '+' : ''}${p.toFixed(2)}%`; };

function Row({ name, m, share, cls = '', to }: { name: string; m: M; share: number | null; cls?: string; to?: string }) {
  return (
    <tr className={cls}>
      <td className="txt">{to ? <Link to={to}>{name}</Link> : name}</td>
      <td className="num">{m.capital ? lakhs(m.capital) : '–'}</td>
      <td className="num">{share == null ? '' : <><span className="cap-bar" style={{ width: `${Math.max(3, share * 0.8)}px` }} />{share.toFixed(1)}%</>}</td>
      <td className="num">{m.inUse ? lakhs(m.inUse) : '–'}</td>
      <td><Money v={m.booked} /></td>
      <td><Money v={m.running} /></td>
      <td><b><Money v={m.net} /></b></td>
      <td className={`num ${m.net > 0 ? 'up' : m.net < 0 ? 'down' : ''}`}>{m.capital ? pctText(m) : '–'}</td>
      <td className="num">{rs(m.brokerage)}</td>
      <td className="num">{rs(m.taxes)}</td>
      <td className="num">{m.trades}</td>
      <td className="num"><span className="up">{m.won}</span> / <span className="down">{m.lost}</span></td>
    </tr>
  );
}

export default function CapitalApp() {
  const data = useToday();
  const since = useSinceStart();
  const mom = useMomentum();
  const secs = allSections(since.closed, data.rows, mom.data);
  const total = addUp(secs.map((s) => s.total));
  const manual = moneyOf(['Manual'], 0, since.closed, data.rows);
  const today = summarize(data.rows.filter((r) => !r.manual));
  const share = (c: number) => (TOTAL_CAPITAL ? (c / TOTAL_CAPITAL) * 100 : 0);

  return (
    <div className="ds td sg">
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Total Capital &amp; P&amp;L</h3>
          <span className="td-label">All paper strategies since {longDate(START)} · no real money</span>
        </div>
        {since.failed && !since.loaded && <Alert kind="warn">Trade history could not be loaded. Is the backend window open?</Alert>}
        <MoneyStrip m={total} title="Total" loaded={since.loaded}
          today={{ pnl: today.total, sub: <>{today.open} live · {today.closed} closed today (Momentum not included)</> }} />
        <h4 className="sg-detail-title">How the capital is split</h4>
        <div className="cap-split" role="img" aria-label="Capital split by section">
          {secs.map((s, i) => <i key={s.section.id} style={{ width: `${share(s.total.capital)}%`, background: COLORS[i] }} title={`${s.section.name} ${lakhs(s.total.capital)}`} />)}
        </div>
        <div className="cap-legend">
          {secs.map((s, i) => (
            <span key={s.section.id}><b style={{ background: COLORS[i] }} />{s.section.name} {lakhs(s.total.capital)} ({share(s.total.capital).toFixed(0)}%) · net <Money v={s.total.net} /></span>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Every strategy</h3>
          <span className="td-label">Net = booked (after charges) + open trades now (before their exit charges)</span>
        </div>
        <div className="td-scroll">
          <table className="t td-table cap-table">
            <thead>
              <tr>
                <th className="txt">Strategy</th><th>Capital</th><th>Share</th><th>In use now</th><th>Booked</th><th>Open now</th><th>Net P&amp;L</th>
                <th>Return</th><th>Brokerage</th><th>Taxes &amp; fees</th><th>Trades</th><th>Won / lost</th>
              </tr>
            </thead>
            <tbody>
              {secs.map((s) => [
                <Row key={s.section.id} name={s.section.name} m={s.total} share={share(s.total.capital)} cls="cap-sec" to={s.section.path} />,
                ...s.lines.map((l) => <Row key={l.key} name={l.name} m={l.m} share={share(l.m.capital)} cls="cap-sub" />),
              ])}
              <Row name="All strategies" m={total} share={100} cls="cap-total" />
            </tbody>
          </table>
        </div>
        <p className="td-foot">
          Manual trades (your practice trades, no fixed capital, not in the totals): net <Money v={manual.net} /> from {manual.trades} trade{manual.trades === 1 ? '' : 's'},
          brokerage {rs(manual.brokerage)}, taxes {rs(manual.taxes)}.
        </p>
        <p className="td-foot">
          Capital is the money set aside for each strategy, so its return can be compared. Every paper trade is still 1 lot. For sold
          options, &quot;in use&quot; is an estimated margin (check Dhan&apos;s margin calculator before going live). Brokerage is Dhan&apos;s ₹20 per
          order (an entry and an exit per trade). Taxes and fees are STT, GST, exchange, SEBI and stamp duty. Stock delivery (Momentum) has no brokerage.
        </p>
      </section>
    </div>
  );
}
