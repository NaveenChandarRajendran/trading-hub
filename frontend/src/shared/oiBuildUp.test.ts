import { describe, expect, it } from 'vitest';
import { buildUp } from './oiBuildUp';

describe('OI build-up', () => {
  it('reads put-heavy OI as support (30-Oct-2026 Nifty: 61.8 L puts, 36.2 L calls, more puts added)', () => {
    expect(buildUp(6177613, 3617530, 1620843, 790150)).toMatchObject({ verdict: 'Bullish' });
    expect(buildUp(6177613, 3617530, 1620843, 790150)!.putShare).toBeCloseTo(63.07, 1);
    expect(buildUp(3617530, 6177613, 790150, 1620843)?.verdict).toBe('Bearish');
    expect(buildUp(6177613, 3617530, 500, 900)?.verdict).toBe('Neutral');
    expect(buildUp(5100, 4900)?.verdict).toBe('Neutral');
    expect(buildUp(0, 0)).toBeNull();
  });
});
