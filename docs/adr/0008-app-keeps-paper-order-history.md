# 0008 · The app keeps its own paper order and trade history

Date: 25-Oct-2026. Status: accepted (owner).

## Context
MegaBull's screens show only today's orders (monthly P&L report aside). The owner wants a broker-style order book for
every past day and one consolidated view of all strategies inside the app, replacing the Excel tracker over time.

## Decision
- `backend/journal.py` records every step the auto trader sends (entry, stop placed, exit) for all auto strategies,
  MegaBull included, one JSON file per day under data/journal. It only records: a failure to write never stops trading.
- Manual paper trades are not copied: they are read from the paper store, which already keeps every day.
- History before the journal (1-23 Oct 2026) is imported once from the Excel tracker into data/journal/imported.json.
  The program never writes the Excel; Claude keeps updating the Excel after market close until the 15 Nov review.
- The old Paper Trading screen becomes the Option Chain page (chain with IV and Greeks + manual orders); the new Paper
  Trading page is the journal.

## Consequences
- MegaBull order history exists only for orders the app sent (from 26 Oct 2026).
- Imported days show a buy and a sell per trade, not the stop orders of those days.
