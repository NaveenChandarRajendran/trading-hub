# ORB Algo (NIFTY, PAPER ONLY)

Naveen's spec (12-Nov-2026), from Groww's ORB backtest on NIFTY (Jan 2020 – Sep 2026, 1,668 sessions). Every number is in
`backend/orb_config.py` (DEFAULTS) and can be changed in the algo's Settings (each change logged with old → new, the
time and the user; new decisions use it at once, an open trade keeps its stop and lots). Code: `backend/orb_logic.py`
(rules), `backend/orb_service.py` (runner), `backend/orb_store.py` (records). Own paper strategy "ORB Algo" (kind algo,
naveen, ₹5,00,000) and account of the same name.

## Data
- NIFTY index **1-minute candles**, 09:15-aligned, from the live feed (Dhan's intraday history after a late start or a
  restart). Each candle is evaluated once, when it has closed.
- **Opening range (OR)** = the high and low of the candles from 09:15 over N minutes: 5 min (09:15–09:19), 30 min
  (09:15–09:44), 60 min (09:15–10:14). It locks with its last candle.
- **OR size %** = (OR high − OR low) / the day's open × 100. The day's open = the open of the first candle (09:15).

## The three setups
Independent of each other; each takes **at most one trade a day**, is tagged with its name, and has its own P&L and spot
points in the reports. Each can be switched off in Settings.

1. **60m Breakout** (`b60`), OR = 60 min. Only when the OR size is **more than 0.5 %** of the open.
   A 1-minute candle **closes above the OR high → long** (below the OR low → short). The signal candle must **start
   before 12:00** (the 11:59 candle is the last one). Stop: the other side of the OR.
2. **30m Retest** (`r30`), OR = 30 min. Only when the OR size is **at most 0.5 %**.
   The first 1-minute close beyond a side (above the high or below the low) is the first breakout. Then a close back
   inside the OR (high and low included). Then a close beyond the **same side** again → enter that way (above → long).
   The entry candle must start **at most 60 minutes** after the first breakout candle (10:20 → 11:20 is the last);
   later, the setup is done for the day. A close beyond the other side after coming back inside is not a retest (it is
   ignored). Stop: the other side of the OR.
3. **5m Reversal** (`v5`), OR = 5 min. No size filter.
   The first close beyond a side, then a close back inside, then a close beyond the **other side** → enter that way
   (broke above, came back, closed below the low → short). Stop: **the first side** (for that short: a close above the
   OR high). The signal candle must start before 12:00. A close beyond the first side again after coming back inside is
   ignored (the setup keeps waiting for the other side).

The candle that locks an OR is not a signal candle; the first one after it is.

## Stops and exit
- A stop triggers on a 1-minute **close** beyond the stop level (a wick beyond it does not). The option is sold at
  market right then.
- **No target.** Every open trade is sold at **15:25** (setting `squareOff`). This account's paper engine takes orders
  until, and squares off at, 15:25 instead of the usual 15:15 (ADR 0013); the 15:24 candle (closing at 15:25) is not
  evaluated, everything is sold then.

## Orders
- Long = **buy CE**, short = **buy PE**, **1 ITM** strike (ATM = the strike nearest spot at the signal close; CE one
  strike below it, PE one above), **nearest weekly expiry** (the next weekly on an expiry day), **1 lot** per setup.
- **Liquid strikes only** (the shared liquidity rule: traded today, live bid and ask). When 1 ITM isn't liquid there
  is no trade (logged with the reason); `strikeFallback` can add ATM / 2 ITM.
- Two setups may hold the same option at once; each sells its own lots.

## Guards
- **Day loss stop:** no new entries once the account's day P&L (realized + open − charges) reaches −2 % of ₹5,00,000.
- **Kill switch** (page header): stop new entries; or stop and exit everything.
- **Feed watchdog:** no NIFTY tick for 120 s → no new entries until ticks return.
- A signal that can't be taken (kill switch, stale feed, day loss, not liquid, the order not filled) ends that setup for
  the day; it is not taken on a later candle.
- **Restart / late start:** today's candles come from Dhan's history and run through the rules first (catch-up): the
  ORs and setups are right at once, but a signal from a candle that closed while the algo was not running is **not
  traded** ("missed"); a stop of an open trade that triggered meanwhile is executed at the current price. A candle is
  never evaluated twice; an open trade is read back from Postgres and checked against the paper account.

## Records
- Every decision in `orb_algo_events` (types: or, signal, skip, entry, exit, info, settings, feed, heartbeat, error),
  the state after every change in `orb_algo_state`, the 15:35 summary **per setup** in `orb_algo_daily_summary`
  (trades, wins, losses, **spot points**, gross P&L, charges, net P&L).
- Each trade records its entry and exit **NIFTY spot** (the signal / stop candle's close, or the spot at 15:25) and
  its points (long: exit − entry; short: entry − exit), to compare with the backtest's numbers.

## Decided by default (tell Naveen if any should change)
- "Before 12:00" means the signal candle **starts** before 12:00.
- "Within 60 minutes" is measured from the first breakout candle's start to the entry candle's start (≤ 60).
- A skipped signal ends the setup for the day (it does not wait for another close beyond the level).
- 1 ITM not liquid → no trade by default (no ATM fallback).
