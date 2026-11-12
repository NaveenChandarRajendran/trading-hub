// Trending OI Algo Overview helpers (pure): the direction pill.
import type { Tone } from '../../../shared/ui';
import type { Direction } from './api';

/** "Bullish 64.0% ●●●" style pieces; the verdict when no direction yet. */
export function directionText(d: Direction | null): { text: string; dots: string; tone: Tone } {
  if (!d || d.sentiment == null || d.strength == null) return { text: 'No Trending OI yet', dots: '', tone: 'neutral' };
  const dots = '●'.repeat(d.dots) + '○'.repeat(Math.max(0, 3 - d.dots));
  const tone: Tone = d.side == null ? 'neutral' : d.side === 'CE' ? 'up' : 'down';
  return { text: `${d.sentiment} ${Math.abs(d.strength).toFixed(1)}%${d.side ? ` → ${d.side} only` : ''}`, dots, tone };
}
