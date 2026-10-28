// TP / SL drag on the chart: rounding, P&L at a price, validation and snap-back, and drop -> create / modify / cancel.
import { describe, expect, it } from 'vitest';
import { dropResult, lineLabel, onBox, placeGrips, pnlAt, roundTick, validateLevel } from './drag';

const base = { kind: 'tp' as const, price: 52.33, onLabel: false, existing: null, ltp: 33.75, other: null };

describe('prices and P&L', () => {
  it('round to the 0.05 tick without float noise; P&L of the open qty', () => {
    expect([roundTick(52.33), roundTick(52.326), roundTick(30.024), roundTick(0.1 + 0.2)]).toEqual([52.35, 52.35, 30, 0.3]);
    expect(pnlAt(37.55, 33.55, 65)).toBe(260);
    expect(lineLabel('tp', 37.55, 33.55, 65)).toBe('TP 37.55 · +260.00');
    expect(lineLabel('sl', 30.2, 33.55, 65)).toBe('SL 30.20 · −217.75');
    expect(lineLabel('tp', 204.9, 185, 52)).toBe('TP 204.90 · +1,034.80');
  });
});

describe('validation (long)', () => {
  it('TP above LTP, SL below LTP and below the target', () => {
    expect(validateLevel('tp', 40, 33.75, null)).toBe('');
    expect(validateLevel('tp', 33, 33.75, null)).toBe('Target must be above LTP 33.75.');
    expect(validateLevel('sl', 30, 33.75, null)).toBe('');
    expect(validateLevel('sl', 34, 33.75, null)).toBe('Stop must be below LTP 33.75.');
    expect(validateLevel('sl', 0, 33.75, null)).toBe('Price must be above 0.');
    expect(validateLevel('tp', 40, null, null)).toBe('No live price yet.');
  });
});

describe('drop', () => {
  it('a new TP dropped above LTP is created at the rounded price', () => {
    expect(dropResult(base)).toEqual({ action: 'set', body: { target: 52.35 } });
    expect(dropResult({ ...base, kind: 'sl', price: 30.02 })).toEqual({ action: 'set', body: { stop: 30 } });
  });

  it('dragging an existing line moves it (modify); the same price does nothing', () => {
    expect(dropResult({ ...base, existing: 50, price: 55.01 })).toEqual({ action: 'set', body: { target: 55 } });
    expect(dropResult({ ...base, existing: 55, price: 55.01 })).toEqual({ action: 'none' });
  });

  it('dropped back on the position label cancels an existing line; a new one just snaps back', () => {
    expect(dropResult({ ...base, existing: 50, onLabel: true })).toEqual({ action: 'cancel', body: { target: null } });
    expect(dropResult({ ...base, kind: 'sl', existing: 30, onLabel: true })).toEqual({ action: 'cancel', body: { stop: null } });
    expect(dropResult({ ...base, onLabel: true })).toEqual({ action: 'none' });
  });

  it('only the label box cancels: a stop just below the entry line, away from the box, is placed', () => {
    const box = { left: 10, top: 292, right: 190, bottom: 308 }; // the label on the entry line at y 300
    expect(onBox(100, 300, box)).toBe(true);
    expect(onBox(195, 312, box)).toBe(true); // within the padding
    expect(onBox(400, 305, box)).toBe(false); // same height, further along the chart: a price
    expect(onBox(100, 320, box)).toBe(false); // just under the box
    expect(onBox(100, 300, null)).toBe(false);
    expect(dropResult({ ...base, kind: 'sl', price: 33.42, onLabel: onBox(400, 305, box) })).toEqual({ action: 'set', body: { stop: 33.4 } });
  });

  it('invalid drops snap back with a message', () => {
    expect(dropResult({ ...base, price: 31 })).toEqual({ action: 'invalid', message: 'Target must be above LTP 33.75.' });
    expect(dropResult({ ...base, kind: 'sl', price: 36 })).toEqual({ action: 'invalid', message: 'Stop must be below LTP 33.75.' });
    expect(dropResult({ ...base, price: null })).toEqual({ action: 'none' }); // off the chart
  });
});

describe('grip placement (small charts: entry, TP and SL a few pixels apart)', () => {
  const label = { left: 8, right: 140, top: 90, bottom: 110 }; // compact label on the entry line at y 100

  it('far from the label and each other: all at the left edge', () => {
    expect(placeGrips([{ key: 'tp', y: 20, w: 90 }, { key: 'sl', y: 180, w: 90 }], label)).toEqual({ tp: 8, sl: 8 });
  });

  it('level with the label: just right of it; level with each other too: side by side', () => {
    expect(placeGrips([{ key: 'tp', y: 95, w: 90 }], label)).toEqual({ tp: 146 });
    expect(placeGrips([{ key: 'tp', y: 92, w: 90 }, { key: 'sl', y: 108, w: 90 }], label)).toEqual({ tp: 146, sl: 242 });
    expect(placeGrips([{ key: 'tp', y: 30, w: 90 }, { key: 'sl', y: 40, w: 90 }], null)).toEqual({ tp: 8, sl: 104 });
  });
});
