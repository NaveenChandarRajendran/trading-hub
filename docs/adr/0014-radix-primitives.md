# ADR 0014: Radix UI primitives for dialogs, popovers, tooltips and menus

Date: 13-Nov-2026. Status: accepted.

## Context
The Strategy Builder's new "create a strategy" experience needs a modal gallery, a popover (check limits), tooltips on
disabled buttons and dropdown menus, all keyboard accessible and in both themes. Until now each app hand-rolled these
(custom menus, `window.confirm`, `title` attributes). Naveen ruled out Ant Design and Material UI: the design system
(tokens, components, AG Grid) stays ours.

## Decision
- Add four headless Radix UI packages, pinned to exact versions at least two weeks old (published 12-Oct-2026):
  `@radix-ui/react-dialog` 1.3.1, `@radix-ui/react-popover` 1.3.1, `@radix-ui/react-tooltip` 1.4.1,
  `@radix-ui/react-dropdown-menu` 2.2.1. No styles come with them.
- Wrap them once in `frontend/src/shared/ui/radix.tsx` (`Dialog`, `Popover`, `Tip`, `Menu`) and style them only with our
  tokens (`ui.css`, `rx-` classes). Apps use the wrappers, never Radix directly.
- Radix renders this content in a portal under `<body>`, outside the app's `.ds` container, so the wrapper puts `ds` on
  the content itself; the scoped design-system styles then apply unchanged.
- A disabled button gets no pointer events, so `Tip` wraps it in a focusable span: the reason ("Add legs to paper
  trade") shows on hover and on keyboard focus.

## Consequences
- Focus trapping, Esc, outside-click and ARIA roles come from Radix instead of per-app code.
- The bundle grows by a few tens of KB (still one self-contained `dist/index.html`).
- Older hand-rolled menus (the Builder's Drafts / Analyze menus) can move onto `Menu` later; they still work as they are.
