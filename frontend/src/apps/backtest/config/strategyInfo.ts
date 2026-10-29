// What each strategy uses, in short (owner 25-Oct-2026: shown on the Backtest page when ONE strategy is ticked, so
// anyone can see at a glance what was tested). Source of truth: docs/strategies/*.md; keep this in step with them.
import type { StrategyKey } from '../logic/backtest';

export interface StrategyInfo {
  summary: string;
  chart: string;
  indicators: string[];
  checklist: string[]; // call side; puts mirror it unless the line says otherwise
  trade: string[];
  backtest: string; // how the backtest differs from live
  doc: string;
}

export const STRATEGY_INFO: Record<StrategyKey, StrategyInfo> = {
  '4 Pillar Rules': {
    summary: 'Breakout of a key level, confirmed by the next candle, with all four pillars green. MegaBull account, Grade A only.',
    chart: '5-minute candles · Nifty and Bank Nifty · ATM option, nearest expiry',
    indicators: ['RSI (14)', 'EMA 20', 'VWAP', 'Pivot, previous day high / low', 'OI support / resistance (R1, S1)', 'India VIX', 'PCR', 'Cumulative delta (order flow)'],
    checklist: [
      'Trigger: a candle closes above a level (pivot, previous high / low, OI R1 / S1); not before 09:30',
      'Confirmation: the next candle also closes above that level',
      'Pillar 1: close above EMA 20 and VWAP, RSI 45 or more (put: below both, RSI 45 or less)',
      'Pillar 2: cumulative delta agrees (not checked yet, does not block)',
      'Pillar 3: India VIX below 14',
      'Pillar 4: PCR 0.9 or more for a call, below 0.9 for a put',
      'Room to the next OI wall: Bank Nifty 200 pts, Nifty 50 pts',
    ],
    trade: ['Buy at the next candle open', 'Stop −10 %, target +20 %', 'No entries after 15:00, exit by 15:15'],
    backtest: 'Past data has no PCR, OI walls or OI R1 / S1, so those are left out; VWAP uses the index average price.',
    doc: 'docs/strategies/megabull.md',
  },
  'SuperTrend Rules': {
    summary: 'Our own strict SuperTrend setup from the webinar notes. MegaBull account, Grade A only.',
    chart: '5-minute candles · Nifty and Bank Nifty · ATM option, nearest expiry',
    indicators: ['SuperTrend (10, 2)', 'RSI (14)', 'Bollinger Bands (20, 2)', 'Pivots (Traditional)', 'OI support / resistance', 'Cumulative delta (order flow)'],
    checklist: [
      'Trigger: a candle closes above a level, or SuperTrend flips green; not before 09:30',
      'Confirmation: the next candle also closes above it',
      'SuperTrend green, close above the line',
      'RSI above 55 (put: below 45; 45 to 55 = no trade)',
      'Candle high touches or breaks the upper Bollinger band (put: the lower band)',
      'Close above the pivot, next pivot level at least 50 pts away',
      'Room to the next OI wall; delta checks not checked yet (do not block)',
    ],
    trade: ['Buy at the next candle open', 'Stop −10 %, target +20 %', 'No entries after 15:00, exit by 15:15'],
    backtest: 'Past data has no OI walls or OI R1 / S1, so those are left out.',
    doc: 'docs/strategies/megabull.md',
  },
  'Dharani Rules': {
    summary: "The teacher's tuned Quantman setups, copied as taught. Shown as Power Breakout (was Dharani Rules). App's own ₹1 lakh account.",
    chart: '3-minute candles · Nifty and Bank Nifty · call on the index, put on the futures',
    indicators: ['SuperTrend (10, 2)', 'RSI (14) and RSI (20)', 'Bollinger (15, 3) and (20, 2)', 'Williams %R (14)', 'EMA 200', 'CCI (20)', 'Pivots and CPR'],
    checklist: [
      'Call, all 5: close above SuperTrend · RSI (14) above 70 · close above R1 · close above upper Bollinger (15, 3) · Williams %R above −30',
      'Put, all 8: close below SuperTrend · below EMA 200 · RSI (20) below 30 · CCI (20) below −200 · Williams %R below −85 · close below CPR S1 · CPR narrow (under 0.2 %) · close below lower Bollinger (20, 2)',
      'Signal candles from 09:18 to 15:00',
    ],
    trade: ['Option premium nearest ₹250 (Nifty) / ₹500 (Bank Nifty)', 'Exit when a candle closes back through SuperTrend', 'Safety stop −10 %, no fixed target, exit by 15:15'],
    backtest: 'Past futures minute data does not exist, so the put side reads the index.',
    doc: 'docs/strategies/dharani-v2.md',
  },
  'Trend Rules': {
    summary: 'Trend-following with Trending OI. Grade A or B. App’s own ₹1 lakh Trend account.',
    chart: '5-minute candles · Nifty and Bank Nifty · ATM option, nearest expiry',
    indicators: ['SuperTrend (10, 2)', 'Trending OI (strength %)', 'Dhan OI & OI Change view', 'Pivot', 'VWAP, EMA 20', 'Bollinger (20, 2)', 'RSI (14)', 'Cumulative delta (order flow)'],
    checklist: [
      'Must: SuperTrend green, close above the line',
      'Must: Trending OI strength +50 % or more on the last 3 rows, and the Dhan OI view says Bullish',
      'Must: cumulative delta agrees (not checked yet, does not block)',
      'Close above the pivot · above VWAP and EMA 20',
      'Bollinger bands widening · close in the outer half of the band',
      'RSI 55 to 70 (put: 30 to 45)',
      'Grade A = all green; Grade B = one of the other checks off',
    ],
    trade: ['Buy at the next candle open', 'Stop −15 %, target +20 %', 'Exit early when Trending OI fades below 50 % or a candle closes beyond SuperTrend', 'No entries after 14:30, exit by 15:15'],
    backtest: 'Approximate: Trending OI rebuilt from past option OI of ATM ± 10, counted from 09:15 (live: from the previous day close).',
    doc: 'docs/strategies/trading-hub-trend.md',
  },
};
