# Frontend conventions (frontend/)

Stack: React 19 + TypeScript + Vite 6, react-router (HashRouter), AG Grid Community, plain CSS with
tokens, vitest. Build = `vite-plugin-singlefile` → one `dist/index.html` that opens by double-click.
So there are no server-only features, all assets are bundled, and nothing needs a dev server at runtime.

## Adding an app
```
src/apps/<kebab-name>/
  <PascalName>App.tsx      # UI only: state, effects, layout, grid columns
  <kebab-name>.css         # optional, layout specific to this app; tokens only, classes prefixed (e.g. .toi-)
  logic/
    <thing>.ts             # pure, UI-agnostic: parsing, formulas, formatting rules
    <thing>.test.ts        # vitest, real-data fixtures
    api.ts                 # typed backend calls (if it uses the backend)
    __fixtures__/*.json    # real captured payloads (trim to a small but representative size)
  config/
    settings.ts            # constants: defaults, intervals, refresh ms, thresholds
```
Then add one entry to `src/apps/registry.ts` (id, name, path, icon, lazy component). Nothing else in
the shell should change for a new app.

## Rules
- **Logic stays pure.** Anything with a formula lives in `logic/`, takes plain data, and returns plain data.
  It doesn't touch React, fetch, or the DOM. Parsers normalize raw payloads (NSE / Sensibull / Dhan) into a flat
  model. Formulas only consume that model. This is what makes the numbers testable and reusable on the backend later.
- **Tests:** every formula gets a vitest test against a fixture, with expected values you checked by hand or
  against the reference tool (OI Pulse, NSE chain). Put the source of each expected value in a comment.
- **API calls** follow `trending-oi/logic/api.ts`: typed response interfaces, one `getJson` helper that turns
  network failure into a readable `ApiError` ("Cannot reach the backend at … Is `python main.py` running?"),
  `AbortController` in effects, and errors shown with `.alert`. Backend base URL from
  `import.meta.env.VITE_API_BASE` (default `http://127.0.0.1:8000`). If two apps need the same helper, move
  it to `src/shared/api.ts` instead of copying it.
- The Dhan token never reaches the browser. All Dhan calls go through the backend.
- **Polling:** `setInterval` inside an effect with cleanup, interval from `config/settings.ts`. Pause when
  the tab is hidden (`document.visibilityState`) for anything polling faster than 30s.
- **Persistence:** user preferences (last symbol, interval, view) in `localStorage` under `<app-id>.<key>`,
  always wrapped in try/catch.
- **Formatting:** use `inr()` from `src/shared/grid.ts` (or `src/shared/format.ts` if it gets split out).
  Don't write a new `Intl.NumberFormat` in an app.
- **Shared UI** (`src/shared/ui/`): small typed components (`Card`, `Toolbar`, `Field`, `Segmented`, `Pill`,
  `Stat`, `Status`, `EmptyState`, `Alert`) using the classes in `ui.css`. Create one the first time a feature needs
  it. Later features import it.
- **Types:** strict TypeScript, no `any`. Export types from `logic/` and import them in the UI.
- Symbols/expiries: reuse `option-strategy/config/expiries.ts` `SYMBOLS` until it moves to `src/shared/`.
  New features should import from shared once it exists.

## Grid column pattern
```ts
const columns: ColDef<Row>[] = [
  { field: 'time', headerName: 'Time', pinned: 'left', width: 90, cellStyle: { textAlign: 'left' } },
  { field: 'callChg', headerName: 'Chg Call OI', headerTooltip: 'Change in call OI vs previous close (units)',
    valueFormatter: num(), cellClass: 'num' },
  { field: 'diffOi', headerName: 'Diff OI', valueFormatter: signed(), cellClass: posNeg },  // posNeg → 'up' | 'down' | ''
  { field: 'sentiment', headerName: 'Sentiment', cellRenderer: SentimentPill },               // <span className="pill up">
];
```
