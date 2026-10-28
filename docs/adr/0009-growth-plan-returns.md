# ADR 0009: How the Plan Tracker measures returns

Date: 2026-10-28 · Status: accepted

## Context
A Growth Plan sets a monthly % target. To compare, each month needs an actual %. Strategies can change capital (set
capital, reset) in the middle of a month; counting that money as profit would make a strategy look ahead of plan.

## Decision
- Actual % = net realized P&L after charges ÷ capital at the start of the month, where that capital compounds
  (initial + earlier net + earlier cash flows). Unrealized P&L is never counted.
- Capital changes are recorded as cash flows (`th_capital_events`, written by strategies.py): set = new − old capital;
  reset = new capital − the closed period's equity. A flow inside a month weighs by the days left (Modified Dietz).
- The plan's ₹ path receives the same flows, so ₹ comparisons stay fair.
- Maths lives in the frontend's pure `growth-plan/logic` (vitest); the backend stores plans / links / flows and serves
  the daily net P&L.

## Consequences
Month % is close to a time-weighted return without daily valuations. Existing strategies got a `start` event at their
creation (bootstrap), so earlier capital changes (before 28-Oct) are not known as flows.
