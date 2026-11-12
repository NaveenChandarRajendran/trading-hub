# ADR 0011: A second paper algo (Trending OI Algo) with its own tables

Date: 12-Nov-2026. Status: accepted.

## Context
Naveen asked for a second algo on NIFTY (rules: docs/strategies/trending-oi-algo.md), paper only, with its own
strategy and capital, reusing the OI breakout algo's infrastructure (feed, paper engine, decision log, reports).
The OI breakout algo's tables (`algo_events`, `algo_state`, `algo_levels`, `algo_candles`, `algo_daily_summary`) are keyed
by index (and variant), and its status, reports and daily summary read every row of a day. Both algos trade NIFTY.

## Decision
- The Trending OI Algo has its own tables `toi_algo_events / _state / _candles / _daily_summary / _settings`
  (toi_algo_store.py). The OI breakout algo's tables, keys and readers are not changed.
- It shares the code that is already generic: `algo_service.AlgoBroker` (now taking an account name and capital, the
  defaults unchanged) on its own paper account "Trending OI Algo" (strategy kind algo, ₹5,00,000), the paper feed, the
  Trending OI rows, the chain cache and the OI S/R ranking (it reads the breakout algo's locked NIFTY levels when they
  exist). Its strategy card is fed by its own broker (main.strategy_live).
- VWAP is the NIFTY future's session VWAP, put on the index scale by subtracting the current basis (future − index at
  the candle's close), because the algo's levels and stop are index prices.

## Consequences
- The breakout algo's whole test suite passes unchanged; the two algos never mix records.
- Two sets of algo tables to look at; a later "algo" column could merge them if more algos come.
