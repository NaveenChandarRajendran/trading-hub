// ORB Algo Overview: types of /api/algos/orb/overview and pure helpers (filter text, tones). Rules: docs/strategies/orb.md.
import type { Tone } from '../../../shared/ui';

export type SetupKey = 'b60' | 'r30' | 'v5';
export type SetupStatus = 'waiting' | 'armed' | 'in trade' | 'done' | 'filtered' | 'off';

export interface OpeningRange { minutes: number; high: number | null; low: number | null; sizePct: number | null; done: boolean }
export interface SetupState { key: SetupKey; name: string; orMin: number; status: SetupStatus; reason: string;
  first: { side: 'high' | 'low'; at: string } | null; inside: boolean }
export interface OpenTrade { setup: SetupKey; name: string; dir: 'long' | 'short'; side: 'CE' | 'PE'; strike: number | null; lots: number;
  entryAt: string; entrySpot: number; entryPrice: number | null; stop: number; ltp: number | null; pnl: number | null; pointsNow: number | null }
export interface ClosedTrade extends Omit<OpenTrade, 'ltp' | 'pnl' | 'pointsNow'> {
  exitAt: string; exitSpot: number | null; exitPrice: number | null; exitReason: string; points: number | null; pnl: number | null; charges: number | null }
export interface OrbOverview {
  asOf: string; spot: number | null; expiry: string | null; dayOpen: number | null; mode: string; stale: boolean; tokenExpired: boolean;
  ors: Record<'5' | '30' | '60', OpeningRange>; setups: SetupState[]; open: OpenTrade[]; closed: ClosedTrade[]; trades: number;
  settings: { orSizePct: number; entryBefore: string; retestWithinMin: number; squareOff: string; lots: number; dayLossStopPct: number };
  funds: { dayPnl: number } | null;
}

export const STATUS_TONE: Record<SetupStatus, Tone> = {
  waiting: 'neutral', armed: 'up', 'in trade': 'accent', done: 'neutral', filtered: 'warn', off: 'neutral',
};

/** Which setup uses an OR and whether its size filter passes: "60m Breakout: needs > 0.5% · passes". */
export function orFilter(minutes: number, sizePct: number | null, limit: number): { text: string; ok: boolean | null } {
  if (minutes === 5) return { text: '5m Reversal: no size filter', ok: true };
  const b60 = minutes === 60;
  const rule = `${b60 ? '60m Breakout' : '30m Retest'}: needs ${b60 ? '>' : '≤'} ${limit}%`;
  if (sizePct == null) return { text: rule, ok: null };
  const ok = b60 ? sizePct > limit : sizePct <= limit;
  return { text: `${rule} · ${ok ? 'passes' : 'filtered out'}`, ok };
}

/** OR window text: "09:15–10:14". */
export function orWindow(minutes: number): string {
  const end = 9 * 60 + 15 + minutes - 1;
  return `09:15–${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
