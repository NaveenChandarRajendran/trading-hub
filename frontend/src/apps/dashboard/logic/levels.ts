// S1-S3 / R1-R3 for the Dashboard. The levels themselves come from the backend's recorded history (stability rule,
// backend/sr_levels.py); the latest chain gives spot, PCR and each level's current OI. When nothing is recorded for
// today (weekend, backend just started, expiry not tracked yet) the OI Support & Resistance ranking of the chain is
// used instead, flagged as "raw".
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { istMs } from '../../../shared/live/liveStatus';
import { analyzeChain, topLevels, type Analysis, type Level, type Side } from '../../oi-support-resistance/logic/levels';

export interface SrLevels {
  spot: number;
  levels: Record<Side, Level[]>; // R ascending from spot (R1 nearest), S descending from spot (S1 nearest)
  analysis: Analysis; // for "Copy levels for chart" and the glance card
  source: 'recorded' | 'raw';
}

/** The OI Support & Resistance ranking of one chain (the raw, minute-by-minute levels). */
export function srLevels(resp: ChainResponse, range: number): SrLevels | null {
  const chain = toOptionChain(resp);
  if (!chain.strikes.length || !(chain.underlying > 0)) return null;
  const analysis = analyzeChain(chain, istMs(resp.meta.asOf));
  const { rows, spot } = analysis.snapshot;
  return { spot, levels: { R: topLevels(rows, spot, 'R', range), S: topLevels(rows, spot, 'S', range) }, analysis, source: 'raw' };
}

/** Recorded levels (strikes from the backend) with this chain's spot, PCR and current OI per level (contracts). */
export function srFrom(resp: ChainResponse, recorded: Record<Side, Level[]> | null, range: number): SrLevels | null {
  const raw = srLevels(resp, range);
  if (!raw || !recorded) return raw;
  const rows = raw.analysis.snapshot.rows;
  const withOi = (side: Side) =>
    recorded[side].map((l) => ({ strike: l.strike, oi: rows[l.strike] ? rows[l.strike][side === 'R' ? 0 : 1] : l.oi }));
  return { ...raw, levels: { R: withOi('R'), S: withOi('S') }, source: 'recorded' };
}
