import { describe, expect, it } from 'vitest';
import {
  allocateCurve,
  bidFractionFromF,
  curveWeights,
  volHalfWidthBins,
  volRepositionDriftBins,
  volSizeFraction,
} from '../src/strategy/curveShape';

describe('curveWeights', () => {
  it('is symmetric and heaviest at the center', () => {
    const legs = curveWeights(2, 0.5);
    expect(legs.map((l) => l.offset)).toEqual([-2, -1, 0, 1, 2]);
    expect(legs.find((l) => l.offset === 0)!.weight).toBe(1);
    expect(legs.find((l) => l.offset === 1)!.weight).toBe(0.5);
    expect(legs.find((l) => l.offset === 2)!.weight).toBeCloseTo(0.25);
    // mirror symmetry
    expect(legs.find((l) => l.offset === -1)!.weight).toBe(legs.find((l) => l.offset === 1)!.weight);
  });

  it('collapses to a single active leg at half width 0', () => {
    expect(curveWeights(0, 0.5)).toEqual([{ offset: 0, weight: 1 }]);
  });
});

describe('bidFractionFromF', () => {
  const fStar = 0.38;
  const fSoft = 0.44;

  it('deploys full bids at or below neutral f*', () => {
    expect(bidFractionFromF(0.2, fStar, fSoft)).toBe(1);
    expect(bidFractionFromF(fStar, fStar, fSoft)).toBe(1);
  });

  it('pulls bids to zero at or above the soft cap', () => {
    expect(bidFractionFromF(fSoft, fStar, fSoft)).toBe(0);
    expect(bidFractionFromF(0.6, fStar, fSoft)).toBe(0);
  });

  it('ramps linearly between f* and f_soft', () => {
    // midpoint 0.41 -> skew 0.5 -> bidFraction 0.5
    expect(bidFractionFromF(0.41, fStar, fSoft)).toBeCloseTo(0.5);
  });

  it('degenerates safely when f_soft <= f*', () => {
    expect(bidFractionFromF(0.5, 0.44, 0.44)).toBe(0);
    expect(bidFractionFromF(0.4, 0.44, 0.44)).toBe(1);
  });

  it('leans into extra bids below f* when leanMax > 1 (M6)', () => {
    expect(bidFractionFromF(fStar, fStar, fSoft, 1.5)).toBe(1); // at f*, no lean yet
    expect(bidFractionFromF(0, fStar, fSoft, 1.5)).toBeCloseTo(1.5); // all cash -> full lean
    // halfway below f*: t = (0.38-0.19)/0.38 = 0.5 -> 1 + 0.5*0.5 = 1.25
    expect(bidFractionFromF(0.19, fStar, fSoft, 1.5)).toBeCloseTo(1.25);
  });

  it('leanMax defaults to 1 (no lean) below f*', () => {
    expect(bidFractionFromF(0.1, fStar, fSoft)).toBe(1);
  });
});

describe('volHalfWidthBins', () => {
  it('holds base width at or below the reference vol', () => {
    expect(volHalfWidthBins(5, 15, 0.001, 0.001)).toBe(5);
    expect(volHalfWidthBins(5, 15, 0.0005, 0.001)).toBe(5);
  });

  it('widens proportionally above the reference, capped at max', () => {
    expect(volHalfWidthBins(5, 15, 0.002, 0.001)).toBe(10); // 2x
    expect(volHalfWidthBins(5, 15, 0.005, 0.001)).toBe(15); // 5x -> 25 capped 15
  });

  it('falls back to base when sigma or sigmaRef is zero', () => {
    expect(volHalfWidthBins(5, 15, 0, 0.001)).toBe(5);
    expect(volHalfWidthBins(5, 15, 0.01, 0)).toBe(5);
  });
});

describe('volSizeFraction', () => {
  it('holds base size at or below the reference vol', () => {
    expect(volSizeFraction(0.6, 0.2, 0.001, 0.001)).toBeCloseTo(0.6);
    expect(volSizeFraction(0.6, 0.2, 0.0005, 0.001)).toBeCloseTo(0.6);
  });

  it('shrinks proportionally above the reference, floored at min', () => {
    expect(volSizeFraction(0.6, 0.2, 0.002, 0.001)).toBeCloseTo(0.3); // 2x
    expect(volSizeFraction(0.6, 0.2, 0.005, 0.001)).toBeCloseTo(0.2); // 5x -> 0.12 floored 0.2
  });

  it('falls back to base when sigma or sigmaRef is zero', () => {
    expect(volSizeFraction(0.6, 0.2, 0, 0.001)).toBeCloseTo(0.6);
    expect(volSizeFraction(0.6, 0.2, 0.01, 0)).toBeCloseTo(0.6);
  });
});

describe('volRepositionDriftBins', () => {
  it('is disabled when max <= base (default): always returns base', () => {
    expect(volRepositionDriftBins(6, 6, 0.005, 0.001)).toBe(6);
    expect(volRepositionDriftBins(6, 0, 0.005, 0.001)).toBe(6);
  });

  it('holds base drift at or below the reference vol', () => {
    expect(volRepositionDriftBins(6, 12, 0.001, 0.001)).toBe(6);
    expect(volRepositionDriftBins(6, 12, 0.0005, 0.001)).toBe(6);
  });

  it('widens proportionally above the reference, capped at max', () => {
    expect(volRepositionDriftBins(6, 12, 0.002, 0.001)).toBe(12); // 2x -> 12
    expect(volRepositionDriftBins(6, 9, 0.002, 0.001)).toBe(9); // 2x -> 12 capped 9
  });

  it('falls back to base when sigma or sigmaRef is zero', () => {
    expect(volRepositionDriftBins(6, 12, 0, 0.001)).toBe(6);
    expect(volRepositionDriftBins(6, 12, 0.01, 0)).toBe(6);
  });
});

describe('allocateCurve', () => {
  it('puts upper amount on offsets >= 0 and lower on offsets <= 0', () => {
    const legs = curveWeights(1, 0.5); // offsets -1,0,1 weights .5,1,.5
    const positions = allocateCurve(legs, BigInt(3000), BigInt(3000));
    const byOffset = new Map(positions.map((p) => [p.offset, p]));

    // upper (offset>=0): weights {0:1, 1:0.5} sum 1.5 -> 0 gets 2000, +1 gets 1000
    expect(byOffset.get(0)!.upper).toBe(BigInt(2000));
    expect(byOffset.get(1)!.upper).toBe(BigInt(1000));
    expect(byOffset.get(-1)!.upper).toBe(BigInt(0));

    // lower (offset<=0): weights {-1:0.5, 0:1} sum 1.5 -> 0 gets 2000, -1 gets 1000
    expect(byOffset.get(0)!.lower).toBe(BigInt(2000));
    expect(byOffset.get(-1)!.lower).toBe(BigInt(1000));
    expect(byOffset.get(1)!.lower).toBe(BigInt(0));
  });

  it('active bin draws from both sides; it is the only two-sided leg', () => {
    const legs = curveWeights(1, 0.5);
    const positions = allocateCurve(legs, BigInt(3000), BigInt(3000));
    const active = positions.find((p) => p.offset === 0)!;
    expect(active.upper > BigInt(0) && active.lower > BigInt(0)).toBe(true);
    for (const p of positions) {
      if (p.offset > 0) expect(p.lower).toBe(BigInt(0));
      if (p.offset < 0) expect(p.upper).toBe(BigInt(0));
    }
  });

  it('drops empty legs and handles one-sided inventory', () => {
    const legs = curveWeights(2, 0.5);
    const positions = allocateCurve(legs, BigInt(0), BigInt(7000));
    // only offsets <= 0 receive anything
    expect(positions.every((p) => p.offset <= 0)).toBe(true);
    expect(positions.every((p) => p.upper === BigInt(0))).toBe(true);
    const total = positions.reduce((s, p) => s + p.lower, BigInt(0));
    // floor rounding may shave a unit or two, but the bulk is allocated
    expect(total).toBeGreaterThan(BigInt(6900));
  });
});
