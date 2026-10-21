# ADR 0002: One shared, cached Dhan option chain for every live page

Date: 2026-10-21 · Status: accepted

## Context
Three new live apps (OI & OI Change, Sensibull OI Change, OI Support & Resistance) need the full option chain from
Dhan, and the Trending OI tracker already fetches it every minute. Dhan allows about one `/optionchain` call every
3 s. If each page called Dhan on its own, opening three pages would triple the calls and they would queue behind the
3.1 s limiter.

## Decision
- `backend/chain_cache.py` holds one chain per (symbol, expiry). `GET /api/option-chain` serves from it: memory if
  younger than 10 s (market open) or 5 min (closed), otherwise one fetch. Concurrent requests for the same key wait
  for that one fetch (per-key lock). `DhanClient` still enforces the 3.1 s gap underneath.
- A failed refresh serves the last good chain with `meta.stale` / `lastError`. Failures are never cached.
- The tracker fetches through the same cache with `max_age=0, allow_stale=False`: it always gets a fresh chain and
  never records an old one, so Trending OI is unchanged, and each of its minute fetches also refreshes the live pages.
- The endpoint passes Dhan's leg fields through unchanged (units). The frontend adapter
  (`src/shared/dhan/chainAdapter.ts`) converts them into the paste apps' models, so their formulas are reused as is.

## Consequences
- At most one Dhan chain call per key per 10 s from the live pages, however many are open.
- Live data can be up to 10 s old during the session (`meta.ageSeconds` shows it).
- The cache is in memory only; a backend restart starts empty.
