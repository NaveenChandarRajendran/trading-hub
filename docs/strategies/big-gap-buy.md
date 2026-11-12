# Big Gap Buy (Bank Nifty) — paper, from 13 Nov 2026

Owner OK'd 12 Nov 2026. Code: `backend/sig_gap.py` (rule id `gapBuy`), account/book `gap` (₹50,000, the Option Buy spare
money), settings `backend/autopaper.json` → `gapBuy`. PAPER ONLY.

Source: Shiva (OI Pulse / One Click) video, tested 28 Oct 2026 (project files `research/shiva-gap/`, 13,440 versions).
Bank Nifty with a 0.6 % gap passed; Nifty did not.

## Rule
- Bank Nifty only, 1-minute index candles, checked once at 09:16 (late start: up to 09:18, else no trade).
- **Call:** today's open is 0.6 % or more above yesterday's close **and** the 09:15 candle closes above yesterday's high.
- **Put:** today's open is 0.6 % or more below yesterday's close **and** the 09:15 candle closes below yesterday's low.
- Buy 1 lot of the ATM option at 09:16.
- Exit: premium stop −20 %, target +80 %, or 60 minutes after entry, else the 15:14 time exit. One trade a day.

## Backtest (1 lot, Dhan costs + 0.5 % slippage)
Nov 2021–Dec 2024 +₹49.1k (123 trades), Jan 2025–Oct 2026 +₹59.2k (60 trades, 57 % winners). Every year positive
(2021 +9.5k, 2022 +17.9k, 2023 +18.9k, 2024 +2.8k, 2025 +36.1k, 2026 +23.1k). Worst drop ₹20.8k. About 3 trades a month.
