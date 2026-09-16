import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddBinMath, PoolFees, calcAddSlippage } from '../src/liquidity';

// Quote v2 documents the bin ladder's `liquidity` as always null. Reading that
// as zero shares is not a rounding error: it switches calcAddSlippage onto the
// empty-bin branch, so these tests pin both the damage and the fallback.

const getBinTotalSupply = vi.fn();

vi.mock('../src/stacks', async () => ({
  ...(await vi.importActual<typeof import('../src/stacks')>('../src/stacks')),
  getBinTotalSupply: (...args: unknown[]) => getBinTotalSupply(...args),
}));

const POOL = 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10';

const fees: PoolFees = {
  xProtocol: 25,
  xProvider: 25,
  xVariable: 0,
  yProtocol: 25,
  yProvider: 25,
  yVariable: 0,
};

beforeEach(() => {
  getBinTotalSupply.mockReset();
});

describe('resolveBinShares', () => {
  it('uses the ladder value when the BFF supplies one, with no chain reads', async () => {
    const { resolveBinShares } = await import('../src/liquidity');

    const shares = await resolveBinShares(POOL, [
      { bin_id: 664, liquidity: '695014326' },
      { bin_id: 665, liquidity: '540779927' },
    ] as never);

    expect(shares.get(664)).toBe(695014326);
    expect(shares.get(665)).toBe(540779927);
    expect(getBinTotalSupply).not.toHaveBeenCalled();
  });

  it('reads total supply from the pool for bins the ladder nulls out', async () => {
    const { resolveBinShares } = await import('../src/liquidity');
    getBinTotalSupply.mockResolvedValue(BigInt('695014326'));

    const shares = await resolveBinShares(POOL, [{ bin_id: 664, liquidity: null }] as never);

    // The on-chain total must match what the inventory endpoint reports for the
    // same bin -- verified against mainnet bin 664 on the sBTC/USDCx pool.
    expect(shares.get(664)).toBe(695014326);
    expect(getBinTotalSupply).toHaveBeenCalledWith(POOL, 664, expect.anything());
  });

  it('only pays for chain reads on the bins that are missing', async () => {
    const { resolveBinShares } = await import('../src/liquidity');
    getBinTotalSupply.mockResolvedValue(BigInt(1000));

    await resolveBinShares(POOL, [
      { bin_id: 664, liquidity: '695014326' },
      { bin_id: 665, liquidity: null },
      { bin_id: 666, liquidity: undefined },
    ] as never);

    expect(getBinTotalSupply).toHaveBeenCalledTimes(2);
  });
});

describe('why the fallback exists', () => {
  // Reserves/shares captured from mainnet bin 664 on the sBTC/USDCx pool.
  const bin = (binShares: number, xAmount: number): AddBinMath => ({
    isActiveBin: false,
    binPriceScaled: 758326630,
    reserveX: 2618844,
    reserveY: 0,
    binShares,
    xAmount,
    yAmount: 0,
  });
  const minDlp = (binShares: number, xAmount: number): bigint =>
    calcAddSlippage(bin(binShares, xAmount), fees, 100).minDlp;

  const SHARES = 695014326;

  // Real DLP scales linearly with the add while the empty-bin branch scales with
  // its square root, so reading a populated bin as empty misprices minDlp in
  // *either* direction depending on size. Both outcomes are bad, which is why
  // the shares have to be resolved rather than defaulted.
  it('over-demands DLP on a small add, which aborts the transaction', () => {
    expect(minDlp(0, 1000)).toBeGreaterThan(minDlp(SHARES, 1000) * BigInt(3));
  });

  it('under-demands DLP on a large add, which forfeits slippage protection', () => {
    expect(minDlp(0, 100000) * BigInt(3)).toBeLessThan(minDlp(SHARES, 100000));
  });
});
