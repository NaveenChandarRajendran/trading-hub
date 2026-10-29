// Strategy Builder templates (pure): standard shapes placed around ATM for one expiry. Distances are % of spot, each
// snapped to the nearest listed strike; wings are always at least one strike beyond their short leg. Iron Condor A /
// B (Naveen's 95 % / 90 % rules) are added once their written rules arrive (docs/features/strategy-builder.md).
// With a liquidity check, a strike that is untraded or illiquid moves outward (further out of the money: calls up, puts
// down, sold and bought legs alike) to the nearest liquid one, and each move is noted ("77,200 CE untraded → using
// 77,300 CE"). Strategy Lab rules will use the same outwardStrike (shared/dhan/liquidity.ts).
import { outwardStrike } from '../../../shared/dhan/liquidity';
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

/** Liquidity of each strike for buildTemplate: why(strike, type) = '' when liquid, else 'untraded' / 'illiquid'. */
export interface TemplateLiquidity { why: (strike: number, type: 'CE' | 'PE') => string; notes: string[] }

const fmt = (k: number) => k.toLocaleString('en-IN');

/** The legs of a template for `expiry`, or [] without strikes / spot. With `liquidity`, strikes are checked (above). */
export function buildTemplate(id: TemplateId, strikes: number[], spot: number | null, expiry: string,
  liquidity?: TemplateLiquidity): BuilderLeg[] {
  if (spot == null || !strikes.length) return [];
  const sorted = [...strikes].sort((a, b) => a - b);
  const atm = nearestStrike(sorted, spot)!;
  const at = (pct: number) => nearestStrike(sorted, spot * (1 + pct / 100))!;
  const beyond = (k: number, from: number, dir: 1 | -1) => (dir === 1 ? (k > from ? k : stepStrike(sorted, from, 1))
    : (k < from ? k : stepStrike(sorted, from, -1)));
  const liquid = (k: number, type: 'CE' | 'PE') => {
    if (!liquidity) return k;
    const why = liquidity.why(k, type);
    if (!why) return k;
    const to = outwardStrike(sorted, k, type, (s) => liquidity.why(s, type));
    liquidity.notes.push(to == null ? `${fmt(k)} ${type} ${why}, and no liquid strike beyond it: kept`
      : `${fmt(k)} ${type} ${why} → using ${fmt(to)} ${type}`);
    return to ?? k;
  };
  const leg = (side: 'B' | 'S', type: 'CE' | 'PE', strike: number) => newLeg(expiry, liquid(strike, type), { side, type });
  const P = TEMPLATE_PCT;
  switch (id) {
    case 'long-straddle': return [leg('B', 'CE', atm), leg('B', 'PE', atm)];
    case 'short-straddle': return [leg('S', 'CE', atm), leg('S', 'PE', atm)];
    case 'long-strangle': return [leg('B', 'CE', beyond(at(P.strangle), atm, 1)), leg('B', 'PE', beyond(at(-P.strangle), atm, -1))];
    case 'short-strangle': return [leg('S', 'CE', beyond(at(P.strangle), atm, 1)), leg('S', 'PE', beyond(at(-P.strangle), atm, -1))];
    case 'bull-call-spread': { const b = liquid(atm, 'CE'); return [leg('B', 'CE', b), leg('S', 'CE', beyond(at(P.spread), b, 1))]; }
    case 'bear-put-spread': { const b = liquid(atm, 'PE'); return [leg('B', 'PE', b), leg('S', 'PE', beyond(at(-P.spread), b, -1))]; }
    case 'iron-condor': { // the shorts are checked first, so the wings stay beyond the strikes actually used
      const sc = liquid(beyond(at(P.condorShort), atm, 1), 'CE');
      const sp = liquid(beyond(at(-P.condorShort), atm, -1), 'PE');
      return [leg('S', 'PE', sp), leg('S', 'CE', sc), leg('B', 'PE', beyond(at(-P.condorWing), sp, -1)),
        leg('B', 'CE', beyond(at(P.condorWing), sc, 1))];
    }
    case 'iron-butterfly': {
      const sc = liquid(atm, 'CE');
      const sp = liquid(atm, 'PE');
      return [leg('S', 'CE', sc), leg('S', 'PE', sp), leg('B', 'CE', beyond(at(P.butterflyWing), sc, 1)),
        leg('B', 'PE', beyond(at(-P.butterflyWing), sp, -1))];
    }
  }
}
