// The money row at the top of every Trading Strategies page and the Total Capital page (owner 30/31-Oct-2026:
// capital, in use, net return, brokerage and taxes, the same everywhere, as tiles with bars, few words).
// Figures from logic/capital.ts. `extra` tiles (the index prices) sit in the same row.
import type { ReactNode } from 'react';
import { Rs, lakhs } from './StrategyCards';
import { returnPct, type Money as M } from './logic/capital';

const rs = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

export function MoneyStrip({ m, title, today, loaded = true, extra }: {
  m: M; title: string; today?: { pnl: number; sub: ReactNode }; loaded?: boolean; extra?: ReactNode;
}) {
  const pct = returnPct(m);
  const used = m.capital ? Math.min(100, (m.inUse / m.capital) * 100) : 0;
  const costs = m.brokerage + m.taxes;
  const mood = (v: number) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');
  return (
    <div className="sg-money">
      <div className="sg-fig">
        <span className="td-label">{title} capital</span>
        <span className="sg-fig-big num">{lakhs(m.capital)}</span>
        <span className="sg-bar"><i style={{ width: `${used}%` }} /></span>
        <span className="td-label">{m.inUse ? `${lakhs(m.inUse)} in use` : 'all free'}</span>
      </div>
      <div className={`sg-fig ${mood(m.net)}`}>
        <span className="td-label">Since start</span>
        {loaded ? <span className="sg-fig-big"><Rs v={m.net} /></span> : <span className="sg-fig-big">…</span>}
        <span className={`td-label ${m.net > 0 ? 'up' : m.net < 0 ? 'down' : ''}`}>{pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}% return` : ''}</span>
        <span className="td-label">open <Rs v={m.running} /></span>
      </div>
      {today && (
        <div className={`sg-fig ${mood(today.pnl)}`}>
          <span className="td-label">Today</span>
          <span className="sg-fig-big"><Rs v={today.pnl} /></span>
          <span className="td-label">{today.sub}</span>
        </div>
      )}
      <div className="sg-fig">
        <span className="td-label">Costs paid</span>
        <span className="sg-fig-big num">{rs(costs)}</span>
        <span className="sg-split" title={`Brokerage ${rs(m.brokerage)} · taxes ${rs(m.taxes)}`}>
          <i className="brk" style={{ width: `${costs ? (m.brokerage / costs) * 100 : 50}%` }} /><i className="tax" />
        </span>
        <span className="td-label"><b className="dot brk" />Brokerage {rs(m.brokerage)} · <b className="dot tax" />Taxes {rs(m.taxes)}</span>
      </div>
      {extra}
    </div>
  );
}
