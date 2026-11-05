// Backtest results of every strategy we paper trade (owner 5-Nov-2026: "share the test results of all these strategies we
// kept in the paper ... simple and user friendly ... remove others"; and "a graph on each card, whether it is Nifty or
// BankNifty, the capital, the average a year and the 5-year result, so I can explain it to my wife").
// Same numbers as the results page https://claude.ai/artifact/KCro6EGymrfRRm4DMVxuRh (project files
// explainers/strategy-results.html). Sources (project files research/): chop-filter/res.json (SuperTrend rules with the
// gap-day and fear-day pauses, Rebound, Box Pullback), selling-2pct/port.json (straddles with the VIX skip, calm call,
// weekly strangle x 2 lots), strangle-adjust/adj.json (2-month strangle), published-rules/combo.json (Fear + Calendar),
// stock-momentum/grid.json and stock-rules/res_rot.json (stock books, % a year). Costs and slippage included.
// Options / futures: profit per calendar year in rupees (2021 = Nov-Dec only, 2026 = to October).
// (Fear + Calendar: the yearly split scaled so the years add up to the total after its charges.)
// Stocks: growth in % per year on ₹5 lakh (2022-2026, 2026 to October), before tax.

export type ResultKind = 'rupees' | 'growth';
export interface PaperResult {
  id: string;
  section: 'Option Buy' | 'Option Sell' | 'Futures' | 'Stock books' | 'Scalping';
  name: string;
  index: string; // what it trades
  what: string; // one plain line
  capital: number;
  kind: ResultKind;
  years: Record<string, number>; // rupees (kind rupees) or % growth (kind growth)
  worst: string; // worst fall from a high, as said on the results page
  verdict: 'strong' | 'good' | 'new' | 'ending' | 'lost';
  verdictText: string;
}

export const RESULTS: PaperResult[] = [
  {
    id: 'ladder', section: 'Option Buy', name: 'SuperTrend Ladder', index: 'Nifty', capital: 150000, kind: 'rupees',
    what: '6 lots. Sells 2 at +20%, 2 at +50%, last 2 when SuperTrend breaks. With the gap-day and fear-day rules.',
    years: { 2021: 22515, 2022: 264796, 2023: 195199, 2024: 223252, 2025: 298390, 2026: 214098 }, worst: '−₹86k', verdict: 'strong', verdictText: 'Strong',
  },
  {
    id: 'breakout', section: 'Option Buy', name: 'SuperTrend Breakout', index: 'Nifty', capital: 150000, kind: 'rupees',
    what: '1 lot. Stop 10%, target 20%. With the gap-day and fear-day rules.',
    years: { 2021: 1721, 2022: 26504, 2023: 30175, 2024: 44118, 2025: 40974, 2026: 17121 }, worst: '−₹14k', verdict: 'good', verdictText: 'Positive',
  },
  {
    id: 'rebound', section: 'Option Buy', name: 'Rebound Call', index: 'BankNifty', capital: 50000, kind: 'rupees',
    what: '1 lot. Buys a call after a sharp fall starts to bounce. Stop 25%, target 50%.',
    years: { 2021: 999, 2022: 60596, 2023: 12301, 2024: 39486, 2025: 17533, 2026: 42610 }, worst: '−₹36k', verdict: 'good', verdictText: 'Positive',
  },
  {
    id: 'weekly', section: 'Option Sell', name: 'Weekly Strangle', index: 'Nifty', capital: 400000, kind: 'rupees',
    what: '2 lots. Sells a call and a put 200 points away 3 days before expiry. Buys back a leg if it doubles.',
    years: { 2021: -22171, 2022: 199595, 2023: 39921, 2024: 176180, 2025: 153938, 2026: 189394 }, worst: '−₹48k', verdict: 'new', verdictText: 'New · strong',
  },
  {
    id: 'straddles', section: 'Option Sell', name: 'Expiry Straddles', index: 'Nifty', capital: 600000, kind: 'rupees',
    what: '1 lot at each of 9:20, 9:40, 11:26, 12:24 on expiry day. Skips days when VIX opens below 12.',
    years: { 2021: 22810, 2022: 114039, 2023: 64717, 2024: 97805, 2025: 28986, 2026: 108553 }, worst: '−₹30k', verdict: 'strong', verdictText: 'Strong',
  },
  {
    id: 'calm', section: 'Option Sell', name: 'Calm-Day Call', index: 'Nifty', capital: 150000, kind: 'rupees',
    what: '1 lot. Sells a call at 10:15 on quiet days. Stop 50%.',
    years: { 2021: 13847, 2022: 32922, 2023: 8286, 2024: 31781, 2025: 42766, 2026: 50505 }, worst: '−₹23k', verdict: 'good', verdictText: 'Positive',
  },
  {
    id: 'strangle', section: 'Option Sell', name: '2-Month Strangle', index: 'Nifty', capital: 250000, kind: 'rupees',
    what: '1 lot. Call and put 5% away, rolled at 70% profit, ₹60k stop. The current one is the last.',
    years: { 2021: 33634, 2022: 7303, 2023: 9015, 2024: 131453, 2025: 71733, 2026: 112344 }, worst: '−₹64k', verdict: 'ending', verdictText: 'Ending 29 Dec',
  },
  {
    id: 'fear', section: 'Futures', name: 'Fear + Calendar', index: 'Nifty futures', capital: 250000, kind: 'rupees',
    what: '1 lot. Buys after a VIX jump, at the month turn and mid-month. Profit in every year.',
    years: { 2021: 35207, 2022: 164512, 2023: 250640, 2024: 57322, 2025: 139871, 2026: 51712 }, worst: '−₹1.30L', verdict: 'new', verdictText: 'New · strong',
  },
  {
    id: 'momSwitch', section: 'Stock books', name: 'Momentum 20 · with Nifty switch', index: 'NSE stocks', capital: 500000, kind: 'growth',
    what: 'Top 20 strongest stocks, checked monthly. Goes to cash when Nifty is below its 200-day average.',
    years: { 2022: -9.2, 2023: 62.8, 2024: 45.6, 2025: 18.6, 2026: -10.0 }, worst: '−25%', verdict: 'strong', verdictText: 'Strong',
  },
  {
    id: 'momAll', section: 'Stock books', name: 'Momentum 20 · without switch', index: 'NSE stocks', capital: 500000, kind: 'growth',
    what: 'Same top 20, always invested. Higher growth, bigger falls.',
    years: { 2022: 0.1, 2023: 92.4, 2024: 45.3, 2025: -7.5, 2026: 38.8 }, worst: '−33%', verdict: 'strong', verdictText: 'Strong, bumpier',
  },
  {
    id: 'clenow', section: 'Stock books', name: 'Clenow Stocks on the Move', index: 'NSE stocks', capital: 500000, kind: 'growth',
    what: 'Top 20 by steady trend, checked weekly. Cash when Nifty is below its 200-day average.',
    years: { 2022: 7.0, 2023: 59.2, 2024: 30.8, 2025: -4.1, 2026: 4.9 }, worst: '−21%', verdict: 'new', verdictText: 'New · positive',
  },
  {
    id: 'box', section: 'Scalping', name: 'Box Pullback', index: 'Nifty + BankNifty', capital: 100000, kind: 'rupees',
    what: '1 lot each. Quick trades on pullbacks. Kept on paper only to watch.',
    years: { 2021: -24856, 2022: -75913, 2023: -65773, 2024: -101773, 2025: -68932, 2026: -107833 }, worst: '−₹4.45L', verdict: 'lost', verdictText: 'Lost in test',
  },
];

export const SECTION_NOTE: Record<PaperResult['section'], string> = {
  'Option Buy': 'Buying options · Nov 2021 to Oct 2026 · after all charges',
  'Option Sell': 'Selling options · Nov 2021 to Oct 2026 · after all charges',
  Futures: 'Nifty futures · Nov 2021 to Oct 2026 · after all charges',
  'Stock books': 'NSE stocks · 2022 to 2026 · ₹5L each · after charges, before tax',
  Scalping: 'Nov 2021 to Oct 2026 · after all charges',
};

export interface Point { year: string; value: number }
export interface Summary {
  points: Point[]; // starts at 0 (rupees) or the capital (growth), one point per year end
  total: number; // rupees made over the test (growth: end value − capital)
  end: number; // growth: what the capital grew to
  perYear: number; // rupees a year (total / 5)
  perYearPct: number; // % of capital a year (rupees) or average yearly growth (compounded, growth)
  goodYears: number;
  years: number;
}

const YEARS_OF_TEST = 5;

/** The line and the headline numbers of one card. */
export function summarize(r: PaperResult): Summary {
  const ys = Object.keys(r.years).sort();
  const points: Point[] = [];
  let v = r.kind === 'rupees' ? 0 : r.capital;
  points.push({ year: String(Number(ys[0]) - 1), value: v });
  for (const y of ys) {
    v = r.kind === 'rupees' ? v + r.years[y] : v * (1 + r.years[y] / 100);
    points.push({ year: y, value: Math.round(v) });
  }
  const end = points[points.length - 1].value;
  const total = r.kind === 'rupees' ? end : end - r.capital;
  const perYearPct = r.kind === 'rupees'
    ? Math.round((total / YEARS_OF_TEST / r.capital) * 100)
    : Math.round((Math.pow(end / r.capital, 1 / ys.length) - 1) * 100);
  return {
    points, total, end, perYear: Math.round(total / YEARS_OF_TEST), perYearPct,
    goodYears: ys.filter((y) => r.years[y] > 0).length, years: ys.length,
  };
}

/** ₹12.18L / ₹86k / −₹4.45L style. */
export function lakhText(v: number, sign = false): string {
  const s = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  const a = Math.abs(v);
  return a >= 100000 ? `${s}₹${(a / 100000).toFixed(2)}L` : `${s}₹${Math.round(a / 1000)}k`;
}
