// Power Scalper layout helpers (pure): bottom strip height while dragging, strike dropdown placement on screen.

export const STRIP_MIN = 120; // px, expanded bottom strip
export const STRIP_MAX_SHARE = 0.6; // of the window height
export const STRIP_DEFAULT = 220;

/** Expanded bottom strip height, kept between STRIP_MIN and 60 % of the window. */
export function clampStrip(h: number, viewportH: number): number {
  const max = Math.max(STRIP_MIN, Math.round(viewportH * STRIP_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(STRIP_MIN, h)));
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/** Fixed position of a dropdown under its button: left-aligned, shifted left to stay on screen, opened above the
 *  button when there is no room below (and more room above). `gap` = space between button and dropdown. */
export function popPlacement(btn: Rect, popW: number, popH: number, viewW: number, viewH: number, gap = 4, margin = 8) {
  const left = Math.max(margin, Math.min(btn.left, viewW - popW - margin));
  const below = viewH - btn.bottom - gap - margin;
  const above = btn.top - gap - margin;
  const up = popH > below && above > below;
  const top = up ? Math.max(margin, btn.top - gap - popH) : btn.bottom + gap;
  return { left, top, maxHeight: Math.max(120, up ? above : below) };
}
