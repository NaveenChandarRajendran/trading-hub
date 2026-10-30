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
3. Payoff chart + summary + Greeks — done. `PayoffChart.tsx` (plain SVG; `logic/chart.ts`): expiry payoff with
   profit / loss shading (--up-soft / --down-soft), dashed target-date curve, spot and breakeven lines with % labels,
   hover readout, wheel zoom / drag pan / double-click reset (±10 % of spot), weekly 95 % (−3.73 / +4.31 %) and 90 %
   (±3 %) bands toggle. Sliders: target date (now → nearest expiry, hourly) and IV shift (±10 points).
   `SummaryPanel.tsx` (`logic/summary.ts`): max profit / loss, reward : risk, POP (ATM IV of the nearest expiry; method
   in the tooltip), net premium, charges for entry + exit (rates from `/api/paper/chain` `chargeRates`, the engine's
   own), Greeks (Δ ₹/pt, Γ, Θ ₹/day, vega ₹/pt) and a per-leg table. Margin is a "step 4" placeholder.
   Option chain for picking legs (Naveen, 28-Oct: "option chain only to select the legs"; the "+ Add leg" button is
   gone): `OptionChainPanel.tsx`, CE | strike | PE with OI, IV, LTP and B / S buttons; a click adds a 1-lot leg, the
   same click again adds a lot (`logic/legs.ts` `addFromChain`, max 8 legs); held lots shown on the strike and the used
   B / S button filled; ATM row and ITM cells marked; its own expiry (follows the toolbar's) and ±10 / ±20 / All strikes;
   live ticks for ±20 strikes around ATM at most. Templates still fill the legs too.
4. Margin + drafts + Analyze positions — done.
   - Margin: `POST /api/builder/margin` -> `DhanClient.margin_multi` -> Dhan `/v2/margincalculator/multi`, cached 30 s
     per basket, asked 1 s after the design stops changing; failures show "Margin unavailable" (the design still works).
     Live check 28-Oct-2026 (after close, a calculator, nothing ordered): the body needs `dhanClientId` and `scripList`
     (as in Dhan's cURL example, not its field table); the answer is camelCase (`totalMargin`, `spanMargin`,
     `exposure`, `hedgeBenefit`). Dhan reported hedgeBenefit 0 for a hedged NIFTY condor (total ₹76,406.98 for 1 lot):
     the page shows Dhan's figures as they come. `clientId` in the answer is never passed on.
   - Drafts: `th_builder_drafts` (Postgres + JSON), `builder.py` rules, `/api/builder/drafts` CRUD, private per user.
     Page: Save draft (asks a name) / Save (overwrite) / Save as new, Drafts menu (open in a tab, rename, delete), a ●
     on tabs with unsaved changes. Tabs still live in this browser; a saved draft opens anywhere.
   - Analyze positions: `GET /api/builder/positions?strategy=` (your own manual strategies) -> a tab with the open
     positions at their average buy, prices locked (one index per tab; others counted). The algo is on its own page.

## SENSEX (29-Oct-2026, branch `feature/sensex`)
Naveen: SENSEX in the Strategy Builder only (not Paper Trading / Power Scalper / Trade Window).
- SENSEX options trade on **BSE** (Dhan segment `BSE_FNO`), weekly expiry Thursday, 1 lot = 20 (from Dhan's
  instrument list); index `IDX_I` 51 for the spot, chain, candles and the 15:30 settlement spot.
- `instruments.py` loads BSE SENSEX `OPTIDX` rows with `"segment": "BSE_FNO"` (NSE rows `NSE_FNO`; cache version 2, an
  older cache is downloaded again). Options are keyed by security ID alone, so a BSE ID that is also an NSE option is
  left out and logged (none on 29-Oct: 3,208 SENSEX IDs, no overlap).
- `/api/paper/chain` returns `segment` and that exchange's `chargeRates`; the page subscribes `BSE_FNO` keys
  (Full mode, depth). Dhan's margin calculator gets each leg's `exchangeSegment`.
- Charges: as NSE except the exchange transaction charge, BSE 0.0325 % of premium (`paper_charges.BSE_TXN_RATE`;
  re-check against a Dhan contract note). Holidays: the NSE list.
- The manual paper engine (Paper Trading, Power Scalper, Trade Window) refuses SENSEX IDs.
- Checked live on 29-Oct after hours: expiries, the chain via index 51, instruments `BSE_FNO` lot 20, margin answered.

## Option chain drawer and toggle picks (30-Oct-2026)
Naveen: the option chain opens in a drawer from the left ("+ Add legs" on the Legs card; × / Esc / Done close it), the
payoff stays in view. B / S on the chain toggles: the same button again removes that leg; the other button on a held
strike flips its side (lots kept); lots are changed in the legs table (`addFromChain`, `ChainDrawer.tsx`).

## Untraded strikes and "No market" (29-Oct-2026, branch `feature/sensex-support`)
Bug: SENSEX 5 Nov 77,200 CE showed LTP 548.50 (IV 37.6), so an iron condor came out as a ₹9,322 debit. Dhan sends a
strike with no OI and no trade today with `last_price` = `previous_close_price` = the exchange's base price (checked
live 29-Oct: 77,100 / 77,200 CE `oi 0, volume 0, average_price 0`), and IV worked out from it.
- `shared/dhan/liquidity.ts`: `untraded` (OI 0 and volume 0), `illiquidReason` (thresholds; a live bid / ask only
  while the market is open, because after the close Dhan sends bid / ask 0 for every strike), `outwardStrike`.
- Every chain screen: no base price. Builder chain hides untraded strikes ("Show untraded strikes (n)" lists them
  greyed, "No trades", no B / S). Paper Trading chain and the Scalper strike lists show "No trades" / "–". The OI pages
  (chainAdapter) get LTP / IV 0 for them. ATM IV skips untraded strikes.
- Builder legs (`legPrice`): untraded = no market; market open without bid and ask = no market; market closed = last
  traded price. A ticked leg with no market shows "No market"; payoff and numbers are withheld and Paper trade is off,
  with the reason, unless a price is typed (then Paper trade asks first; the engine still fills only real bid / ask).
- Templates move an untraded / illiquid strike outward (calls up, puts down, sold and bought legs), wings beyond the
  strikes used, and say so ("77,200 CE untraded → using 77,300 CE"). Thresholds: `TEMPLATE_LIQUIDITY` in
  `strategy-builder/config/settings.ts` (OI ≥ 1, volume today ≥ 1, live bid / ask when open). Strategy Lab (not built
  yet) is to use the same `outwardStrike`.
- Tests: `liquidity.test.ts`, `noMarket.test.ts` (the SENSEX case, NIFTY unchanged), Paper Trading chain + adapter
  cases, `test_options_service.py::test_an_untraded_strike_never_fills`.

## LTP = the last trade only (30-Oct-2026, branch `feature/sensex-support`)
Bug: SENSEX 5 Nov 76,900 CE showed 120.00; Dhan's app and Sensibull 4.75. Raw data (29-Oct, after the close):
| field | 76,900 CE | 77,200 CE | 77,000 CE (traded) |
|---|---|---|---|
| option chain `last_price` | **120** | 548.5 | 18.3 |
| option chain `previous_close_price` | 120 | 548.5 | 14.15 |
| quote API `last_price` (`/marketfeed/quote`, the feed's data) | **4.75** | 0 | 18.3 |
| quote `last_trade_time` | 29/10/2026 00:00:00 | – | 29/10/2026 15:39:59 |
| volume / OI | 0 / 80 | 0 / 0 | 757,700 / 237,540 |
The wrong field: the **option chain's `last_price`**, which for a leg with no trade today is the previous close. The
feed sent nothing after hours (no packet to log); the quote API carries the same exchange data.
- `backend/last_trades.py`: GET /api/option-chain gives every leg `traded_today`; a leg with no trade today takes
  `last_price` from Dhan's quote API (one call per fresh chain, ≤ 1000 legs; 164 for SENSEX 5 Nov), keeps Dhan's value
  in `chain_last_price`, adds `last_trade_time`; a failed quote call gives 0 + `last_price_unknown`. The cached chain is
  unchanged, so the Trending OI tracker (calc.py's LTP sums, checked against OI Pulse) records what Dhan sent.
- Screens: "no trades today" (volume 0, OI > 0) shows the last traded price greyed with "No trades today · last traded
  4.75 (an earlier session)"; no change %, no IV. Builder: no market unless a live bid / ask; templates move outward
  ("76,900 CE no trades today → using 77,000 CE"). Set `TEMPLATE_LIQUIDITY.minVolume` to 0 to allow such strikes.

## Open questions
- Iron Condor A (95 %) / B (90 %): short-strike rule (% from spot for CE / PE), rounding direction, wing width, expiry.
  The 3 Nov IC (21950 / 23800) does not match +4.31 % / −3.73 % of 28-Oct spot: need the spot used or the written rule.
