import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { robustFee } from '../src/wallet';

// robustFee de-skews the sparse Stacks mempool: the chosen percentile is capped
// at FEE_OUTLIER_MULTIPLE x the stable p25 anchor. Values mirror a real observed
// distribution (p25=0.001 STX, p50=0.25 STX, p75/p95=2101 STX from one whale tx).
describe('robustFee', () => {
  const prev = CONFIG.FEE_OUTLIER_MULTIPLE;
  afterEach(() => {
    CONFIG.FEE_OUTLIER_MULTIPLE = prev;
  });

  const skewed = { p25: 1043, p50: 250600, p75: 2101003100, p95: 2101003100 };

  it('caps a whale-skewed percentile at multiple x p25', () => {
    CONFIG.FEE_OUTLIER_MULTIPLE = 4;
    // p50 (250600) is >> 4 x p25 (4172), so it is rejected down to the cap.
    expect(robustFee(skewed, 'p50')).toBe(1043 * 4);
    // p75 is an even more extreme outlier -> same cap.
    expect(robustFee(skewed, 'p75')).toBe(1043 * 4);
  });

  it('returns the percentile unchanged when it is within the cap', () => {
    CONFIG.FEE_OUTLIER_MULTIPLE = 4;
    // A mild rise: p50 = 3x p25 sits under the 4x cap, so it passes through.
    expect(robustFee({ p25: 1000, p50: 3000 }, 'p50')).toBe(3000);
  });

  it('rises with real congestion (cap tracks p25)', () => {
    CONFIG.FEE_OUTLIER_MULTIPLE = 4;
    // When the whole distribution lifts, p25 lifts too and the cap follows.
    expect(robustFee({ p25: 50000, p50: 120000 }, 'p50')).toBe(120000);
  });

  it('disables the cap when FEE_OUTLIER_MULTIPLE <= 0', () => {
    CONFIG.FEE_OUTLIER_MULTIPLE = 0;
    expect(robustFee(skewed, 'p50')).toBe(250600);
  });

  it('falls back to the raw value when there is no p25 anchor', () => {
    CONFIG.FEE_OUTLIER_MULTIPLE = 4;
    expect(robustFee({ p50: 5000 }, 'p50')).toBe(5000);
  });

  it('returns null when the chosen percentile is missing or non-positive', () => {
    CONFIG.FEE_OUTLIER_MULTIPLE = 4;
    expect(robustFee({ p25: 1000 }, 'p50')).toBeNull();
    expect(robustFee({ p25: 1000, p50: 0 }, 'p50')).toBeNull();
  });
});
