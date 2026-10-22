// src/apps/oi-support-resistance/logic/levels.ts
// Support / resistance from open interest, ported from the Strike Desk HTML (index3.html).
// Consumes the parsed `OptionChain`, never the raw NSE shape. OI is in contracts, as NSE reports it.
import type { OptionChain } from '../../option-strategy/logic/optionChain';
import { rawNumber } from '../../../shared/clipboard';
import { LEVEL_COUNT, NEAR_WINDOW } from '../config/settings';

export type Side = 'R' | 'S'; // R = resistance (call OI above spot), S = support (put OI below spot)
/** strike -> [call OI, put OI]. Keys become strings after a JSON round trip; index with numbers anyway. */
export type StrikeOi = Record<number, [number, number]>;

export interface Snapshot {
  t: number; // when it was pasted (epoch ms)
  nse: string; // NSE timestamp, e.g. "16-Oct-2026 15:40:00" ('' if missing)
  symbol: string;
  expiry: string; // "27-Oct-2026"
  spot: number;
  rows: StrikeOi; // strikes within NEAR_WINDOW points of spot
}

export interface Analysis {
  snapshot: Snapshot;
  chg: StrikeOi; // NSE change in OI per strike, same strikes as snapshot.rows
  pcr: number | null; // total put OI / total call OI, all strikes
  maxPain: number | null;
  daysToExpiry: number | null;
}

export interface Level {
  strike: number;
  oi: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sideIndex = (side: Side) => (side === 'R' ? 0 : 1);
const strikesOf = (rows: StrikeOi) => Object.keys(rows).map(Number).sort((a, b) => a - b);

/** "16-Oct-2026 15:40:00" -> epoch ms (local time), or null. */
export function parseNseTime(s: string | null | undefined): number | null {
  const m = /(\d{1,2})-(\w{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s ?? '');
  if (!m || !MONTHS.includes(m[2])) return null;
  return new Date(+m[3], MONTHS.indexOf(m[2]), +m[1], +m[4], +m[5], +m[6]).getTime();
}

/** Calendar days from today to expiry; expiry day counts as 1. Null if the date can't be read or has passed. */
export function daysToExpiry(expiry: string, today = new Date()): number | null {
  const [d, mon, y] = expiry.split('-');
  const mi = MONTHS.indexOf(mon);
  if (mi < 0 || !Number(d) || !Number(y)) return null;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.ceil((new Date(+y, mi, +d).getTime() - t0.getTime()) / 86400000);
  if (diff < 0) return null;
  return diff === 0 ? 1 : diff;
}

/** Strike where option buyers' total payout at expiry is smallest. Ties keep the lowest strike. */
export function maxPain(oi: StrikeOi): number | null {
  const strikes = strikesOf(oi);
  let best: number | null = null;
  let min = Infinity;
  for (const x of strikes) {
    let pain = 0;
    for (const s of strikes) {
      if (x > s) pain += (x - s) * oi[s][0];
      if (x < s) pain += (s - x) * oi[s][1];
    }
    if (pain < min) {
      min = pain;
      best = x;
    }
  }
  return best;
}

export function analyzeChain(chain: OptionChain, pastedAt = Date.now(), today = new Date()): Analysis {
  const spot = chain.underlying;
  const all: StrikeOi = {};
  const rows: StrikeOi = {};
  const chg: StrikeOi = {};
  let totalCe = 0;
  let totalPe = 0;
  for (const s of chain.strikes) {
    const co = s.ce?.openInterest ?? 0;
    const po = s.pe?.openInterest ?? 0;
    all[s.strike] = [co, po];
    totalCe += co;
    totalPe += po;
    if (Math.abs(s.strike - spot) <= NEAR_WINDOW) {
      rows[s.strike] = [co, po];
      chg[s.strike] = [s.ce?.changeInOpenInterest ?? 0, s.pe?.changeInOpenInterest ?? 0];
    }
  }
  return {
    snapshot: { t: pastedAt, nse: chain.timestamp, symbol: chain.symbol, expiry: chain.expiry, spot, rows },
    chg,
    pcr: totalCe ? totalPe / totalCe : null,
    maxPain: maxPain(all),
    daysToExpiry: daysToExpiry(chain.expiry, today),
  };
}

/**
 * Top strikes by OI on one side of spot: call OI from spot to spot + range (R),
 * put OI from spot - range to just below spot (S). Picked by OI, then numbered by distance,
 * so R1 / S1 is always the level nearest spot.
 */
export function topLevels(rows: StrikeOi, spot: number, side: Side, range: number, count = LEVEL_COUNT): Level[] {
  const i = sideIndex(side);
  const inRange = (s: number) => (side === 'R' ? s >= spot && s <= spot + range : s < spot && s >= spot - range);
  return strikesOf(rows)
    .filter(inRange)
    .map((strike) => ({ strike, oi: rows[strike][i] }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, count)
    .sort((a, b) => (side === 'R' ? a.strike - b.strike : b.strike - a.strike));
}

/** Smallest gap between listed strikes (50 for NIFTY, 100 for BANKNIFTY). */
export function strikeStep(rows: StrikeOi): number {
  const s = strikesOf(rows);
  let step = Infinity;
  for (let k = 1; k < s.length; k++) step = Math.min(step, s[k] - s[k - 1]);
  return Number.isFinite(step) ? step : 0;
}

/** OI of the strike plus one strike either side. */
export function zoneOi(rows: StrikeOi, strike: number, side: Side, step: number): number {
  const i = sideIndex(side);
  return [strike - step, strike, strike + step].reduce((t, k) => t + (rows[k] ? rows[k][i] : 0), 0);
}

export type Trend = 'falling' | 'rising' | 'same';
export interface Change {
  was: number;
  pct: number | null; // null when the earlier OI was 0
  trend: Trend | null;
}

/** Compares OI now with an earlier value. +/- threshold % or more counts as Rising / Falling. */
export function compareOi(was: number | null | undefined, now: number, threshold: number): Change | null {
  if (was == null) return null;
  if (!was) return { was, pct: null, trend: null };
  const pct = ((now - was) / was) * 100;
  return { was, pct, trend: pct <= -threshold ? 'falling' : pct >= threshold ? 'rising' : 'same' };
}

export type Tone = 'up' | 'down' | 'neutral';

/**
 * Seller's view: more put OI = support building = bullish (green); more call OI = resistance
 * building = bearish (red). So a rising support or a falling resistance is green, and the reverse is red.
 */
export function oiTone(side: Side, direction: number): Tone {
  if (!direction) return 'neutral';
  const bullish = side === 'S' ? direction > 0 : direction < 0;
  return bullish ? 'up' : 'down';
}

export const trendTone = (side: Side, trend: Trend | null): Tone =>
  trend === 'rising' ? oiTone(side, 1) : trend === 'falling' ? oiTone(side, -1) : 'neutral';

export const TREND_LABEL: Record<Trend, string> = { falling: 'Falling clearly', rising: 'Rising', same: 'About the same' };

export interface LevelShift {
  level: string; // "R1"
  from: number;
  to: number;
  since: 'baseline' | 'previous';
}

/** Levels whose strike changed since the baseline and since the previous paste. */
export function levelShifts(current: Record<Side, Level[]>, base: Snapshot, prev: Snapshot, range: number): LevelShift[] {
  const out: LevelShift[] = [];
  for (const side of ['R', 'S'] as const) {
    current[side].forEach((now, k) => {
      for (const [since, sn] of [['baseline', base], ['previous', prev]] as const) {
        const was = topLevels(sn.rows, sn.spot, side, range)[k];
        if (was && was.strike !== now.strike) out.push({ level: `${side}${k + 1}`, from: was.strike, to: now.strike, since });
      }
    });
  }
  return out;
}

export interface TrendCell {
  oi: number | null;
  direction: number; // vs the paste before it: 1 up, -1 down, 0 same / unknown
}

/** One row per level: the strike's OI at every paste of the day. */
export function levelTrend(levels: Level[], side: Side, snaps: Snapshot[]): TrendCell[][] {
  const i = sideIndex(side);
  return levels.map(({ strike }) =>
    snaps.map((sn, j) => {
      const oi = sn.rows[strike] ? sn.rows[strike][i] : null;
      const before = j > 0 && snaps[j - 1].rows[strike] ? snaps[j - 1].rows[strike][i] : null;
      return { oi, direction: oi != null && before != null ? Math.sign(oi - before) : 0 };
    }),
  );
}

export const lakh = (n: number) => `${(n / 100000).toFixed(2)}L`;

/** One line for pasting into chart notes, raw numbers only: "BANKNIFTY 55844 at 15:40 | Res R1 55900 (1.23L), … | Sup S1 …". */
export function levelsText(sn: Snapshot, time: string, levels: Record<Side, Level[]>): string {
  const f = (side: Side) => levels[side].map((x, k) => `${side}${k + 1} ${rawNumber(x.strike)} (${lakh(x.oi)})`).join(', ');
  return `${sn.symbol} ${rawNumber(sn.spot)} at ${time} | Res ${f('R')} | Sup ${f('S')}`;
}

/** What the result screen shows for one analysed chain, given today's snapshots (baseline = first). */
/**
 * recorded: the levels accepted by the backend's stability rule (Dashboard and OI S&R Live agree on them); their OI
 * is taken from this snapshot where the strike is in it. Without it the snapshot's own top-OI ranking is used.
 */
export function buildView(result: Analysis, snaps: Snapshot[], range: number, recorded: Record<Side, Level[]> | null = null) {
  const cur = result.snapshot;
  const withOi = (side: Side) =>
    recorded![side].map((l) => ({ strike: l.strike, oi: cur.rows[l.strike] ? cur.rows[l.strike][side === 'R' ? 0 : 1] : l.oi }));
  const levels = recorded
    ? { R: withOi('R'), S: withOi('S') }
    : { R: topLevels(cur.rows, cur.spot, 'R', range), S: topLevels(cur.rows, cur.spot, 'S', range) };
  const earlier = snaps.filter((s) => s.t !== cur.t);
  const base = earlier[0];
  const prev = earlier[earlier.length - 1];
  return {
    cur,
    levels,
    base,
    prev,
    shifts: base ? levelShifts(levels, base, prev, range) : [],
    step: strikeStep(cur.rows),
    timeline: snaps.length ? snaps : [cur],
  };
}

export type LevelView = ReturnType<typeof buildView>;
