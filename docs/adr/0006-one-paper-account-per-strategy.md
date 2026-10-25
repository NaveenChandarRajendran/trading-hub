# ADR 0006: One app paper account per auto strategy

Date: 25-Oct-2026. Status: accepted (owner).

## Context
Auto rules shared accounts: the Trading Hub rule traded in the owner's own Paper Trading account, and Dharani v2 was
added to MegaBull next to the MegaBull rules. Mixed money made it hard to see which strategy earns, and two rules on one
MegaBull account could collide on the same option.

## Decision
- MegaBull keeps the strict rules only: 4 Pillar (Bank Nifty) and SuperTrend Nifty (formerly "Dharani v1").
- Each other auto strategy gets its own Rs 1,00,000 paper account inside the app: `strategy_books.StrategyBook`
  (data/books/<name>/paper.json), reusing `paper_engine.PaperEngine` (same fills, charges, 15:15 square-off) and fed
  the same live ticks by `PaperService` (on_tick / on_time, feed subscriptions for its positions and stops).
  Accounts: `tradingHub` → book "trend", `dharani` → book "dharani".
- The owner's Paper Trading screen stays the main account (key "manual"): hand trades and the "stop + target" bracket.
- Positions stay per rule ("slot", ADR 0005); limits per account.

## Consequences
The brother's PaperService gained a `books` list and two loops over it; nothing else in his paper code changed. Old
auto trades in the main account (E1-E3) stay there. New strategies need one line in main.py and a config section.
