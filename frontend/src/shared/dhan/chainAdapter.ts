// Dhan option chain (GET /api/option-chain) -> the models the paste parsers produce, so the existing formula
// modules run unchanged on live data. Field mapping and known differences: docs/02-current-state.md ("Live OI apps").
import type { LegData, OptionChain, StrikeRow } from '../../apps/option-strategy/logic/optionChain';
import type { SbSnapshot } from '../../apps/sensibull-oi/logic/sensibull';
import type { ChainResponse, DhanLeg } from './api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (now: number, was: number) => (was ? ((now - was) / was) * 100 : 0);

/** "2026-10-27" -> "27-Oct-2026" (NSE's format, used by the paste apps). */
export function nseDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return MONTHS[Number(m) - 1] ? `${d}-${MONTHS[Number(m) - 1]}-${y}` : iso;
}

/** "2026-10-21 11:05:03" (IST) -> "21-Oct-2026 11:05:03", like NSE's records.timestamp. */
export const nseTimestamp = (asOf: string) => `${nseDate(asOf.slice(0, 10))} ${asOf.slice(11, 19)}`;

/** "2026-10-21 11:05:03" (IST) -> "2026-10-21T05:35:03.000Z", like Sensibull's times. */
export const isoFromIst = (asOf: string) => new Date(`${asOf.slice(0, 10)}T${asOf.slice(11, 19)}+05:30`).toISOString();

const nearestStrike = (strikes: number[], spot: number) =>
  strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0] ?? 0);

/** One Dhan leg in NSE terms. OI and volume are divided by the lot size: NSE reports contracts, Dhan units. */
export function toLeg(x: DhanLeg | null | undefined, lotSize: number): LegData | null {
  if (!x) return null;
  const lot = lotSize > 0 ? lotSize : 1;
  const oi = num(x.oi);
  const prevOi = num(x.previous_oi);
  const ltp = num(x.last_price);
  const prevClose = num(x.previous_close_price);
  return {
    openInterest: oi / lot,
    changeInOpenInterest: (oi - prevOi) / lot, // vs Dhan's settled previous-day OI
    pChangeInOpenInterest: pct(oi, prevOi),
    volume: num(x.volume) / lot,
    iv: num(x.implied_volatility),
    ltp,
    change: prevClose ? ltp - prevClose : 0,
    pChange: pct(ltp, prevClose),
    bidPrice: num(x.top_bid_price),
    bidQty: num(x.top_bid_quantity),
    askPrice: num(x.top_ask_price),
    askQty: num(x.top_ask_quantity),
    totalBuyQty: 0, // Dhan's chain has no total buy/sell quantity; no formula uses them
    totalSellQty: 0,
  };
}

/** Dhan chain -> the NSE `OptionChain` model (OI in contracts) used by OI & OI Change and OI Support & Resistance. */
export function toOptionChain(resp: ChainResponse, expiries: string[] = []): OptionChain {
  const { meta } = resp;
  const strikes: StrikeRow[] = resp.rows
    .map((r) => ({ strike: num(r.strike), ce: toLeg(r.ce, meta.lotSize), pe: toLeg(r.pe, meta.lotSize) }))
    .filter((r) => r.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  const sum = (pick: (s: StrikeRow) => number) => strikes.reduce((t, s) => t + pick(s), 0);
  return {
    symbol: meta.symbol,
    expiry: nseDate(meta.expiry),
    timestamp: nseTimestamp(meta.asOf),
    underlying: num(meta.spot),
    atmStrike: nearestStrike(strikes.map((s) => s.strike), num(meta.spot)),
    expiryDates: (expiries.length ? expiries : [meta.expiry]).map(nseDate),
    strikes,
    totals: {
      ce: { oi: sum((s) => s.ce?.openInterest ?? 0), volume: sum((s) => s.ce?.volume ?? 0) },
      pe: { oi: sum((s) => s.pe?.openInterest ?? 0), volume: sum((s) => s.pe?.volume ?? 0) },
    },
  };
}

/**
 * Dhan chain -> Sensibull's `SbSnapshot` (OI in units, as Sensibull sends it).
 * "From" OI = the 09:15 OI like Sensibull (open_oi, recorded by the backend each morning); Dhan's previous-day settled
 * OI when that was not recorded (backend started after the close, or a strike added later).
 */
export function toSbSnapshot(resp: ChainResponse): SbSnapshot {
  const { meta } = resp;
  const strikes = resp.rows
    .map((r) => ({
      strike: num(r.strike),
      fromCallOi: num(r.ce?.open_oi ?? r.ce?.previous_oi),
      fromPutOi: num(r.pe?.open_oi ?? r.pe?.previous_oi),
      toCallOi: num(r.ce?.oi),
      toPutOi: num(r.pe?.oi),
    }))
    .filter((s) => s.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  return {
    symbol: meta.symbol,
    expiry: nseDate(meta.expiry),
    fromTime: isoFromIst(`${meta.asOf.slice(0, 10)} ${meta.openOiAt ?? '09:15:00'}`),
    toTime: isoFromIst(meta.asOf),
    spot: num(meta.spot),
    atmStrike: nearestStrike(strikes.map((s) => s.strike), num(meta.spot)),
    strikes,
  };
}
