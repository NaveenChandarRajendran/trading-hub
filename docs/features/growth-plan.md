# Feature: Growth Plan + Plan Tracker

Branch `feature/growth-plan` (from `naveen-dev`), plan approved 28-Oct-2026. ADR 0009 (how returns are measured).

## Planner (sidebar: Growth Plan)
- Inputs: name, yearly target %, initial capital (₹1L / ₹5L / custom), start month, method.
- Monthly target: **Compounded** (1 + Y)^(1/12) − 1 (24 % → 1.81 %, ends the year exactly on Y) or **Simple** Y ÷ 12
  (24 % → 2.00 %, which compounds to 26.82 %). Both are shown with the formula.
- Year table (year, months, start, target %, end, profit; click a year) and the month table of the chosen year (start,
  target %, target profit, end). 5 years; "+5 years" up to 20. Amounts with CopyValue; CSV for both tables.
- "Your plans" table: name, yearly target, method, monthly %, initial capital, start, years, **Used by** (strategies
  using it now, linked) and **Used before**; Edit / Delete. Edit loads it into the form ("Editing: <name>"): **Save
  changes** updates the same plan (every field), **Save as new** keeps it and saves a copy, **Cancel**. Delete asks
  first (naming its strategies) and removes the plan with its links and history. Editing a plan moves the targets of
  every strategy using it; each keeps its own tracking start capital.

## Plan ↔ strategy
- One active plan per strategy (`th_strategy_plans`, unique while `ended_at` is NULL); applying another ends the old
  one, which stays in the history. Archiving a plan ends its links.
- The tracker starts from the strategy's capital when the plan is applied (the page warns when the plan was made for
  another amount).

## Plan Tracker (strategy view → Plan tab; strip on Paper Trading and Power Scalper)
- Actual month % = net realized P&L after charges ÷ capital at the start of the month (initial + earlier months' net +
  earlier cash flows): it compounds. Open positions are not counted; unrealized is shown apart.
- Capital changes on the strategy (`th_capital_events`: set capital, reset) are cash flows, never profit. A flow inside a
  month counts from its day (Modified Dietz: base = start + flow × days left / days in month). The plan's ₹ path gets the
  same flows, so adding money never looks like being ahead.
- Box colours: green target met (the % rounded to 2 decimals ≥ the target's), amber profit below target, red loss,
  neutral ₹0 / no trades, grey future; the current month is outlined. Hover: actual and target ₹ / %, start / end
  capital, plan end, cash flow, and for the current month both catch-up figures + why + the risk caution.
- Plan year = 12 months from the start month. Year summary: plan capital vs actual (now), Ahead / On track (±0.25 %) /
  Behind, and the % needed per month for the rest of the year.
- Catch-up (pure, `logic/tracker.ts`): this month alone = plan capital at the end of the current month ÷ actual now − 1
  (2 %/month plan, month 1 at −2 % → 1,04,040 / 98,000 − 1 = +6.16 %); spread = (year-end plan ÷ actual now)^(1/months
  left incl. the current one) − 1 (→ 2.37 % for the 11 months left). The spread figure is the headline "needed".
- Strip: "This month: +1.2% of 1.81% target · ₹6,000 to go" / "target met ✓" / "behind" (or "Add a growth plan").

## API
`/api/plans` (list, create, get, PATCH name / years, archive), `POST|DELETE|GET /api/strategies/{id}/plan` (apply,
remove, tracker inputs: plan, mapping, history, days [{date, net}], flows, unrealized, today). Others' plans and
strategies are 404.

## Tests
`frontend/src/apps/growth-plan/logic/plan.test.ts` (1.81 / 2.00 / 26.82 %, 5 / 10 / 20-year values),
`tracker.test.ts` (month % on start capital, colours at the edges, the catch-up example, cash flows not returns,
standing, strip), `backend/test_growth_plans.py` (privacy, one active plan + history, archive, capital events as cash
flows, tracker days across capital periods; JSON + Postgres).

## Not yet
Strategy view tabs other than Plan (Positions, Order book, P&L, Notes), Compare. The algo's strategy has no capital
events except its start (its capital can't be changed).
