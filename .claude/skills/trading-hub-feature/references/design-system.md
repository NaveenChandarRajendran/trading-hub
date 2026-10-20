# Trading Hub design system

Target feel: **Zerodha Kite plus Google Workspace.** Calm and dense. White (or near-black) surfaces,
thin borders, almost no shadows, one blue accent, and color reserved for meaning. A trader scans
numbers all day, so quiet chrome makes the important numbers stand out.

## Contents
1. Principles
2. Tokens (the only source of color, size and spacing)
3. Typography and numbers
4. Page layout
5. Components
6. Tables (AG Grid and plain)
7. States: loading, empty, error, stale, market closed
8. Light / dark
9. Don'ts
10. Migrating existing apps

## 1. Principles
- **Color means something.** Green = up / bullish / profit / support (put side). Red = down /
  bearish / loss / resistance (call side). Amber = warning. Blue accent = interactive or selected.
  Everything else is grey. If a color doesn't carry one of these meanings, remove it.
- **Tint, don't fill.** Signals are soft-tinted backgrounds with colored text (`--up-soft` +
  `--up`), not saturated full-row fills. Save solid fills for at most one "verdict" element per screen.
- **Density with breathing room.** Compact rows (28px) and small type, but consistent 16px gaps
  between sections and 20px page padding.
- **Numbers first.** Right-aligned, tabular figures, Indian grouping, explicit sign on changes.
- **One way to do each thing.** Before styling something new, check whether a token, class or shared
  component already covers it.

## 2. Tokens
The canonical file is `assets/tokens.css` in this skill. Copy it to `frontend/src/shared/tokens.css`
and import it once in `main.tsx` before `index.css` (do this the first time the skill runs, if it's missing).
App CSS uses **only** `var(--…)` tokens. No hex, rgb or hsl values outside `tokens.css`.

| Group | Tokens |
|---|---|
| Surfaces | `--bg` page, `--surface` cards, `--surface-2` subtle fill (table header, hover, segmented track) |
| Lines | `--border`, `--border-strong` (focus/hover edges) |
| Text | `--text` primary, `--text-2` secondary, `--text-3` muted/labels/disabled |
| Accent | `--accent`, `--accent-hover`, `--accent-soft` (selected backgrounds), `--on-accent` (text on accent) |
| Meaning | `--up`, `--up-soft`, `--down`, `--down-soft`, `--warn`, `--warn-soft` |
| Option sides | `--call-soft`, `--put-soft` for column/header tints. Call-side text uses `--down`, put-side `--up` |
| Size | `--fs-xs 11px`, `--fs-sm 12px`, `--fs-md 13px` (body), `--fs-lg 15px` (page title), `--fs-xl 20px` (stat values) |
| Space | `--sp-1 4px`, `--sp-2 8px`, `--sp-3 12px`, `--sp-4 16px`, `--sp-5 20px`, `--sp-6 24px` |
| Radius | `--r-sm 4px` (pills), `--r-md 6px` (inputs, buttons), `--r-lg 8px` (cards) |
| Control | `--control-h 30px`, `--row-h 28px`, `--header-h 32px` |
| Elevation | `--shadow-pop` for menus/popovers only. Cards are flat with a border |

If a new meaning is needed (for example "neutral sentiment"), add a token to `tokens.css` for both
themes in the same change and note it in the plan. Don't add one-off colors in app CSS.

## 3. Typography and numbers
- Font: `Inter, system-ui, sans-serif`. Body `--fs-md` (13px), weight 400. Labels and table headers
  `--fs-sm`, `--text-3`, weight 500. Card titles `--fs-sm`, weight 600, `--text-2`, sentence case.
  No ALL-CAPS headings except tiny status tags like `LIVE`.
- Weights: only 400, 500 and 600.
- All numbers use `font-variant-numeric: tabular-nums` (the `.num` class) and are right-aligned in tables.
- Format with the shared `inr(d)` helper (`en-IN` grouping: 1,23,456.50). Prices 2 decimals, OI
  0 decimals, percentages 2 decimals with `%`.
- Changes carry an explicit sign: `+1,250` / `−830` (use the real minus `−`, U+2212), colored `.up` / `.down`.
  Zero is plain `--text-2`.
- Show units when ambiguous: "OI (units)", "Chg (lots)". Times are IST: `11:05` in tables,
  `As of 11:05:03 IST` in status lines. Dates `19 Oct 2026`, or `19-10` in dense tables.

## 4. Page layout
The shell (sidebar + topbar) is shared. An app renders only its content, in this vertical order:

```
┌ Toolbar card ─────────────────────────────────────────────────────────┐
│ [Index ▾] [Expiry ▾] [Interval: 1 3 5 15]       ● Live · 11:05 IST  [↻] │
└───────────────────────────────────────────────────────────────────────┘
┌ Summary strip (optional, 3–5 stat tiles) ──────────────────────────────┐
│ NIFTY 25,104.30 +0.42%   │ PCR 1.12   │ Sentiment Bullish   │ Strikes 15 │
└───────────────────────────────────────────────────────────────────────┘
┌ Main card: title + actions (CSV) ──────────────────────────────────────┐
│ grid / chart / panels                                                  │
│ footnote: how the numbers are computed (--fs-sm, --text-3)             │
└───────────────────────────────────────────────────────────────────────┘
```

- **Toolbar**: inputs on the left, status and actions on the right. Rarely changed settings
  (backend URL, thresholds) go behind a "Settings" ghost button in a small popover, not inline.
- **Status** is always visible for live data: dot + text (`Live`, `Paused`, `Market closed`, `Stale 3m`).
- Two-column layouts use the `.split` grid and collapse to one column under 1000px.
- Page padding `--sp-5`, gap between cards `--sp-4`, card padding `--sp-4`.

## 5. Components
Prefer the shared React components in `src/shared/ui/`. The base styles for all of them are in this skill's
`assets/ui.css`. Copy it to `src/shared/ui/ui.css` (imported once in `main.tsx` after `tokens.css`) the first time,
and extend it there. If a component doesn't exist yet, create it in `src/shared/ui/` so the next app reuses it. Base class names:

| Component | Class | Notes |
|---|---|---|
| Card | `.card`, `.card-head`, `.card-title` | flat, 1px `--border`, `--r-lg` |
| Toolbar | `.toolbar` (inside a card) | flex, wrap, `--sp-3` gap, `.toolbar-end` pushes to the right |
| Field | `.field` > label + control | label `--fs-sm --text-3` above the control |
| Select / input | native elements, `--control-h` high | `--surface` bg, `--border`, focus ring `--accent-soft` 3px |
| Button | `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.icon` | one `.primary` per screen at most |
| Segmented | `.seg` > `button.on` | for 2–5 mutually exclusive options (interval, view) |
| Pill | `.pill.up / .down / .warn / .neutral` | soft bg + colored text, `--r-sm`, `--fs-xs`, weight 600 |
| Stat tile | `.stat` > `.stat-label` + `.stat-value` + `.stat-delta` | value `--fs-xl` 600 |
| Status dot | `.dot.live / .idle / .error` | live has a soft halo |
| Strength dots | `.dots` > `i.on.up / i.on.down` | 3 dots, 6px |
| Alert | `.alert.error / .warn / .info` | soft bg, 1px tinted border, short message + action |
| Empty state | `.empty` | centered `--text-3`, one line of help + optional button |

Icons: currently single glyphs in the registry. Don't mix icon styles. If an icon set is
introduced, it goes into the plan as an approved dependency or inline SVGs in `src/shared/ui/icons.tsx`.
No emoji in the UI.

## 6. Tables
AG Grid via `useGridTheme()` from `src/shared/grid.ts` (rowHeight 28, header 32, font 12, accent from tokens).
- Numbers right-aligned, text left. First column (time/strike/symbol) left-aligned and pinned when scrolling sideways.
- Headers short and title case: "Chg Call OI", not "Chng. In Call OI". Put the long form in `headerTooltip`.
- Signals in cells use `.pill` (soft), and plain changes use `.up/.down` text color. Avoid coloring whole rows,
  except one highlight row (ATM, LIVE) with `--accent-soft`.
- Call/put column groups get `--call-soft` / `--put-soft` header tint only, not every cell.
- Every grid card has a CSV export ghost button in the card head when the data is useful offline.
- Plain `<table class="t">` is fine for under ~15 rows. Same rules.

## 7. States
Every data view handles all of these explicitly. A blank grid is never acceptable:
- **Loading**: skeleton rows or a muted "Loading…" in the card body. Keep the toolbar usable.
- **Empty**: `.empty` with the reason ("No snapshots yet today. Recording starts at 09:15 IST.").
- **Error**: `.alert.error` with what failed and what to do (e.g. backend not running → the exact command;
  token expired → how to send a new one). Keep showing the last good data under the alert.
- **Stale**: if the last update is older than 2× the refresh interval, the status dot turns `--warn`
  with "Stale · 3m".
- **Market closed**: `.pill.neutral` "Market closed" in the status area, and the last session's data still shown.

## 8. Light / dark
Theme switching uses `data-theme` on `<html>` (see `src/shared/theme.tsx`). All tokens are defined
for both themes in `tokens.css`. Rules:
- Never hard-code `#fff` text on colored fills. Use `--on-accent`, or the soft-tint pattern, which works
  in both themes.
- Dark mode isn't inverted light mode. Surfaces get lighter as they rise (`--bg` < `--surface` < `--surface-2`),
  and green/red are slightly desaturated so they don't glow.
- Check every new screen in both themes before reporting done.

## 9. Don'ts
- No hex/rgb colors, no `style={{ color… }}` or `background` inline, outside `tokens.css`. Use layout-only inline
  styles (height of a grid container) sparingly.
- No new font sizes or spacing values outside the scale.
- No saturated full-cell or full-row fills for routine data, no gradients, no heavy shadows, no animation
  beyond a 100–150ms hover/focus transition.
- No app-specific copies of shared things (a second segmented control, a second number formatter).
- Don't put a backend URL field or debug info on the main toolbar. Move it to Settings.

## 10. Migrating existing apps
The current code predates this system. Known gaps, to fix when an app is next touched (with Naveen's OK,
one app per change, numbers unchanged):
- `index.css` defines older token names (`--muted`, `--green`, `--red`, `--call` as backgrounds). Map them:
  `--muted`→`--text-3`, `--green`→`--up`, `--red`→`--down`, old `--call/--put` tints→`--call-soft/--put-soft`.
- `components.css` has its own `--cp-*` palette with hex values. Replace with shared tokens and
  `src/shared/ui` components (its segmented control and stat tiles become the shared ones).
- `--sb-*` saturated fills (Sensibull OI blocks, level rows) should move to the soft-tint pattern. The one
  allowed solid element per screen is the final verdict.
- Trending OI: move the Backend URL input into a Settings popover; shorten column headers.
