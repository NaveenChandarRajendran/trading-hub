# Excel daily checklist (after market close)

Owner, 26-Oct-2026: `H:\Personal\Trading Journey\Trading Journey Tracker.xlsx` is the record ("our Bible") for the
15-Nov-2026 review, so no day may be missing on any sheet. The app never writes to it; Claude updates it by hand
(openpyxl, styles kept) after close, with the owner's Excel closed, and checks every line below before saying "done".

Each trading day D (skip weekends and NSE holidays, `holidays.py`):

1. **Trade sheets**: one row per trade on D, or one row with `N/A` when there was no trade (Holiday rows say `Holiday`).
   - `Option Buy - 4 Pillar Rules` (date in B, invested W, net AJ)
   - `Option Buy - SuperTrend Rules` (date in B, invested V, net AI)
   - `Option Buy - Power Breakout` (was `Option Buy - Dharani Rules`, renamed 29-Oct-2026; date in B, invested V, net AI)
   - `Option Buying - Trading Hub` (the app's paper trades: Trend while it traded, and the owner's manual Buy / Sell trades; date in B)
   - `Option Buy - Rebound Call` (BankNifty Rebound Call book from 28-Oct-2026; Power Breakout's columns; date in B)
   - `Option Buy - Box Pullback 15-5` (from 2-Nov-2026; same columns; both indices). The 5-1 tab was removed: owner dropped 5/1 on 30-Oct-2026.
   - `Option Selling - Megabull` (selling, owner's own entries, expiry days only; date in B)
   - `Option Sell - Selling Book` (the app's Rs 3 L paper selling book from its first live day; one row per leg
     closed on D, open strangle legs listed with status Open; columns: Date, Rule, Index, Option, Expiry, Qty, Sell
     time, Sell price, Stop, Buy-back time, Buy-back price, Exit reason, Gross, Charges, Net, Cycle / Notes). From
     3-Nov-2026 the expiry straddles 9:20, 9:40, 11:26 and 12:24 are rows here too (Rule column).
   - `Momentum 20` (from the first holdings, 2-Nov-2026): daily value, cash and holdings of both Rs 5 L books; trades monthly.
2. **`Megabull Option Buy - P&L` calendar (hand-filled, NOT automatic)**: month in D6, columns D..J = Sun..Sat,
   first week in row 8. The cell for D gets the formula
   `=(sum of AJ / AI net of D's 4 Pillar + SuperTrend rows)/(sum of their W / V invested)`, number format `0.00%`,
   bullish green / bearish red fill like the cells around it. No trade = `-`. Holidays and future days stay blank.
   This is the cell that was missed on 26-Oct-2026.
3. **`Megabull Option Sell - P&L` calendar (hand-filled)**: same layout; `=AM/AA` of D's `Option Selling - Megabull` row.
4. **`Consolidated Option Buy - P&L`** and **`TradingHub Option Buy - P&L`**: formulas only. Check that D is in the
   Consolidated date list (J5:J70; add the next month's dates before it starts) and that the calendars show D after
   a recalculation (LibreOffice headless convert on a copy). Keep `fullCalcOnLoad` on so Excel recalculates on open.
5. **`Rules and Data Log`**: one row for any rule change, backtest result or watch-list finding of the day.
6. **`Shadow Log`**: skipped / blocked setups worth keeping (from `shadow_skips.csv`).
7. **Check before saying done**: re-open the saved copy, list D on every sheet above, compare the MegaBull calendar
   value with the trade rows (net / invested), write it back with the mtime guard, and list the folder to confirm the
   new size and time. Tell the owner the day's numbers per sheet.

New month: add the month's calendar block on both MegaBull calendars and extend the Consolidated date list.
