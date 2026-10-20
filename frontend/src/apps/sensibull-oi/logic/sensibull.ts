// src/apps/sensibull-oi/logic/sensibull.ts
// Parses the Sensibull OI response (copied from the browser's Network tab) into a flat model.

export interface SbStrike {
  strike: number;
  fromCallOi: number;
  fromPutOi: number;
  toCallOi: number;
  toPutOi: number;
}

export interface SbSnapshot {
  symbol: string; // "NIFTY" | "BANKNIFTY"
  expiry: string; // "19-Oct-2026"
  fromTime: string; // ISO, as sent by Sensibull (UTC)
  toTime: string;
  spot: number;
  atmStrike: number;
  strikes: SbStrike[]; // ascending
}

export class SbParseError extends Error {}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return MONTHS[Number(m) - 1] ? `${d}-${MONTHS[Number(m) - 1]}-${y}` : iso;
};
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function parseSensibull(input: string): SbSnapshot {
  const text = input.trim();
  if (!text) throw new SbParseError('Nothing pasted. Paste the Response JSON from the Sensibull request.');
  if (text.startsWith('<')) throw new SbParseError('This looks like a web page, not JSON. Copy the Response body from the Network tab.');

  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SbParseError('Not valid JSON. Make sure you copied the whole Response (not the Headers).');
  }

  const p = raw?.payload ?? raw;
  const per = p?.per_strike_data;
  if (!per || typeof per !== 'object' || Object.keys(per).length === 0) {
    throw new SbParseError('No strike data found. Copy the response of the request that contains "per_strike_data".');
  }

  const strikes: SbStrike[] = Object.entries(per)
    .map(([k, v]: [string, any]) => ({
      strike: Number(k),
      fromCallOi: num(v.from_call_oi),
      fromPutOi: num(v.from_put_oi),
      toCallOi: num(v.to_call_oi),
      toPutOi: num(v.to_put_oi),
    }))
    .filter((s) => s.strike > 0)
    .sort((a, b) => a.strike - b.strike);

  const expiries = p?.input?.expiries ?? {};
  const enabled = Object.keys(expiries).filter((e) => expiries[e]?.is_enabled).sort();

  return {
    symbol: String(p?.input?.underlying ?? ''),
    expiry: enabled.length ? niceDate(enabled[0]) : '',
    fromTime: String(p?.input?.from_time ?? ''),
    toTime: String(p?.input?.to_time ?? ''),
    spot: num(p?.current_ltp ?? p?.to_ltp),
    atmStrike: num(p?.atm_strike),
    strikes,
  };
}
