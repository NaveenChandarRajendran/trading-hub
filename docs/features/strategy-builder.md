# Strategy Builder (Live group, paper only)

Design multi-leg NIFTY / BANKNIFTY option positions on live chain prices: expiry payoff and a target-date (T+0) curve,
max profit / loss, breakevens, probability of profit, Greeks, Dhan basket margin, drafts, and "Analyze positions" for
what a strategy already holds.

## Decisions (28-Oct-2026)
- Split in three branches. **A. Strategy Builder** (this one, `feature/strategy-builder`): design, payoff, summary,
  Greeks, margin, drafts, Analyze positions. **B. Options paper engine**: a new `options` strategy kind with short
  legs, margin blocked from Dhan's basket margin, overnight carry, expiry settlement and one-basket all-or-nothing
  (own plan + ADR; the paper engine is buy-only today). **C. Strategy Lab**: weekly rules on top of B. The Builder's
  "Paper trade" switches on with B and "Save as weekly rule" with C.
- Branched from `naveen-dev` (main is behind and lacks logins / strategies / the per-strategy engine).
- Payoff chart: plain SVG (price on the x axis; Lightweight Charts has time on x). No new libraries.
- "Iron Condor A (95%) / B (90%)" templates wait for their written rules (see Open questions). The 95 % / 90 % weekly
  bands toggle uses the numbers given: +4.31 % / −3.73 % and ±3 %.

## Maths (frontend `src/apps/strategy-builder/logic/`, tested)
- Quantities are units = lots × lot size × multiplier; money in ₹.
- Expiry payoff: Σ side × (intrinsic(S) − entry price) × qty. Net premium = Σ sells − Σ buys (credit +).
- Breakevens: the payoff is straight between strikes, so each segment [0, K1], [K1, K2] … [Kn, ∞) is solved exactly.
- Max profit / loss at 0 and every strike; "unlimited" when the slope above the highest strike is not 0.
- Black–Scholes (European, no dividend), r = 6.5 % (configurable), T = calendar days to 15:30 IST on expiry ÷ 365;
  each leg's chain IV plus the IV-shift slider. Greeks: Δ, Γ, Θ (₹/day), vega (₹ per volatility point). A leg without
  IV is valued at intrinsic on the T+0 curve (the page flags it).
- POP: lognormal S_T with risk-neutral drift r and the ATM IV; sum of P(S_T in each profit stretch between breakevens).
- Check (Naveen's 3 Nov iron condor A from Dhan): S 21950 PE @19.20, S 23800 CE @4.40, B 21700 PE @8.85,
  B 24050 CE @2.85, 1 lot (65) → credit 11.90 (₹773.50), max loss ₹15,476.50, breakevens 21,938.10 / 23,811.90.

## Build steps (A)
1. Maths library + tests — done (`blackScholes.ts`, `payoff.ts`, `pop.ts`).
2. Legs table + templates + live prices — done. Page Live → Strategy Builder (`StrategyBuilderApp.tsx`,
   `LegsTable.tsx`, `useMarket.ts`): index + live spot, expiry, templates (Long / Short Straddle and Strangle, Bull Call,
   Bear Put, Iron Condor, Iron Butterfly; distances in `logic/templates.ts` `TEMPLATE_PCT`: strangle ±1 %, spreads 1 %,
   condor shorts ±1.5 % / wings ±2.5 %, butterfly wings ±1.5 %, snapped to listed strikes), up to 8 legs (tick, B/S,
   expiry, strike dropdown + −/+, CE/PE, lots, price = live bid/ask mid or typed with ↺, IV, duplicate / delete),
   multiplier, tabs 1–6 (this browser until drafts). Data: `/api/paper/chain` (strikes / IDs / lot size),
   `/api/option-chain` cache (IV, last prices; every 60 s), `/ws/paper` ticks (spot + legs). The strike dropdown
   (`scalper/StrikePicker.tsx`) now has its own stylesheet and is shared with Power Scalper.
3. Payoff chart + summary + Greeks.
4. Margin (`POST /v2/margincalculator/multi`, one live check after market close with Naveen's OK) + drafts
   (`th_builder_drafts`) + Analyze positions.

## Open questions
- Iron Condor A (95 %) / B (90 %): short-strike rule (% from spot for CE / PE), rounding direction, wing width, expiry.
  The 3 Nov IC (21950 / 23800) does not match +4.31 % / −3.73 % of 28-Oct spot: need the spot used or the written rule.
