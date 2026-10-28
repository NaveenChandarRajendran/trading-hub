// One Power Scalper chart (Lightweight Charts): candles + a soft volume strip, colours from the design tokens. The
// three charts share one time grid and a ChartSync, so scroll, zoom and crosshair move together. Bars arrive already
// aligned (blank bars where the instrument did not trade). An option chart can carry an open position's overlay
// (entry line, draggable TP / SL, PositionOverlay.tsx) and the user's drawings (DrawingLayer.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useTheme } from '../../shared/theme';
import { candleColors, chartOptions, compactVolume, ohlc, pricePriceFormat, themeOptions, volumePoint } from './chartTheme';
import { isCandle, type Bar } from './logic/series';
import type { ChartSync, SyncableChart } from './logic/sync';
import { DrawingLayer } from './DrawingLayer';
import type { Drawing, Tool } from './logic/drawings';
import { PositionOverlay, type ChartPosition } from './PositionOverlay';

const INITIAL_BARS = 90; // bars in view when a chart first loads (scroll back for more)
const VOLUME_PANE_PX = 56;

export interface PositionProps {
  pos: ChartPosition;
  enabled: boolean;
  onExit: () => void;
  onProtect: (body: { target?: number | null; stop?: number | null }) => Promise<void>;
  onError: (message: string) => void;
}

export interface DrawingProps {
  items: Drawing[];
  onChange: (items: Drawing[]) => void;
  tool: Tool;
  onToolDone: () => void;
  step: number; // seconds a bar
  keys?: boolean; // Delete / Esc act on this chart (false while the maximised copy is open)
}

export function ScalperChart({ id, bars, sync, resetKey, position, drawing, big = false }: {
  id: string; // "index" | "ce" | "pe": the sync member id
  bars: Bar[]; // aligned to the shared grid
  sync: ChartSync;
  resetKey: string; // instrument + timeframe: re-fit the view when it changes
  position?: PositionProps | null; // an open position on this chart's instrument
  drawing?: DrawingProps; // trendlines, rectangles, horizontal lines
  big?: boolean; // the maximised view: twice as many bars at first
}) {
  const initialBars = big ? 2 * INITIAL_BARS : INITIAL_BARS;
  const times = useMemo(() => bars.map((b) => b.time as number), [bars]);
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const closes = useRef(new Map<number, number>());
  const fitted = useRef('');
  const fittedLen = useRef(0);
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState(0); // re-reads overlay pixel positions after the view moves
  const pending = useRef(0);
  const bump = () => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      setFrame((f) => f + 1);
    });
  };

  useEffect(() => {
    const c = createChart(box.current!, chartOptions());
    const s = c.addSeries(CandlestickSeries, { ...candleColors(), priceFormat: pricePriceFormat });
    // volume in its own small pane, so the price scale never stretches below 0 to make room for it
    const v = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'custom', formatter: compactVolume, minMove: 1 }, priceLineVisible: false, lastValueVisible: false,
    }, 1);
    c.panes()[1]?.setHeight(VOLUME_PANE_PX);
    s.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } });
    chart.current = c;
    candles.current = s;
    vol.current = v;
    const leave = sync.add(id, c as unknown as SyncableChart, s, (t) => closes.current.get(t));
    c.timeScale().subscribeVisibleLogicalRangeChange(bump);
    c.subscribeCrosshairMove(bump);
    const ro = new ResizeObserver(bump);
    ro.observe(box.current!);
    setReady(true);
    return () => {
      ro.disconnect();
      c.timeScale().unsubscribeVisibleLogicalRangeChange(bump);
      c.unsubscribeCrosshairMove(bump);
      leave();
      c.remove();
      chart.current = candles.current = vol.current = null;
      fitted.current = '';
      setReady(false);
    };
  }, [id, sync]); // eslint-disable-line react-hooks/exhaustive-deps

  // theme: recolour in place (a frame later, once data-theme has switched)
  useEffect(() => {
    const f = requestAnimationFrame(() => {
      chart.current?.applyOptions(themeOptions());
      candles.current?.applyOptions(candleColors());
      vol.current?.setData(bars.map(volumePoint));
      bump();
    });
    return () => cancelAnimationFrame(f);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!candles.current) return;
    candles.current.setData(bars.map(ohlc));
    vol.current?.setData(bars.map(volumePoint));
    closes.current = new Map(bars.filter(isCandle).map((b) => [b.time, b.close]));
    // fit on a new instrument / timeframe, and once more when history arrives after a few live bars were fitted
    if (bars.length && (fitted.current !== resetKey || (fittedLen.current < initialBars && bars.length >= 2 * fittedLen.current + 10))) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - initialBars), to: bars.length + 2 });
      fitted.current = resetKey;
      fittedLen.current = bars.length;
    }
    bump(); // the price scale may have moved
  }, [bars, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sc-chart-wrap">
      <div className="sc-chart" ref={box} />
      {!bars.length && <div className="sc-chart-empty">Loading candles…</div>}
      {ready && drawing && chart.current && candles.current && (
        <DrawingLayer chart={chart.current} series={candles.current} frame={frame} times={times} {...drawing} />
      )}
      {ready && position && chart.current && candles.current && (
        <PositionOverlay chart={chart.current} series={candles.current} frame={frame} {...position} />
      )}
    </div>
  );
}
