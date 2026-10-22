# ADR 0005: The OI breakout algo runs in the backend, on its own paper account

Date: 2026-10-23 · Status: accepted

## Context
The algo must run unattended all day and trade only on paper. Its filters are the live apps' verdicts, but three of
them (OI & OI Change, Index Components, RSI) exist only as TypeScript in the frontend (ADR 0003 kept formulas there so
the Dashboard can never disagree with the apps). A browser tab cannot be the engine of an unattended algo.

## Decision
- **Backend runner** (`algo_service.py`) with a pure rule module (`algo_logic.py`) and every number in `algo_config.py`.
- **Python ports of the three TypeScript verdicts** (`algo_filters.py`), checked against values the TypeScript
  functions produced on the same fixtures (`fixtures/algo_golden.json`, `test_algo_filters.py`). Trending OI and the
  S/R ranking were already Python. Changing one side means changing both and regenerating the golden file.
- **Own paper account**: `pt_accounts.name = 'Algo'` (the manual account is the unnamed one); orders carry
  `source = 'algo'` and the setup name. The algo drives its own `PaperEngine` with the same fill rules as the page.
- **One Dhan feed**: the paper service fans packets out to listeners and keeps extra subscriptions per owner, so the
  algo adds the indices and ATM ± 1 options without a second connection.
- **No real-order path**: the algo modules may import only an allow-list of modules, nothing order-related from
  `dhan_client`, and `dhan_client` has no order endpoint; a test fails otherwise.
- **Decision log first**: every decision is stored (`algo_events`) and written to a daily log file, and each trade keeps
  its reasons, so a day can be reviewed against the chart and the rules refined.

## Consequences
- The filter formulas now live in two languages; the golden test catches drift but someone must regenerate it.
- Paper P&L views show the manual account only until an account filter is added (deferred).
- Levels are locked at 09:30 from the raw ranking, so they can differ from the recorded S/R history (ADR 0004).
