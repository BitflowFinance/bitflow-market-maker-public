import { describe, expect, it } from 'vitest';
import { LadderBin } from '../src/bitflow';
import { estimateSwapOutput } from '../src/swap';

const bin = (binId: number, price: number, reserveX: number, reserveY: number): LadderBin => ({
  binId,
  price,
  reserveX: BigInt(reserveX),
  reserveY: BigInt(reserveY),
});

describe('estimateSwapOutput', () => {
  it('partially fills the active bin without crossing (x-for-y)', () => {
    const ladder = [bin(0, 1, 100, 100)];
    const est = estimateSwapOutput(ladder, 0, true, BigInt(40), 10);
    // 40 X at price 1.0 -> 40 Y, one bin touched, all input consumed.
    expect(est.expectedOut).toBe(BigInt(40));
    expect(est.binsTouched).toBe(1);
    expect(est.amountConsumed).toBe(BigInt(40));
  });

  it('drains the active bin then partially fills the next (y-for-x, moving up)', () => {
    const ladder = [bin(0, 1, 100, 100), bin(1, 1.1, 50, 50)];
    // Sell 150 Y: drain bin0 X (100, costs 100 Y), then 50 Y into bin1 -> 50/1.1 X.
    const est = estimateSwapOutput(ladder, 0, false, BigInt(150), 10);
    expect(est.binsTouched).toBe(2);
    expect(est.amountConsumed).toBe(BigInt(150));
    // 100 + floor(50/1.1) contribution -> floor(100 + 45.45) = 145
    expect(est.expectedOut).toBe(BigInt(145));
  });

  it('stops at maxSteps even with input remaining', () => {
    const ladder = [bin(0, 1, 100, 100), bin(1, 1.1, 100, 100)];
    const est = estimateSwapOutput(ladder, 0, false, BigInt(1000), 1);
    expect(est.binsTouched).toBe(1);
    expect(est.expectedOut).toBe(BigInt(100));
    expect(est.amountConsumed).toBe(BigInt(100));
  });

  it('crosses an empty bin for ~free but spends a step', () => {
    const ladder = [bin(0, 1, 0, 0), bin(1, 1.1, 50, 50)];
    // bin0 has no X to take; step is consumed crossing it, fill happens in bin1.
    const est = estimateSwapOutput(ladder, 0, false, BigInt(10), 5);
    expect(est.binsTouched).toBe(2);
    expect(est.expectedOut).toBe(BigInt(9)); // floor(10 / 1.1)
    expect(est.amountConsumed).toBe(BigInt(10));
  });

  it('breaks when the ladder has a gap (missing next bin)', () => {
    const ladder = [bin(0, 1, 100, 100)];
    const est = estimateSwapOutput(ladder, 0, false, BigInt(1000), 10);
    expect(est.binsTouched).toBe(1);
    expect(est.expectedOut).toBe(BigInt(100));
    expect(est.amountConsumed).toBe(BigInt(100));
  });
});
