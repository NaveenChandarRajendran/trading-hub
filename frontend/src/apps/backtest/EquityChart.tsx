// Profit curve of the selected strategies over the backtest years. One strategy (or the combined total): a baseline
// area, green with a thick green line above ₹0 and red below (owner 25-Oct-2026). Several: one line each in its series
// colour plus the combined total as the green / red area. DrawdownChart: the fall from the highest point so far.
// TradingView Lightweight Charts; colours from the design tokens.
import { useEffect, useRef } from 'react';
import {
  AreaSeries, BaselineSeries, ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp,
} from 'lightweight-charts';
import { wheelOnClick } from '../../shared/chartWheel';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import { withAlpha } from '../dashboard/logic/levelLines';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface Line {
  id: string;
  label: string;
  colorToken: string; // e.g. '--series-1'
  points: { time: number; value: number }[];
  bold?: boolean; // the combined total
}

type Pt = { time: number; value: number };

function useChart(box: React.RefObject<HTMLDivElement | null>) {
  const chart = useRef<IChartApi | null>(null);
  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      timeScale: { rightOffset: 2, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      localization: { locale: 'en-IN', priceFormatter: (p: number) => `₹${inr(0)(p)}` },
      crosshair: { mode: 0 },
    });
    chart.current = c;
    const unwheel = wheelOnClick(c, box.current!);
    return () => {
      unwheel();
      c.remove();
      chart.current = null;
    };
  }, [box]);
  return chart;
}

function theme(c: IChartApi) {
  const border = token('--border');
  c.applyOptions({
    layout: { background: { type: ColorType.Solid, color: token('--surface') }, textColor: token('--text-2'), attributionLogo: true },
    grid: { vertLines: { color: withAlpha(border, 0.5) }, horzLines: { color: withAlpha(border, 0.5) } },
  });
}

const data = (pts: Pt[]) => pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));

export function EquityChart({ lines }: { lines: Line[] }) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useChart(box);
  const series = useRef<ISeriesApi<SeriesType>[]>([]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    theme(c);
    for (const s of series.current) c.removeSeries(s);
    const up = token('--up');
    const down = token('--down');
    const area = lines.length === 1 ? lines[0] : lines.find((l) => l.bold);
    series.current = lines.map((l) => {
      const s = l === area
        ? c.addSeries(BaselineSeries, {
          baseValue: { type: 'price', price: 0 }, lineWidth: 3, priceLineVisible: false, lastValueVisible: true, title: l.label,
          topLineColor: up, topFillColor1: withAlpha(up, 0.28), topFillColor2: withAlpha(up, 0.04),
          bottomLineColor: down, bottomFillColor1: withAlpha(down, 0.04), bottomFillColor2: withAlpha(down, 0.28),
        })
        : c.addSeries(LineSeries, { color: token(l.colorToken), lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: l.label });
      s.setData(data(l.points));
      return s as ISeriesApi<SeriesType>;
    });
    c.timeScale().fitContent();
  }, [lines, mode, chart]);

  return <div className="bt-chart" ref={box} />;
}

export function DrawdownChart({ points }: { points: Pt[] }) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useChart(box);
  const series = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    theme(c);
    if (series.current) c.removeSeries(series.current);
    const down = token('--down');
    const s = c.addSeries(AreaSeries, {
      lineColor: down, lineWidth: 2, topColor: withAlpha(down, 0.08), bottomColor: withAlpha(down, 0.32),
      priceLineVisible: false, lastValueVisible: true, title: 'Below the high',
    });
    s.setData(data(points));
    series.current = s;
    c.timeScale().fitContent();
  }, [points, mode, chart]);

  return <div className="bt-chart bt-chart-dd" ref={box} />;
}
