// Turns the two pasted responses (Sensibull OI, NSE option chain) into one flat model for the PCR formulas.
// The parsers are the ones the Sensibull OI and OI & OI Change apps use, unchanged. Both sources end up in
// units: Sensibull already is; NSE contracts are multiplied by the lot size (BANKNIFTY 30).
import { parseSensibull, type SbSnapshot } from '../../sensibull-oi/logic/sensibull';
import { parseOptionChain, type OptionChain } from '../../option-strategy/logic/optionChain';
import { LOT_SIZE } from '../config/settings';

export type SourceId = 'sensibull' | 'nse';

/** Today's OI and today's change, in units. Yesterday's OI = today's OI − today's change. */
export interface PcrStrike {
  strike: number;
  ceOi: number;
  ceChg: number;
  peOi: number;
  peChg: number;
}

export interface PcrSource {
  source: SourceId;
  symbol: string; // "BANKNIFTY"
  expiry: string; // "27-Oct-2026"
  at: number; // snapshot time, epoch ms
  since: number | null; // Sensibull: start of the change window (epoch ms); NSE: change is vs previous close
  spot: number;
  lot: number; // NSE contracts were multiplied by this (1 for Sensibull)
  strikes: PcrStrike[]; // ascending
}

export class LotSizeError extends Error {}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_MS = 5.5 * 3600_000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_STAMP_MIN = 15 * 60 + 40; // after the close both sites stamp their last data 15:40 IST

/** Epoch ms of an IST wall-clock time on the same IST day as `ms`. */
const istAt = (ms: number, minutes: number) => {
  const day = Math.floor((ms + IST_MS) / 86400_000) * 86400_000;
  return day - IST_MS + minutes * 60_000;
};

/** True when `ms` is 09:15 IST: Sensibull's change then equals the change since yesterday's close. */
export const isMarketOpen = (ms: number) => ms === istAt(ms, OPEN_MIN);

/**
 * Sensibull's `to_time` is the end of the chosen window, which after the close is later than the data
 * (e.g. 19:30 IST while the last minute is 15:40). Cap it at 15:40 IST, the stamp NSE uses too.
 */
export function sensibullTime(toTime: string): number {
  const t = Date.parse(toTime);
  if (!Number.isFinite(t)) return NaN;
  return Math.min(t, istAt(t, CLOSE_STAMP_MIN));
}

/** NSE stamps IST wall-clock time: "23-Oct-2026 15:40:00". */
export function nseTime(ts: string): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(ts.trim());
  if (!m) return NaN;
  const mon = MON.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase());
  if (mon < 0) return NaN;
  return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +(m[6] ?? 0)) - IST_MS;
}

/** "23 Oct 15:40" in IST. */
export function istLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + IST_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${hh}:${mm}`;
}

/** "15:40" in IST. */
export const istTime = (ms: number) => istLabel(ms).slice(-5);

export function fromSensibull(s: SbSnapshot): PcrSource {
  const since = Date.parse(s.fromTime);
  return {
    source: 'sensibull',
    symbol: s.symbol,
    expiry: s.expiry,
    at: sensibullTime(s.toTime),
    since: Number.isFinite(since) ? since : null,
    spot: s.spot,
    lot: 1,
    // today's OI = to_*_oi (the latest minute); change = to − from (from = 09:15 = yesterday's closing OI)
    strikes: s.strikes.map((k) => ({
      strike: k.strike,
      ceOi: k.toCallOi,
      ceChg: k.toCallOi - k.fromCallOi,
      peOi: k.toPutOi,
      peChg: k.toPutOi - k.fromPutOi,
    })),
  };
}

export function fromNse(c: OptionChain, lot: number): PcrSource {
  return {
    source: 'nse',
    symbol: c.symbol,
    expiry: c.expiry,
    at: nseTime(c.timestamp),
    since: null,
    spot: c.underlying,
    lot,
    // openInterest (today) / changeinOpenInterest (vs yesterday's settled OI), contracts × lot = units
    strikes: c.strikes.map((k) => ({
      strike: k.strike,
      ceOi: (k.ce?.openInterest ?? 0) * lot,
      ceChg: (k.ce?.changeInOpenInterest ?? 0) * lot,
      peOi: (k.pe?.openInterest ?? 0) * lot,
      peChg: (k.pe?.changeInOpenInterest ?? 0) * lot,
    })),
  };
}

/** Parse a paste; parser errors (SbParseError / ChainParseError) carry a readable message and are rethrown as is. */
export const readSensibull = (text: string) => fromSensibull(parseSensibull(text));

export function readNse(text: string, lots: Record<string, number> = LOT_SIZE): PcrSource {
  const chain = parseOptionChain(text);
  const lot = lots[chain.symbol];
  if (!lot) throw new LotSizeError(`No lot size known for ${chain.symbol || 'this index'}; only ${Object.keys(lots).join(' and ')} are supported.`);
  return fromNse(chain, lot);
}
