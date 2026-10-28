// Strategy Builder templates (pure): standard shapes placed around ATM for one expiry. Distances are % of spot, each
// snapped to the nearest listed strike; wings are always at least one strike beyond their short leg. Iron Condor A /
// B (Naveen's 95 % / 90 % rules) are added once their written rules arrive (docs/features/strategy-builder.md).
import { nearestStrike, newLeg, stepStrike, type BuilderLeg } from './legs';

export const TEMPLATES = [
  { id: 'long-straddle', label: 'Long Straddle' },
  { id: 'short-straddle', label: 'Short Straddle' },
  { id: 'long-strangle', label: 'Long Strangle' },
  { id: 'short-strangle', label: 'Short Strangle' },
  { id: 'bull-call-spread', label: 'Bull Call Spread' },
  { id: 'bear-put-spread', label: 'Bear Put Spread' },
  { id: 'iron-condor', label: 'Iron Condor' },
  { id: 'iron-butterfly', label: 'Iron Butterfly' },
] as const;
export type TemplateId = (typeof TEMPLATES)[number]['id'];

/** Distances from spot, in % (then snapped to strikes). */
export const TEMPLATE_PCT = { strangle: 1, spread: 1, condorShort: 1.5, condorWing: 2.5, butterflyWing: 1.5 };

/** The legs of a template for `expiry`, or [] without strikes / spot. */
export function buildTemplate(id: TemplateId, strikes: number[], spot: number | null, expiry: string): BuilderLeg[] {
  if (spot == null || !strikes.length) return [];
  const sorted = [...strikes].sort((a, b) => a - b);
  const atm = nearestStrike(sorted, spot)!;
  const at = (pct: number) => nearestStrike(sorted, spot * (1 + pct / 100))!;
  const beyond = (k: number, from: number, dir: 1 | -1) => (dir === 1 ? (k > from ? k : stepStrike(sorted, from, 1))
    : (k < from ? k : stepStrike(sorted, from, -1)));
  const leg = (side: 'B' | 'S', type: 'CE' | 'PE', strike: number) => newLeg(expiry, strike, { side, type });
  const P = TEMPLATE_PCT;
  switch (id) {
    case 'long-straddle': return [leg('B', 'CE', atm), leg('B', 'PE', atm)];
    case 'short-straddle': return [leg('S', 'CE', atm), leg('S', 'PE', atm)];
    case 'long-strangle': return [leg('B', 'CE', beyond(at(P.strangle), atm, 1)), leg('B', 'PE', beyond(at(-P.strangle), atm, -1))];
    case 'short-strangle': return [leg('S', 'CE', beyond(at(P.strangle), atm, 1)), leg('S', 'PE', beyond(at(-P.strangle), atm, -1))];
    case 'bull-call-spread': return [leg('B', 'CE', atm), leg('S', 'CE', beyond(at(P.spread), atm, 1))];
    case 'bear-put-spread': return [leg('B', 'PE', atm), leg('S', 'PE', beyond(at(-P.spread), atm, -1))];
    case 'iron-condor': {
      const sc = beyond(at(P.condorShort), atm, 1);
      const sp = beyond(at(-P.condorShort), atm, -1);
      return [leg('S', 'PE', sp), leg('S', 'CE', sc), leg('B', 'PE', beyond(at(-P.condorWing), sp, -1)),
        leg('B', 'CE', beyond(at(P.condorWing), sc, 1))];
    }
    case 'iron-butterfly':
      return [leg('S', 'CE', atm), leg('S', 'PE', atm), leg('B', 'CE', beyond(at(P.butterflyWing), atm, 1)),
        leg('B', 'PE', beyond(at(-P.butterflyWing), atm, -1))];
  }
}
