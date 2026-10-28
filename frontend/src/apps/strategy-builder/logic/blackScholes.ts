// Black–Scholes for European index options (NIFTY / BANKNIFTY options are European): price, Greeks and implied
// volatility. Pure. Units: S, K in index points; T in years; r and sigma as decimals (0.065, 0.12). No dividend yield.

export type OptionType = 'CE' | 'PE';

export const DEFAULT_RATE = 0.065; // risk-free rate (configurable in the page)
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal density. */
export const normPdf = (x: number) => Math.exp(-0.5 * x * x) / SQRT_2PI;

/** Standard normal CDF (Hart / West double-precision approximation, error below 1e-14). */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 0.0352624965998911 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 0.0883883476483184 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      const f = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))));
      c = e / (f * 2.506628274631);
    }
  }
  return x <= 0 ? c : 1 - c;
}

export interface Greeks {
  price: number;
  delta: number; // per 1 point of the underlying
  gamma: number; // delta change per 1 point
  theta: number; // price change per calendar day (negative for a long option)
  vega: number; // price change per 1 volatility point (sigma +0.01)
}

const intrinsic = (type: OptionType, S: number, K: number) => Math.max(0, type === 'CE' ? S - K : K - S);

/** Price and Greeks of one option (per unit). At expiry (T <= 0) or with no volatility: intrinsic value. */
export function bs(type: OptionType, S: number, K: number, T: number, sigma: number, r = DEFAULT_RATE): Greeks {
  if (!(T > 0) || !(sigma > 0) || !(S > 0) || !(K > 0)) {
    const fwdK = T > 0 ? K * Math.exp(-r * T) : K;
    const itm = type === 'CE' ? S > fwdK : S < fwdK;
    return { price: intrinsic(type, S, fwdK), delta: itm ? (type === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = K * Math.exp(-r * T);
  const pdf = normPdf(d1);
  const gamma = pdf / (S * sigma * sqrtT);
  const vega = (S * pdf * sqrtT) / 100;
  const decay = -(S * pdf * sigma) / (2 * sqrtT);
  if (type === 'CE') {
    return { price: S * normCdf(d1) - disc * normCdf(d2), delta: normCdf(d1), gamma,
      theta: (decay - r * disc * normCdf(d2)) / 365, vega };
  }
  return { price: disc * normCdf(-d2) - S * normCdf(-d1), delta: normCdf(d1) - 1, gamma,
    theta: (decay + r * disc * normCdf(-d2)) / 365, vega };
}

/**
 * Implied volatility from a market price (bisection on 0.1%..500%), or null when the price is outside what any
 * volatility can give (below intrinsic, above the forward bound). Used when the chain has no IV for a strike.
 */
export function impliedVol(type: OptionType, price: number, S: number, K: number, T: number, r = DEFAULT_RATE): number | null {
  if (!(price > 0) || !(T > 0)) return null;
  let lo = 0.001;
  let hi = 5;
  const at = (v: number) => bs(type, S, K, T, v, r).price;
  if (price < at(lo) - 1e-9 || price > at(hi) + 1e-9) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < price) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

/** Years from `nowMs` to 15:30 IST on `expiry` (YYYY-MM-DD), never below 0. */
export function yearsToExpiry(expiry: string, nowMs: number): number {
  const end = Date.parse(`${expiry}T15:30:00+05:30`);
  return Math.max(0, (end - nowMs) / (365 * 86_400_000));
}
