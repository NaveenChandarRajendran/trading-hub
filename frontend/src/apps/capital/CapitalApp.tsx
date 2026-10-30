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
import { Rs, lakhs } from '../strategies/StrategyCards';
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

/** Capital split as a ring, coloured per section. */
function Donut({ parts }: { parts: { name: string; v: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg viewBox="0 0 180 180" className="cap-donut" role="img" aria-label="Capital split">
      <circle cx="90" cy="90" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="22" />
      {parts.map((p) => {
        const len = (p.v / total) * C;
        const el = <circle key={p.name} cx="90" cy="90" r={R} fill="none" stroke={p.color} strokeWidth="22" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 90 90)" />;
        off += len;
        return el;
      })}
      <text x="90" y="86" textAnchor="middle" className="cap-donut-big">{lakhs(total)}</text>
      <text x="90" y="106" textAnchor="middle" className="cap-donut-small">paper capital</text>
    </svg>
  );
}

/** One section as a card: capital, used bar, net, and each strategy as a green / red bar. */
function SectionCard({ name, to, m, lines, color }: { name: string; to: string; m: M; lines: { key: string; name: string; m: M }[]; color: string }) {
  const max = Math.max(1, ...lines.map((l) => Math.abs(l.m.net)));
  const used = m.capital ? Math.min(100, (m.inUse / m.capital) * 100) : 0;
  return (
    <Link to={to} className="cap-card" style={{ ['--sec' as string]: color }}>
      <span className="cap-card-head"><b>{name}</b><span className="cap-card-net"><Rs v={m.net} /></span></span>
      <span className="cap-card-sub"><span>{lakhs(m.capital)}</span><span className={m.net > 0 ? 'up' : m.net < 0 ? 'down' : ''}>{pctText(m)}</span></span>
      <span className="sg-bar" title={`${lakhs(m.inUse)} in use`}><i style={{ width: `${used}%`, background: color }} /></span>
      <span className="td-label">{m.inUse ? `${lakhs(m.inUse)} in use` : 'all free'} · {m.trades} trade{m.trades === 1 ? '' : 's'}</span>
      <span className="cap-lines">
        {lines.map((l) => (
          <span key={l.key} className="cap-line">
            <span className="cap-line-name">{l.name}</span>
            <span className="cap-line-bar">
              <i className={l.m.net >= 0 ? 'up' : 'down'} style={{ width: `${(Math.abs(l.m.net) / max) * 50}%`, [l.m.net >= 0 ? 'left' : 'right']: '50%' }} />
            </span>
            <span className="cap-line-v"><Rs v={l.m.net} /></span>
          </span>
        ))}
      </span>
    </Link>
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
          <span className="td-label">Paper money since {longDate(START)}</span>
        </div>
        {since.failed && !since.loaded && <Alert kind="warn">Trade history could not be loaded. Is the backend window open?</Alert>}
        <MoneyStrip m={total} title="Total" loaded={since.loaded}
          today={{ pnl: today.total, sub: <>{today.open} live · {today.closed} closed</> }} />
      </section>

      <section className="card">
        <div className="card-head"><h3 className="td-title">Where the money is</h3><span className="td-label">Tap a section to open it</span></div>
        <div className="cap-grid">
          <div className="cap-ring">
            <Donut parts={secs.map((x, i) => ({ name: x.section.name, v: x.total.capital, color: COLORS[i] }))} />
            <div className="cap-legend">
              {secs.map((x, i) => <span key={x.section.id}><b style={{ background: COLORS[i] }} />{x.section.name} · {share(x.total.capital).toFixed(0)}%</span>)}
            </div>
          </div>
          {secs.map((x, i) => <SectionCard key={x.section.id} name={x.section.name} to={x.section.path} m={x.total} lines={x.lines} color={COLORS[i]} />)}
        </div>
        <p className="td-foot">Manual practice trades (not in the totals): <Money v={manual.net} /> from {manual.trades} trade{manual.trades === 1 ? '' : 's'}.</p>
      </section>

      <details className="card sg-fold">
        <summary><h3 className="td-title">Full table</h3><span className="td-label">every number, for the 15 Nov review</span></summary>
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
        <p className="td-foot">Net = booked (after charges) + open trades now. Every trade is 1 lot; capital is what each strategy is allowed. Sold options use an estimated margin.</p>
      </details>
    </div>
  );
}
