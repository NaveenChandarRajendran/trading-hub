// src/apps/components/logic/components.ts
// Index components: weight, day change and contribution per stock, plus summary numbers.

export interface Constituent { name: string; symbol: string; weight: number }
export interface Quote { ltp: number; prevClose?: number } // prevClose comes from historical candles, not from the quote call

export interface CompRow extends Constituent {
  id?: number;
  ltp?: number;
  prevClose?: number;
  changePct?: number; // (ltp - prevClose) / prevClose * 100
  contribution?: number; // weight% x change% -> index percentage points
}

export function buildRows(list: Constituent[], ids: Record<string, number>, quotes: Record<string, Quote>): CompRow[] {
  return [...list]
    .sort((a, b) => b.weight - a.weight)
    .map((c) => {
      const id = ids[c.symbol];
      const q = id != null ? quotes[String(id)] : undefined;
      if (!q) return { ...c, id };
      if (!(q.prevClose && q.prevClose > 0)) return { ...c, id, ltp: q.ltp }; // price known, change not yet
      const changePct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
      return { ...c, id, ltp: q.ltp, prevClose: q.prevClose, changePct, contribution: (c.weight / 100) * changePct };
    });
}

export interface Summary {
  withPrice: number; // stocks with a live price
  priced: number; // stocks with a live price AND a previous close (so a change %)
  total: number;
  coverage: number; // % of the index weight that has a price
  indexMove: number; // sum of contributions (index % points)
  weightedAvg: number; // weighted average change %, over priced stocks
  simpleAvg: number;
  advancing: number;
  declining: number;
}

export function summarize(rows: CompRow[]): Summary {
  const priced = rows.filter((r) => r.changePct != null);
  const wSum = priced.reduce((t, r) => t + r.weight, 0);
  const indexMove = priced.reduce((t, r) => t + (r.contribution ?? 0), 0);
  return {
    withPrice: rows.filter((r) => r.ltp != null).length,
    priced: priced.length,
    total: rows.length,
    coverage: wSum, // weights are % of the index, so this is the share of the index that has a price
    indexMove,
    weightedAvg: wSum ? (indexMove / wSum) * 100 : 0,
    simpleAvg: priced.length ? priced.reduce((t, r) => t + (r.changePct ?? 0), 0) / priced.length : 0,
    advancing: priced.filter((r) => (r.changePct ?? 0) > 0).length,
    declining: priced.filter((r) => (r.changePct ?? 0) < 0).length,
  };
}

/** Fake but stable prices so the page can be tried without a token (marked DEMO in the UI). */
export function demoQuotes(list: Constituent[], ids: Record<string, number>): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  list.forEach((c, i) => {
    const id = ids[c.symbol] ?? 900000 + i;
    const seed = [...c.symbol].reduce((t, ch) => (t * 31 + ch.charCodeAt(0)) % 1000, 7);
    const prevClose = 200 + seed * 3;
    out[String(id)] = { ltp: prevClose * (1 + ((seed % 61) - 30) / 1000), prevClose };
  });
  return out;
}

/** Demo mode: give every stock an ID (real one if known, otherwise a fake one) so all rows show prices. */
export function demoIds(list: Constituent[], ids: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  list.forEach((c, i) => (out[c.symbol] = ids[c.symbol] ?? 900000 + i));
  return out;
}
