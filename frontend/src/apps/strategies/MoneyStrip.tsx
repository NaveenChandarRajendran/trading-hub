// The money row at the top of every Trading Strategies page and the Total Capital page (owner 30-Oct-2026: capital,
// capital in use, net return, brokerage and the taxes, the same everywhere). Figures from logic/capital.ts.
import type { ReactNode } from 'react';
import { Money } from '../today/TradeTables';
import { lakhs } from './StrategyCards';
import { returnPct, type Money as M } from './logic/capital';

export function MoneyStrip({ m, title, today, loaded = true, extra, brokerageNote = '₹20 per order' }: {
  m: M; title: string; today?: { pnl: number; sub: ReactNode }; loaded?: boolean; extra?: ReactNode; brokerageNote?: string;
}) {
  const pct = returnPct(m);
  const mood = m.net > 0 ? 'gain' : m.net < 0 ? 'loss' : '';
  return (
    <div className="sg-money">
      <div className="sg-fig">
        <span className="td-label">{title} capital</span>
        <span className="sg-fig-big num">{lakhs(m.capital)}</span>
        <span className="td-label">In use now {m.inUse ? lakhs(m.inUse) : '₹0'}{m.capital ? ` (${Math.round((m.inUse / m.capital) * 100)}%)` : ''}</span>
      </div>
      <div className={`sg-fig sg-pnl ${mood}`}>
        <span className="td-label">Net P&amp;L since start</span>
        {loaded ? <Money v={m.net} big /> : <span className="sg-fig-big">…</span>}
        <span className="td-label">{pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}% of capital · ` : ''}booked <Money v={m.booked} /> · open <Money v={m.running} /></span>
      </div>
      {today && (
        <div className={`sg-fig ${today.pnl > 0 ? 'gain' : today.pnl < 0 ? 'loss' : ''}`}>
          <span className="td-label">Today&apos;s P&amp;L</span>
          <Money v={today.pnl} big />
          <span className="td-label">{today.sub}</span>
        </div>
      )}
      <div className="sg-fig">
        <span className="td-label">Brokerage paid</span>
        <span className="sg-fig-big num">₹{Math.round(m.brokerage).toLocaleString('en-IN')}</span>
        <span className="td-label">{brokerageNote} · {m.trades} closed trade{m.trades === 1 ? '' : 's'}</span>
      </div>
      <div className="sg-fig">
        <span className="td-label">Taxes and fees</span>
        <span className="sg-fig-big num">₹{Math.round(m.taxes).toLocaleString('en-IN')}</span>
        <span className="td-label">STT, GST, exchange, SEBI, stamp duty</span>
      </div>
      {extra}
    </div>
  );
}
