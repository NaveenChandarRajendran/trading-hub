---
name: trading-hub-feature
description: Plan and build features for Naveen's Trading Hub, an enterprise-style Indian index-options platform (NIFTY, BANKNIFTY; React + AG Grid frontend, FastAPI + Dhan backend), with one calm, Kite-like design system in light and dark. Use this skill whenever the work touches Trading Hub, including new feature ideas ("I got an idea…", "add a page that…", "can we show…"), new apps or screens, changes to existing apps (OI & OI Change, Sensibull OI, Trending OI, Index Components), new backend endpoints, Dhan data, OI/option-chain views, strategy dashboards, or any UI/styling/theme work in the trading-hub repo, even if the user doesn't say "feature" or name the skill.
---

# Trading Hub feature builder

Trading Hub is Naveen's own trading tool first and a product later. Build every feature as if it will
be shown to paying users, so it needs one consistent look, predictable structure, and calculations
that are tested. Naveen describes ideas in plain language, often as trading context ("when price
breaks R1 I want to see…"). Your job is to turn that into a short plan, get his approval, and then
write the code yourself. Don't ask him to write code or send it for review, and don't add
interview-style summaries.

## Before anything else

1. Read `CLAUDE.md` at the repo root. It is the source of truth for commands, architecture and rules.
   If anything below conflicts with it, follow `CLAUDE.md` and mention the conflict.
2. Read `docs/02-current-state.md` if it exists. Check the actual folders: only rely on files that exist.
3. Read the reference files you need:
   - `references/design-system.md`: **always** read this when the feature has any UI. It holds the
     tokens, layout patterns, components, and rules for color and numbers.
   - `references/frontend.md`: app structure, registry, logic/test pattern, API client pattern.
   - `references/backend.md`: FastAPI and Dhan patterns, storage, rate limits, tests.

## Step 1: Plan, then wait

Reply with a plan in this shape and **stop**. Don't write any code until Naveen approves it ("go",
"ok build it", or changes). The plan is where misunderstood trading logic gets caught cheaply.
A wrong formula costs real money, and a wrong layout costs a rebuild.

```
## <Feature name>
**What it does:** one or two sentences, in trading terms: what he sees and when he'd use it.
**Data:** source (user paste / Dhan endpoint / existing backend API), refresh rate, Dhan rate limits involved.
**Calculations:** each formula in plain words + units (units vs lots, which strikes, which previous close).
**Backend:** new/changed endpoints with request params and a short response example. "None" if frontend-only.
**Screen:** a small ASCII wireframe using the standard page layout (toolbar → summary strip → main grid/panel).
**Files:** list of files to add/change.
**Tests:** what gets a test and the fixture it uses.
**Questions:** only things you truly can't decide (rules that are ambiguous, missing thresholds).
```

Keep it short: one screen, not an essay. If the idea is vague, ask up to 3 focused questions inside
the plan's **Questions** section instead of a separate round-trip. Where a sensible default exists,
pick it and say so ("Default 5-min interval, change in the toolbar").

If the idea depends on a strategy rule, check `docs/strategies/*.md`. If the rule isn't written
down, ask. Don't invent trading rules.

## Step 2: Build (after approval)

Work in this order, because each layer is testable before the next one depends on it:

1. **Logic first**: pure functions in `logic/` (frontend) or calc modules (backend), with tests and
   a real JSON fixture. Preserve the existing numeric semantics described in `CLAUDE.md`.
2. **Backend** endpoint (if any), wired through `create_app` so tests can inject fakes.
3. **Frontend app**: folder under `src/apps/<name>/` plus one registry entry, built only from the
   design-system tokens and shared components.
4. **Shared UI**: if the feature needs a component that two apps could use (segmented control,
   stat tile, status dot, empty state…), put it in `src/shared/ui/`, not inside the app.

Keep each feature on its own branch (`feature/<name>`) with small commits. Never stage or commit
`.env*` files, tokens, or `data/` snapshots. Never add a code path that places real orders unless
it's explicitly LIVE mode, as `CLAUDE.md` requires.

Don't add new npm or pip dependencies unless the plan listed them and was approved. The
frontend must keep building into one self-contained `dist/index.html`.

## Step 3: Verify before saying done

Run these and fix failures. Don't report "done" on code that hasn't run:

- `cd backend && python -m pytest -q` (if the backend changed)
- `cd frontend && npm test && npm run build`
- `python <this-skill>/scripts/check_ui.py <repo>/frontend/src`: flags hard-coded colors, inline
  color styles and other design-system breaks in app code. Fix what it reports in the files you touched.
- Check the screen in **both** light and dark mode, plus the loading, empty, error, and
  market-closed states (see the design system's state rules).

Then update `docs/02-current-state.md` (create it if missing) with what changed, how to run it,
and known limits. Finish with a short reply: what was built, how to open it, anything left open.

## When the request is UI-only

For "make X look cleaner", "fix dark mode on Y", or aligning an old app to the design system:
skip the full plan template and send a short before/after list of changes, then build after his OK.
Migrate one app at a time, and keep behavior and numbers identical. Visual changes only.
