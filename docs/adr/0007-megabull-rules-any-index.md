# 0007 · MegaBull rules on any index, final strategy names

Date: 25-Oct-2026. Status: accepted (owner).

## Context
MegaBull ran one rule per index: 4 Pillar on BANKNIFTY, SuperTrend Nifty on NIFTY (`megabull_rule` picked by symbol).
The owner wants more trades to judge them before the 15 Nov review: "why the 4 pillar should only stick with the bank
nifty ... we can test it further". He also fixed the names: 4 Pillar Rules, SuperTrend Rules, Dharani Rules, Trend Rules.

## Decision
- Two rule ids, `fourPillar` and `superTrend`, both evaluated on every 5-minute candle for NIFTY and BANKNIFTY, both
  on the MegaBull account. Each is its own position slot per index (ADR 0005), so they never block each other; the
  existing guard still stops a rule buying the exact option another rule holds on the same account.
- The old `megabull` id stays as a slot so trades saved before this change still close normally.
- Display names everywhere use the owner's names; Dharani Rules and Trend Rules keep their accounts (ADR 0006).
- The backtest runs every strategy on both indices and adds Trend Rules as an approximation (docs/backtest.md).

## Consequences
- Up to four MegaBull positions at once (2 rules x 2 indices); the daily limits per account still apply.
- 4 Pillar on NIFTY and SuperTrend on BANKNIFTY are untested; results stay separated by the Index column.
