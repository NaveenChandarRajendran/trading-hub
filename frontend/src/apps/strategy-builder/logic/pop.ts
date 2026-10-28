// Probability of profit at expiry (pure). The index at expiry is taken as lognormal (risk-neutral drift at the rate r,
// volatility = ATM IV): P(S_T < x) = N((ln(x / S0) − (r − σ²/2)·T) / (σ·√T)). POP adds that probability over every
// stretch of index levels where the expiry P&L is above 0 (between consecutive breakevens).
import { DEFAULT_RATE, normCdf } from './blackScholes';
import { breakevens, payoffAt, type Leg } from './payoff';

export const POP_METHOD = 'Lognormal model: the index at expiry follows a lognormal distribution with the ATM implied '
  + 'volatility and the days left; POP = the probability that it settles where the expiry P&L is above zero '
  + '(between the breakevens). A model estimate, not a forecast.';

/** P(S_T < x) under the lognormal model. */
export function probBelow(x: number, S0: number, sigma: number, T: number, r = DEFAULT_RATE): number {
  if (x <= 0) return 0;
  if (!(T > 0) || !(sigma > 0)) return x > S0 ? 1 : 0;
  return normCdf((Math.log(x / S0) - (r - (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T)));
}

/** Probability (0..1) that the position ends in profit at expiry. atmIv in % (12.4), T in years. */
export function probabilityOfProfit(legs: Leg[], S0: number, atmIv: number, T: number, multiplier = 1, r = DEFAULT_RATE): number {
  const sigma = atmIv / 100;
  const cuts = [0, ...breakevens(legs, multiplier), Infinity];
  let p = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const mid = b === Infinity ? Math.max(a * 1.5, a + 1) : (a + b) / 2;
    if (payoffAt(legs, mid, multiplier) > 0) {
      p += (b === Infinity ? 1 : probBelow(b, S0, sigma, T, r)) - probBelow(a, S0, sigma, T, r);
    }
  }
  return Math.min(1, Math.max(0, p));
}
