// Summary under the chart: max profit / loss, reward : risk, breakevens (% from spot), probability of profit, net
// premium, margin (step 4), charges, and the position's Greeks with a per-leg breakdown.
import { inr } from '../../shared/grid';
import { rupees, signedRupees, toneOf } from '../paper-trade/format';
import { legGreeks, positionGreeks, type Leg, type WhatIf } from './logic/payoff';
import { POP_METHOD } from './logic/pop';
import { shortExpiry } from './logic/legs';
import type { Summary } from './logic/summary';

const money = (v: number | 'unlimited') => (v === 'unlimited' ? 'Unlimited' : signedRupees(v));
const signed = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${inr(d)(Math.abs(v))}`;

export function SummaryPanel({ s, legs, spot, whatIf, multiplier, margin }: {
  s: Summary;
  legs: Leg[];
  spot: number;
  whatIf: WhatIf;
  multiplier: number;
  margin: React.ReactNode; // filled in step 4
}) {
  const g = positionGreeks(legs, spot, whatIf, multiplier);
  const on = legs.filter((l) => l.include && l.lots > 0);
  return (
    <div className="sb-summary">
      <dl className="sb-stats">
        <div><dt>Max profit</dt><dd className={`num ${s.maxProfit === 'unlimited' ? 'up' : toneOf(s.maxProfit)}`}>{money(s.maxProfit)}</dd></div>
        <div><dt>Max loss</dt><dd className={`num ${s.maxLoss === 'unlimited' ? 'down' : toneOf(s.maxLoss)}`}>{money(s.maxLoss)}</dd></div>
        <div><dt title="₹ at risk for every ₹1 of maximum profit">Reward : risk</dt><dd className="num">{s.riskPerReward != null ? `1 : ${inr(2)(s.riskPerReward)}` : '–'}</dd></div>
        <div><dt title={POP_METHOD}>Probability of profit ⓘ</dt><dd className="num">{s.pop != null ? `${inr(1)(s.pop * 100)}%` : '–'}</dd></div>
        <div><dt>{s.net >= 0 ? 'Net credit' : 'Net debit'}</dt><dd className="num">{rupees(Math.abs(s.net))}</dd></div>
        <div><dt>Margin</dt><dd className="num">{margin}</dd></div>
        <div><dt title="Brokerage, STT, exchange, SEBI, stamp and GST for entering and exiting every leg at today's prices">Charges (in + out)</dt><dd className="num">{s.charges != null ? `≈ ${rupees(s.charges)}` : '–'}</dd></div>
        <div className="sb-stat-wide">
          <dt>Breakevens</dt>
          <dd className="num">{s.breakevens.length ? s.breakevens.map((b) => (
            <span key={b.level} className="sb-be-val">{inr(2)(b.level)} <span className="muted">({signed(b.pct)}%)</span></span>
          )) : '–'}</dd>
        </div>
      </dl>
      <div className="sb-greeks">
        <span className="muted">Greeks</span>
        <span title="₹ change for a 1-point rise in the index">Δ <b className={`num ${toneOf(g.delta)}`}>{signed(g.delta)}</b></span>
        <span title="Change in delta for a 1-point rise">Γ <b className="num">{signed(g.gamma, 4)}</b></span>
        <span title="₹ per calendar day from time decay">Θ <b className={`num ${toneOf(g.theta)}`}>{signedRupees(g.theta)}/day</b></span>
        <span title="₹ for a 1-point rise in implied volatility">Vega <b className={`num ${toneOf(g.vega)}`}>{signedRupees(g.vega)}/pt</b></span>
      </div>
      <details className="sb-leg-greeks">
        <summary>Per-leg Greeks</summary>
        <table className="t">
          <thead><tr><th>Leg</th><th>IV</th><th>Δ</th><th>Γ</th><th>Θ ₹/day</th><th>Vega ₹/pt</th></tr></thead>
          <tbody>
            {on.map((l) => {
              const lg = legGreeks(l, spot, whatIf, multiplier);
              return (
                <tr key={l.id}>
                  <td className={l.side === 'B' ? 'up' : 'down'}>{l.side} {l.lots * multiplier}× {inr(0)(l.strike)} {l.type} <span className="muted">{shortExpiry(l.expiry)}</span></td>
                  <td className="num">{l.iv != null ? `${inr(1)(l.iv)}%` : '–'}</td>
                  <td className="num">{signed(lg.delta)}</td>
                  <td className="num">{signed(lg.gamma, 4)}</td>
                  <td className="num">{signed(lg.theta)}</td>
                  <td className="num">{signed(lg.vega)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}
