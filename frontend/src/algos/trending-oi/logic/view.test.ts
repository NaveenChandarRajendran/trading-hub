import { describe, expect, it } from 'vitest';
import { directionText } from './view';

describe('Trending OI overview', () => {
  it('direction pill', () => {
    expect(directionText(null)).toEqual({ text: 'No Trending OI yet', dots: '', tone: 'neutral' });
    expect(directionText({ side: 'CE', sentiment: 'Bullish', strength: 64, dots: 3, flipAt: null }))
      .toEqual({ text: 'Bullish 64.0% → CE only', dots: '●●●', tone: 'up' });
    expect(directionText({ side: null, sentiment: 'Bearish', strength: -25, dots: 1, flipAt: null }))
      .toEqual({ text: 'Bearish 25.0%', dots: '●○○', tone: 'neutral' });
  });
});
