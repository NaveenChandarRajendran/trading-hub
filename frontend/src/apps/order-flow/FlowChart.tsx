// Order flow page chart: index candles (pane 0), estimated delta per candle as bars (pane 1) and the cumulative delta
// line (pane 2). TradingView Lightweight Charts, colours from the design tokens.
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import type { Candle } from '../dashboard/logic/candles';
import { withAlpha } from '../dashboard/logic/levelLines';
import type { FlowRow } from './logic/api';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const IST = 'Asia/Kolkata';

export function FlowChart({ bars, flow, resetKey }: { bars: Candle[]; flow: FlowRow[]; resetKey: string }) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const deltaBars = useRef<ISeriesApi<'Histogram'> | null>(null);
  const cum = useRef<ISeriesApi<'Line'> | null>(null);
  const fitted = useRef('');

  const paint = () => {
    const border = token('--border');
    chart.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: token('--surface') }, textColor: token('--text-2'), attributionLogo: true, panes: { separatorColor: border } },
      grid: { vertLines: { color: withAlpha(border, 0.5) }, horzLines: { color: withAlpha(border, 0.5) } },
    });
    const up = token('--up');
    const down = token('--down');
    candles.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    cum.current?.applyOptions({ color: token('--accent') });
  };

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 2 },
      localization: {
        locale: 'en-IN', priceFormatter: (p: number) => inr(0)(p),
        timeFormatter: (t: number) => new Date(t * 1000).toLocaleString('en-IN', { timeZone: IST, hour12: false, hour: '2-digit', minute: '2-digit' }),
      },
      crosshair: { mode: 0 },
    });
    chart.current = c;
    candles.current = c.addSeries(CandlestickSeries, { priceFormat: { type: 'price', precision: 2, minMove: 0.05 } }, 0);
    deltaBars.current = c.addSeries(HistogramSeries, { priceLineVisible: false, title: 'Delta per candle (est.)' }, 1);
    cum.current = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: 'Cumulative delta (est.)' }, 2);
    c.panes()[1]?.setHeight(130);
    c.panes()[2]?.setHeight(130);
    paint();
    return () => {
      c.remove();
      chart.current = candles.current = deltaBars.current = cum.current = null;
    };
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      paint();
      deltaBars.current?.setData(flow.map((f) => ({ time: f.time as UTCTimestamp, value: f.delta, color: withAlpha(token(f.delta >= 0 ? '--up' : '--down'), 0.8) })));
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  useEffect(() => {
    candles.current?.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    const up = token('--up');
    const down = token('--down');
    deltaBars.current?.setData(flow.map((f) => ({ time: f.time as UTCTimestamp, value: f.delta, color: withAlpha(f.delta >= 0 ? up : down, 0.8) })));
    cum.current?.setData(flow.map((f) => ({ time: f.time as UTCTimestamp, value: f.cumulative })));
    if (bars.length && fitted.current !== resetKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = resetKey;
    }
  }, [bars, flow, resetKey]);

  return <div className="of-chart" ref={box} />;
}
