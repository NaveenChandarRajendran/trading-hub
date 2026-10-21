// S1-S3 / R1-R3 for the chart, from the summary's option chain, with the OI Support & Resistance Live logic itself
// (Dhan chain -> NSE model -> analyzeChain -> topLevels). Nothing is recomputed differently here.
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { istMs } from '../../../shared/live/liveStatus';
import { analyzeChain, topLevels, type Analysis, type Level, type Side } from '../../oi-support-resistance/logic/levels';

export interface SrLevels {
  spot: number;
  levels: Record<Side, Level[]>; // R ascending from spot (R1 nearest), S descending from spot (S1 nearest)
  analysis: Analysis; // for "Copy levels for chart" and the glance card
}

export function srLevels(resp: ChainResponse, range: number): SrLevels | null {
  const chain = toOptionChain(resp);
  if (!chain.strikes.length || !(chain.underlying > 0)) return null;
  const analysis = analyzeChain(chain, istMs(resp.meta.asOf));
  const { rows, spot } = analysis.snapshot;
  return { spot, levels: { R: topLevels(rows, spot, 'R', range), S: topLevels(rows, spot, 'S', range) }, analysis };
}
