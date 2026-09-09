import { describe, expect, it } from 'vitest';
import {
  computeImbalanceBps,
  driftBps,
  isBreakerTripped,
  nextBreakerCount,
  wouldParkOffActive,
} from '../src/mm';

describe('driftBps', () => {
  it('measures absolute drift from peg in bps', () => {
    expect(driftBps(1, 1.05)).toBe(500);
    expect(driftBps(1, 0.95)).toBe(500);
    expect(driftBps(1, 1)).toBe(0);
  });

  it('returns 0 for a non-positive peg', () => {
    expect(driftBps(0, 1.2)).toBe(0);
  });
});

describe('computeImbalanceBps', () => {
  it('is zero for a balanced inventory by value', () => {
    expect(computeImbalanceBps(BigInt(100), BigInt(100), 1)).toBe(0);
  });

  it('is 10000 (100%) when fully one-sided', () => {
    expect(computeImbalanceBps(BigInt(200), BigInt(0), 1)).toBe(10000);
  });

  it('accounts for the quote-per-base ratio', () => {
    // 100 quote vs 50 base * 2.0 = 100 quote-value -> balanced.
    expect(computeImbalanceBps(BigInt(100), BigInt(50), 2)).toBe(0);
  });

  it('returns 0 when total value is zero', () => {
    expect(computeImbalanceBps(BigInt(0), BigInt(0), 1)).toBe(0);
  });
});

describe('circuit breaker counting', () => {
  it('increments on failure and clears on a clean tick', () => {
    expect(nextBreakerCount(0, false)).toBe(1);
    expect(nextBreakerCount(4, false)).toBe(5);
    expect(nextBreakerCount(5, true)).toBe(0);
    expect(nextBreakerCount(0, true)).toBe(0);
  });

  it('trips once the streak reaches the max', () => {
    expect(isBreakerTripped(4, 5)).toBe(false);
    expect(isBreakerTripped(5, 5)).toBe(true);
    expect(isBreakerTripped(6, 5)).toBe(true);
  });

  it('is disabled when max is 0', () => {
    expect(isBreakerTripped(100, 0)).toBe(false);
  });

  it('simulates five consecutive failures then recovery', () => {
    let count = 0;
    const max = 5;
    for (let i = 0; i < 4; i++) count = nextBreakerCount(count, false);
    expect(isBreakerTripped(count, max)).toBe(false);
    count = nextBreakerCount(count, false);
    expect(isBreakerTripped(count, max)).toBe(true);
    count = nextBreakerCount(count, true);
    expect(count).toBe(0);
    expect(isBreakerTripped(count, max)).toBe(false);
  });
});

describe('wouldParkOffActive', () => {
  it('holds a reposition that has no swap to walk the active bin', () => {
    expect(wouldParkOffActive(-75, false)).toBe(true);
    expect(wouldParkOffActive(3, false)).toBe(true);
  });

  it('allows a reposition when a swap will move the active bin to target', () => {
    expect(wouldParkOffActive(-75, true)).toBe(false);
  });

  it('allows an at-active (within_bin) rebalance', () => {
    expect(wouldParkOffActive(0, false)).toBe(false);
    expect(wouldParkOffActive(0, true)).toBe(false);
  });

  it('is false when there is no target bin', () => {
    expect(wouldParkOffActive(null, false)).toBe(false);
  });
});
