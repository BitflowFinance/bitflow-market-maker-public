import { describe, expect, it } from 'vitest';
import {
  AddBinMath,
  PoolFees,
  calcAddSlippage,
  calcWithdrawAmounts,
  capPositionByValue,
  capShapedByValue,
  signedBinId,
} from '../src/liquidity';

const noFees: PoolFees = {
  xProtocol: 0,
  xProvider: 0,
  xVariable: 0,
  yProtocol: 0,
  yProvider: 0,
  yVariable: 0,
};

// price 1.0 stored as 1e8.
const PRICE_1 = 1e8;

describe('signedBinId', () => {
  it('shifts unsigned BFF bins to signed core bins', () => {
    expect(signedBinId(500)).toBe(0);
    expect(signedBinId(525)).toBe(25);
    expect(signedBinId(450)).toBe(-50);
  });
});

describe('calcAddSlippage', () => {
  it('mints sqrt-based DLP into an empty bin and charges no fee off the active bin', () => {
    const binMath: AddBinMath = {
      isActiveBin: false,
      binPriceScaled: PRICE_1,
      reserveX: 0,
      reserveY: 0,
      binShares: 0,
      xAmount: 100,
      yAmount: 100,
    };
    const res = calcAddSlippage(binMath, noFees, 100);
    expect(res.minDlp > BigInt(0)).toBe(true);
    expect(res.maxXFee).toBe(BigInt(0));
    expect(res.maxYFee).toBe(BigInt(0));
  });

  it('mints DLP proportional to existing shares for a balanced non-active add', () => {
    const binMath: AddBinMath = {
      isActiveBin: false,
      binPriceScaled: PRICE_1,
      reserveX: 1000,
      reserveY: 1000,
      binShares: 2000,
      xAmount: 100,
      yAmount: 100,
    };
    // addValue/binValue = (2e10)/(2e11) = 0.1 -> 0.1 * 2000 shares = 200, no slippage.
    const res = calcAddSlippage(binMath, noFees, 0);
    expect(res.minDlp).toBe(BigInt(200));
  });

  it('never returns a zero min-dlp floor', () => {
    const binMath: AddBinMath = {
      isActiveBin: false,
      binPriceScaled: PRICE_1,
      reserveX: 1_000_000,
      reserveY: 1_000_000,
      binShares: 2_000_000,
      xAmount: 0,
      yAmount: 0,
    };
    const res = calcAddSlippage(binMath, noFees, 0);
    expect(res.minDlp).toBe(BigInt(1));
  });

  it('charges an x liquidity fee for an x-heavy add to the active bin', () => {
    const binMath: AddBinMath = {
      isActiveBin: true,
      binPriceScaled: PRICE_1,
      reserveX: 1000,
      reserveY: 1000,
      binShares: 2000,
      xAmount: 1000,
      yAmount: 0,
    };
    const fees: PoolFees = { ...noFees, xProtocol: 30 }; // 30 bps on the x side
    const res = calcAddSlippage(binMath, fees, 0);
    expect(res.maxXFee > BigInt(0)).toBe(true);
    expect(res.maxYFee).toBe(BigInt(0));
  });
});

describe('calcWithdrawAmounts', () => {
  it('computes proportional min amounts for a full withdraw', () => {
    const res = calcWithdrawAmounts(BigInt(1000), BigInt(2000), BigInt(4000), BigInt(8000), 100, 0);
    expect(res.liquidityToRemove).toBe(BigInt(1000));
    expect(res.minX).toBe(BigInt(2000)); // 4000 * (1000/2000)
    expect(res.minY).toBe(BigInt(4000)); // 8000 * (1000/2000)
  });

  it('scales by the withdraw percentage', () => {
    const res = calcWithdrawAmounts(BigInt(1000), BigInt(2000), BigInt(4000), BigInt(8000), 50, 0);
    expect(res.liquidityToRemove).toBe(BigInt(500));
    expect(res.minX).toBe(BigInt(1000)); // 4000 * (500/2000)
    expect(res.minY).toBe(BigInt(2000));
  });

  it('applies slippage to the min amounts', () => {
    const res = calcWithdrawAmounts(BigInt(1000), BigInt(2000), BigInt(4000), BigInt(8000), 100, 100);
    expect(res.minX).toBe(BigInt(1980)); // 2000 * 0.99
    expect(res.minY).toBe(BigInt(3960)); // 4000 * 0.99
  });

  it('returns zeros when there is no liquidity', () => {
    const res = calcWithdrawAmounts(BigInt(0), BigInt(2000), BigInt(4000), BigInt(8000), 100, 0);
    expect(res.liquidityToRemove).toBe(BigInt(0));
    expect(res.minX).toBe(BigInt(0));
    expect(res.minY).toBe(BigInt(0));
  });
});

describe('capPositionByValue', () => {
  // price = 1 (Y per X); value = x + y.
  it('does not cap when value is within the limit', () => {
    const res = capPositionByValue(BigInt(40), BigInt(40), 1, BigInt(100));
    expect(res.capped).toBe(false);
    expect(res.xAmount).toBe(BigInt(40));
    expect(res.yAmount).toBe(BigInt(40));
  });

  it('scales both sides down proportionally when value exceeds the cap', () => {
    // value = 100+100 = 200, cap 100 -> scale 0.5
    const res = capPositionByValue(BigInt(100), BigInt(100), 1, BigInt(100));
    expect(res.capped).toBe(true);
    expect(res.xAmount).toBe(BigInt(50));
    expect(res.yAmount).toBe(BigInt(50));
  });

  it('accounts for price when valuing the X side', () => {
    // value = 100*2 + 0 = 200, cap 100 -> scale 0.5
    const res = capPositionByValue(BigInt(100), BigInt(0), 2, BigInt(100));
    expect(res.capped).toBe(true);
    expect(res.xAmount).toBe(BigInt(50));
    expect(res.yAmount).toBe(BigInt(0));
  });

  it('is disabled when cap is zero', () => {
    const res = capPositionByValue(BigInt(1000), BigInt(1000), 1, BigInt(0));
    expect(res.capped).toBe(false);
    expect(res.xAmount).toBe(BigInt(1000));
  });
});

describe('capShapedByValue', () => {
  // Three-bin shape: asks (x) above, cash (y) below, both at center. price 2 Y/X.
  const legs = [
    { x: BigInt(0), y: BigInt(50), price: 2 }, // bid leg: value 50
    { x: BigInt(25), y: BigInt(50), price: 2 }, // active: value 25*2+50 = 100
    { x: BigInt(25), y: BigInt(0), price: 2 }, // ask leg: value 50
  ]; // total addValue = 200

  it('leaves the shape unchanged when within the residual', () => {
    const res = capShapedByValue(legs, BigInt(200));
    expect(res.capped).toBe(false);
    expect(res.addValue).toBe(BigInt(200));
    expect(res.legs).toEqual([
      { x: BigInt(0), y: BigInt(50) },
      { x: BigInt(25), y: BigInt(50) },
      { x: BigInt(25), y: BigInt(0) },
    ]);
  });

  it('scales every leg by one factor, preserving the distribution', () => {
    // residual 100 -> scale 0.5
    const res = capShapedByValue(legs, BigInt(100));
    expect(res.capped).toBe(true);
    expect(res.legs).toEqual([
      { x: BigInt(0), y: BigInt(25) },
      { x: BigInt(12), y: BigInt(25) }, // floor(25*0.5)=12
      { x: BigInt(12), y: BigInt(0) },
    ]);
  });

  it('zeroes the shape when there is no residual left', () => {
    const res = capShapedByValue(legs, BigInt(0));
    expect(res.capped).toBe(true);
    expect(res.legs.every((l) => l.x === BigInt(0) && l.y === BigInt(0))).toBe(true);
  });
});
