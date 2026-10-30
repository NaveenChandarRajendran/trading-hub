// OI build-up (owner 30-Oct-2026): put-heavy OI = put writers = support = Bullish; call-heavy = resistance = Bearish.
// One reading for every page that shows an OI verdict, so they agree. Mirrors backend sig_oi.build_up.
export type BuildVerdict = 'Bullish' | 'Bearish' | 'Neutral';
export interface BuildUp { verdict: BuildVerdict; putShare: number }
export const BUILD_LEAN = 0.1; // puts (or calls) at least 55 % of the total

/** put / call: OI + change (or the change alone); putChg / callChg: today's change, which must point the same way. */
export function buildUp(put: number, call: number, putChg?: number, callChg?: number): BuildUp | null {
  const den = Math.abs(put) + Math.abs(call);
  if (!den) return null;
  const lean = (put - call) / den;
  const added = putChg == null || callChg == null ? null : Math.sign(putChg - callChg);
  const verdict: BuildVerdict = lean >= BUILD_LEAN && added !== -1 && added !== 0 ? 'Bullish'
    : lean <= -BUILD_LEAN && added !== 1 && added !== 0 ? 'Bearish' : 'Neutral';
  return { verdict, putShare: (lean + 1) * 50 };
}
