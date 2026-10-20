# ADR 0001: Roll out the design system scoped to `.ds`

Date: 2026-10-20 · Status: accepted

## Context
The design system (tokens + component styles from the trading-hub-feature skill) reuses class names that
`index.css` already defines with different looks: `.card`, `.btn`, `.pill`, `.dots`, `table.t`, and the global
`select / input / textarea` rules. Loading it globally would restyle the four existing apps.

## Decision
- `src/shared/tokens.css` is imported globally before `index.css`. It only adds custom properties; where names
  overlap (`--bg`, `--surface`, `--text`, `--border`, `--accent`) `index.css` still wins, so old apps are unchanged.
- `src/shared/ui/ui.css` has every rule prefixed with `.ds`. New apps render inside `<div className="ds">`.
- Old apps move inside `.ds` one at a time, as visual-only changes with numbers unchanged.

## Consequences
- New apps get the design system now without regressions elsewhere.
- Until migration ends, the five overlapping tokens use the `index.css` values, and rules from `index.css`
  (e.g. `.error`, `textarea { width: 100% }`) can still apply inside `.ds`.
- When the last app is migrated: remove the `.ds` prefix and the duplicated rules in `index.css`.
