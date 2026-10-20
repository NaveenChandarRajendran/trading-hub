// src/apps/option-strategy/logic/optionChain.ts
// Parses the NSE option-chain-v3 JSON (pasted by the user) into a flat, UI-agnostic model.
// All formula modules should consume `OptionChain`, never the raw NSE shape.

export interface LegData {
  openInterest: number;
  changeInOpenInterest: number;
  pChangeInOpenInterest: number;
  volume: number;
  iv: number;
  ltp: number;
  change: number;
  pChange: number;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  totalBuyQty: number;
  totalSellQty: number;
}

export interface StrikeRow {
  strike: number;
  ce: LegData | null;
  pe: LegData | null;
}

export interface OptionChain {
  symbol: string; // "NIFTY" | "BANKNIFTY"
  expiry: string; // "27-Oct-2026"
  timestamp: string; // NSE snapshot time, e.g. "16-Oct-2026 15:40:00"
  underlying: number;
  atmStrike: number;
  expiryDates: string[]; // all expiries NSE lists for this symbol
  strikes: StrikeRow[]; // sorted ascending
  totals: {
    ce: { oi: number; volume: number };
    pe: { oi: number; volume: number };
  };
}

export class ChainParseError extends Error {}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toLeg(x: any): LegData | null {
  if (!x || typeof x !== 'object') return null;
  return {
    openInterest: num(x.openInterest),
    changeInOpenInterest: num(x.changeinOpenInterest),
    pChangeInOpenInterest: num(x.pchangeinOpenInterest),
    volume: num(x.totalTradedVolume),
    iv: num(x.impliedVolatility),
    ltp: num(x.lastPrice),
    change: num(x.change),
    pChange: num(x.pChange),
    bidPrice: num(x.buyPrice1),
    bidQty: num(x.buyQuantity1),
    askPrice: num(x.sellPrice1),
    askQty: num(x.sellQuantity1),
    totalBuyQty: num(x.totalBuyQuantity),
    totalSellQty: num(x.totalSellQuantity),
  };
}

export function parseOptionChain(input: string): OptionChain {
  const text = input.trim();
  if (!text) throw new ChainParseError('Nothing pasted. Paste the full JSON from the NSE API tab.');
  if (text.startsWith('<')) {
    throw new ChainParseError('This looks like a web page, not JSON. Open the API URL and copy the raw response.');
  }

  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ChainParseError('Not valid JSON. Make sure you copied the whole response (Ctrl+A, Ctrl+C).');
  }

  const rows: any[] | undefined = raw?.records?.data ?? raw?.filtered?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ChainParseError(
      'No option data found. NSE returns an empty response if the session has expired: open nseindia.com once, then retry the API URL.',
    );
  }

  const strikes: StrikeRow[] = rows
    .map((r) => ({ strike: num(r.strikePrice), ce: toLeg(r.CE), pe: toLeg(r.PE) }))
    .filter((r) => r.strike > 0)
    .sort((a, b) => a.strike - b.strike);

  const underlying = num(raw?.records?.underlyingValue ?? rows[0]?.CE?.underlyingValue ?? rows[0]?.PE?.underlyingValue);
  const atmStrike = strikes.reduce(
    (best, s) => (Math.abs(s.strike - underlying) < Math.abs(best - underlying) ? s.strike : best),
    strikes[0].strike,
  );

  const sum = (pick: (s: StrikeRow) => number) => strikes.reduce((t, s) => t + pick(s), 0);
  const f = raw?.filtered;

  return {
    symbol: String(rows[0]?.CE?.underlying ?? rows[0]?.PE?.underlying ?? ''),
    expiry: String(rows[0]?.expiryDates ?? ''),
    timestamp: String(raw?.records?.timestamp ?? ''),
    underlying,
    atmStrike,
    expiryDates: Array.isArray(raw?.records?.expiryDates) ? raw.records.expiryDates : [],
    strikes,
    totals: {
      ce: {
        oi: f?.CE?.totOI != null ? num(f.CE.totOI) : sum((s) => s.ce?.openInterest ?? 0),
        volume: f?.CE?.totVol != null ? num(f.CE.totVol) : sum((s) => s.ce?.volume ?? 0),
      },
      pe: {
        oi: f?.PE?.totOI != null ? num(f.PE.totOI) : sum((s) => s.pe?.openInterest ?? 0),
        volume: f?.PE?.totVol != null ? num(f.PE.totVol) : sum((s) => s.pe?.volume ?? 0),
      },
    },
  };
}
