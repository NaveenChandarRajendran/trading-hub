// S1-S3 / R1-R3 as chart price lines that are created ONCE and then updated in place (no remove + redraw, so
// nothing flickers when the levels change). Written against a tiny interface so it can be tested without a canvas.
import type { Level, Side } from '../../oi-support-resistance/logic/levels';

export interface LineSpec {
  price: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  lineStyle: number; // lightweight-charts LineStyle: 0 solid, 2 dashed
  lineVisible: boolean;
  axisLabelVisible: boolean;
  title: string;
}
export interface LineHandle {
  applyOptions(o: Partial<LineSpec>): void;
}
export interface LineHost {
  createPriceLine(o: LineSpec): LineHandle;
}
export interface LevelColors {
  up: string; // --up, support
  down: string; // --down, resistance
}

export const LEVEL_KEYS = ['R1', 'R2', 'R3', 'S1', 'S2', 'S3'] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];
const DASHED = 2;
const SECONDARY_ALPHA = 0.6; // R2/R3, S2/S3 are lighter than R1/S1

/** A token colour with transparency: "#d13f3f" + 0.6 -> "#d13f3f99" (8-digit hex, which the chart canvas accepts).
 *  Anything that isn't a 6-digit hex colour is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (!/^#[0-9a-f]{6}$/i.test(c)) return color;
  return c + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

/** How one level line looks. A missing level keeps its line but hides it. */
export function lineSpec(key: LevelKey, level: Level | undefined, colors: LevelColors, lastPrice = 0): LineSpec {
  const base = key[0] === 'R' ? colors.down : colors.up;
  const primary = key.endsWith('1');
  return {
    price: level?.strike ?? lastPrice,
    color: primary ? base : withAlpha(base, SECONDARY_ALPHA),
    lineWidth: primary ? 2 : 1,
    lineStyle: DASHED, // all OI levels dashed (owner's brief, 23-Oct-2026); R1 / S1 stay thicker
    lineVisible: !!level,
    axisLabelVisible: !!level,
    title: key, // just "R1"; the price scale shows the strike
  };
}

export class LevelLines {
  private lines = new Map<LevelKey, LineHandle>();
  private prices = new Map<LevelKey, number>();

  constructor(private host: LineHost) {}

  /** Draws or moves the six lines. Creates them on the first call only; afterwards every change is applyOptions. */
  update(levels: Record<Side, Level[]> | null, colors: LevelColors) {
    for (const key of LEVEL_KEYS) {
      const level = levels?.[key[0] as Side][Number(key[1]) - 1];
      const spec = lineSpec(key, level, colors, this.prices.get(key));
      const line = this.lines.get(key);
      if (line) line.applyOptions(spec);
      else this.lines.set(key, this.host.createPriceLine(spec));
      this.prices.set(key, spec.price);
    }
  }

  get count() {
    return this.lines.size;
  }
}
