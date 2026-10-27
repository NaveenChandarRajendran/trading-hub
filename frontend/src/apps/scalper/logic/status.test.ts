// Starting ATM strikes, page status (Buy / Sell need "live") and the report helpers.
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import type { Chain } from './api';
import { daysCsv, defaultRange } from './reports';
import { atmLegs, pageStatus } from './series';

const nifty = niftyJson as unknown as ChainResponse;
const chain = {
  symbol: 'NIFTY', expiry: '2026-10-27', expiries: [], lotSize: 65, meta: {} as Chain['meta'], spot: { segment: 'IDX_I', securityId: 13 },
  rows: nifty.rows.map((r) => ({ strike: r.strike, ce: { securityId: r.strike * 10 + 1, name: 'CE' }, pe: { securityId: r.strike * 10 + 2, name: 'PE' } })),
} as Chain;

describe('starting strikes', () => {
  it('ATM CE / PE from every strike of the expiry', () => {
    expect(atmLegs(chain, 22811.35)).toEqual({ strike: 22800, ce: { securityId: 228001, name: 'CE' }, pe: { securityId: 228002, name: 'PE' } });
    expect(atmLegs(chain, 17010)?.strike).toBe(17000);
    expect(atmLegs(null, 22800)).toBeNull();
    expect(atmLegs(chain, null)).toBeNull();
  });
});

describe('page status', () => {
  const meta = { marketOpen: true, tokenExpired: false, feedConnected: true };
  it('live, stale, closed, token expired, offline, loading', () => {
    expect(pageStatus('open', meta, 1000, 10000)).toEqual({ kind: 'live', text: 'Live' });
    expect(pageStatus('open', meta, 23000, 10000)).toEqual({ kind: 'stale', text: 'Stale · 23s' });
    expect(pageStatus('open', { ...meta, marketOpen: false }, 0, 10000).kind).toBe('closed');
    expect(pageStatus('open', { ...meta, tokenExpired: true }, 0, 10000).text).toBe('Dhan token expired');
    expect(pageStatus('reconnecting', meta, 0, 10000).kind).toBe('offline');
    expect(pageStatus('open', null, 0, 10000).kind).toBe('loading');
  });
});

describe('volume axis', () => {
  it('Indian units', async () => {
    const { compactVolume } = await import('../chartTheme');
    expect([650, 6500, 250000, 40000000, 123456789].map(compactVolume)).toEqual(['650', '6.5K', '2.5L', '4.0Cr', '12Cr']);
  });
});

describe('reports', () => {
  it('default range and CSV with plain numbers', () => {
    expect(defaultRange('2026-10-27', 30)).toEqual(['2026-09-27', '2026-10-27']);
    expect(daysCsv([{ date: '2026-10-27', trades: 3, wins: 1, losses: 2, fills: 6, realized: -1000, charges: 131, net: -1131 }]))
      .toBe('Date,Trades,Wins,Losses,Fills,Realized,Charges,Net\n2026-10-27,3,1,2,6,-1000.00,131.00,-1131.00\n');
  });
});
