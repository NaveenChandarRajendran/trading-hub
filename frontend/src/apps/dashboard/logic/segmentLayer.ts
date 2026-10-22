// S/R level segments on the chart: one line series per segment, created once and then updated in place (no redraw,
// so nothing flickers on refresh). Current levels keep the familiar look (R in --down, S in --up, level 1 solid, the
// others dashed, right-axis label); earlier levels are thin and faded and end where they were replaced.
// Written against a tiny interface so it can be tested without a canvas.
import type { Segment } from './levelHistory';

export interface SegStyle {
  color: string;
  lineWidth: 1 | 2;
  lineStyle: number; // lightweight-charts LineStyle: 0 solid, 2 dashed
  lastValueVisible: boolean; // right-axis label (current levels only)
  title: string;
  visible: boolean;
}
export interface SegHandle {
  setData(points: { time: number; value: number }[]): void;
  applyOptions(o: Partial<SegStyle>): void;
}
export interface SegHost {
  add(style: SegStyle): SegHandle;
  remove(h: SegHandle): void;
}
export interface LevelColors {
  up: string; // --up, support
  down: string; // --down, resistance
}

const SOLID = 0;
const DASHED = 2;
const SECONDARY_ALPHA = 0.6; // R2/R3, S2/S3 lighter than R1/S1
const PAST_ALPHA = 0.3; // replaced levels

/** A token colour with transparency: "#d13f3f" + 0.6 -> "#d13f3f99" (8-digit hex, which the chart canvas accepts).
 *  Anything that isn't a 6-digit hex colour is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (!/^#[0-9a-f]{6}$/i.test(c)) return color;
  return c + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

export function segStyle(seg: Segment, colors: LevelColors, showHistory: boolean): SegStyle {
  const base = seg.slot[0] === 'R' ? colors.down : colors.up;
  const primary = seg.slot.endsWith('1');
  if (!seg.current) {
    return { color: withAlpha(base, PAST_ALPHA), lineWidth: 1, lineStyle: SOLID, lastValueVisible: false, title: '', visible: showHistory };
  }
  return {
    color: primary ? base : withAlpha(base, SECONDARY_ALPHA), lineWidth: primary ? 2 : 1, lineStyle: primary ? SOLID : DASHED,
    lastValueVisible: true, title: seg.slot, visible: true,
  };
}

const points = (s: Segment) =>
  s.to > s.from ? [{ time: s.from, value: s.strike }, { time: s.to, value: s.strike }] : [{ time: s.from, value: s.strike }];

export class SegmentLayer {
  private shown = new Map<string, { handle: SegHandle; key: string }>();

  constructor(private host: SegHost) {}

  /** Adds new segments, updates changed ones in place, removes the ones that are gone (new index / expiry / day). */
  update(segments: Segment[], colors: LevelColors, showHistory: boolean) {
    const keep = new Set<string>();
    for (const seg of segments) {
      keep.add(seg.id);
      const style = segStyle(seg, colors, showHistory);
      const key = `${seg.from}|${seg.to}|${seg.strike}`;
      const have = this.shown.get(seg.id);
      if (!have) {
        const handle = this.host.add(style);
        handle.setData(points(seg));
        this.shown.set(seg.id, { handle, key });
        continue;
      }
      have.handle.applyOptions(style);
      if (have.key !== key) {
        have.handle.setData(points(seg)); // the current level grows to the latest bar
        have.key = key;
      }
    }
    for (const [id, s] of this.shown) {
      if (!keep.has(id)) {
        this.host.remove(s.handle);
        this.shown.delete(id);
      }
    }
  }

  get count() {
    return this.shown.size;
  }
}
