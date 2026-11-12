// Pure helpers of the OI Breakout Overview: level order, state tones, the end-of-day variant comparison.
import type { Tone } from '../../../shared/ui';
import type { ComparisonRow, Slot } from './api';

export const LEVEL_ORDER: Slot[] = ['S3', 'S2', 'S1', 'R1', 'R2', 'R3'];

export function stateTone(state: string): Tone {
  if (state === 'in trade') return 'accent';
  if (state === 'stopped') return 'down';
  if (state.includes('armed')) return 'up';
  return 'neutral';
}

/** The comparison rows A-D in order. */
export const comparisonRows = (rows: ComparisonRow[]) => [...rows].sort((a, b) => a.variant.localeCompare(b.variant));

/** The end-of-day comparison shows once the daily summary time (15:35) has passed. */
export const showEod = (asOf: string | undefined, summaryAt: string | undefined) =>
  !!asOf && !!summaryAt && asOf.slice(11, 16) >= summaryAt;
