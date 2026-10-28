// The Builder's summary panel (pure): max profit / loss, reward : risk, breakevens with % from spot, probability of
// profit, net premium and the charges estimate for entering and later exiting every leg (paper_charges.py rates).
import type { ChargeRates } from '../../paper-trade/logic/api';
import { estimateCharges } from '../../paper-trade/logic/ticket';
import { yearsToExpiry } from './blackScholes';
import { breakevens, extremes, legQty, netPremium, rewardRisk, type Extreme, type Leg } from './payoff';
import { probabilityOfProfit } from './pop';

export interface Summary {
  net: number; // + credit, − debit (₹)
  maxProfit: Extreme;
  maxLoss: Extreme;
  riskPerReward: number | null; // ₹ risked per ₹1 of max profit ("1 : x")
  breakevens: { level: number; pct: number }[]; // pct from spot
  pop: number | null; // 0..1, null without ATM IV / time
  charges: number | null; // entry + exit at today's prices, null without rates
  expiry: string | null; // the nearest expiry among the legs (POP is at it)
}

/** Entry + exit charges: each leg once on its own side and once on the other, both at its current price. */
export function basketCharges(legs: Leg[], rates: ChargeRates, multiplier = 1): number {
  let t = 0;
  for (const l of legs) {
    if (!l.include || l.lots <= 0) continue;
    const value = l.price * legQty(l, multiplier);
    const [open, close] = l.side === 'B' ? ['BUY', 'SELL'] as const : ['SELL', 'BUY'] as const;
    t += estimateCharges(open, value, rates) + estimateCharges(close, value, rates);
  }
  return Math.round(t * 100) / 100;
}

export function summarize(legs: Leg[], spot: number | null, multiplier: number, atmIv: number | null,
  nowMs: number, rates: ChargeRates | null): Summary | null {
  const on = legs.filter((l) => l.include && l.lots > 0);
  if (!on.length) return null;
  const expiry = on.map((l) => l.expiry).sort()[0];
  const { maxProfit, maxLoss } = extremes(on, multiplier);
  const rr = rewardRisk(on, multiplier);
  const T = yearsToExpiry(expiry, nowMs);
  return {
    net: netPremium(on, multiplier),
    maxProfit,
    maxLoss,
    riskPerReward: rr ? 1 / rr : null,
    breakevens: breakevens(on, multiplier).map((level) => ({ level, pct: spot ? ((level - spot) / spot) * 100 : 0 })),
    pop: spot && atmIv && T > 0 ? probabilityOfProfit(on, spot, atmIv, T, multiplier) : null,
    charges: rates ? basketCharges(on, rates, multiplier) : null,
    expiry,
  };
}
