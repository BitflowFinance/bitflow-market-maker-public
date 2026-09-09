import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { swapOnly } from '../src/conversion';
import { MarketReading } from '../src/feeds/priceFeed';
import { curve } from '../src/strategy/curve';
import { StrategyInput } from '../src/strategy/strategy';

// Fixtures use equal-decimal prices (ref 600 == active-bin 600). Pin decimals so
// the quote-micro/base-micro factor stays 1 regardless of the sBTC/USDCx defaults.
CONFIG.BASE_DECIMALS = 6;
CONFIG.QUOTE_DECIMALS = 6;

// Baseline vol == SIGMA_REF default (0.001) so width/size sit at their base
// config in these fixtures; the M2 tests override volatility to exercise scaling.
const reading = (over: Partial<MarketReading> = {}): MarketReading => ({
  reference: { price: 600, ageMs: 0, volatility: 0.001 },
  conversion: swapOnly,
  ...over,
});

// Neutral by default (f ~= F_STAR 0.38, so bidFraction ~= 1 -- no M4 pull, no M6
// lean, no M5 swap) so the deploy/hold/reposition tests exercise those paths
// cleanly. The M4/M5/M6 tests below override the inventory (V-heavy / cash-heavy).
// v = 1e6*600 = 6e8; c = 978.947e6 -> f = 6e8/(6e8+978.947e6) = 0.38.
const input = (over: Partial<StrategyInput> = {}): StrategyInput => ({
  poolId: 'dlmm_1',
  activeBinId: 520,
  activeBinPrice: 600,
  ladder: [],
  ownedBinIds: [],
  binBase: BigInt(1_000_000),
  binQuote: BigInt(600_000_000),
  walletBase: BigInt(1_000_000),
  walletQuote: BigInt(978_947_000),
  ownedBase: BigInt(0),
  ownedQuote: BigInt(0),
  reading: reading(),
  ...over,
});

describe('curve strategy', () => {
  it('deploys a shaped curve when nothing is deployed', () => {
    const d = curve.decide(input({ ownedBinIds: [] }));
    expect(d.decision).toBe('rebalance');
    expect(d.plan).toBeDefined();
    expect(d.halt).toBeUndefined();
    const kinds = d.plan!.steps.map((s) => s.kind);
    expect(kinds).toEqual(['add_shaped_liquidity']);
    const shaped = d.plan!.steps.find((s) => s.kind === 'add_shaped_liquidity')!;
    if (shaped.kind === 'add_shaped_liquidity') {
      expect(shaped.offsets.length).toBe(11); // 2*5 + 1
      expect(shaped.offsets).toContain(0);
      // Neutral inventory (f ~= f*): full bids, no lean.
      expect(shaped.bidFraction).toBeCloseTo(1, 2);
    }
    expect(d.plan!.targetBinId).toBe(520);
  });

  it('holds when deployed and the active bin is in range', () => {
    const d = curve.decide(input({ activeBinId: 520, ownedBinIds: [515, 520, 525] }));
    expect(d.decision).toBe('hold');
    expect(d.plan).toBeUndefined();
    expect(d.halt).toBeUndefined();
  });

  it('repositions (withdraw + shaped add) when the active bin leaves range', () => {
    const d = curve.decide(input({ activeBinId: 540, ownedBinIds: [495, 500, 505] }));
    expect(d.decision).toBe('rebalance');
    expect(d.plan).toBeDefined();
    expect(d.plan!.steps.map((s) => s.kind)).toEqual([
      'withdraw_liquidity',
      'add_shaped_liquidity',
    ]);
  });

  it('broken-market halts on a broken peg', () => {
    const d = curve.decide(
      input({ reading: reading({ peg: { deviationBps: 200, broken: true } }) }),
    );
    expect(d.halt?.kind).toBe('broken_market');
    expect(d.plan).toBeUndefined();
  });

  it('broken-market halts on large pool/external divergence', () => {
    // active bin price 2% off the reference -> 200bps > 150bps halt
    const d = curve.decide(input({ activeBinPrice: 612 }));
    expect(d.halt?.kind).toBe('broken_market');
  });

  it('operational halts on a stale feed beyond the halt age', () => {
    const d = curve.decide(input({ reading: reading({ reference: { price: 600, ageMs: 400_000 } }) }));
    expect(d.halt?.kind).toBe('operational');
  });

  it('goes defensive (hold, no plan) on warn-level divergence', () => {
    // 1% off -> 100bps: > warn 80, <= halt 150
    const d = curve.decide(input({ activeBinPrice: 606, ownedBinIds: [515, 520, 525] }));
    expect(d.decision).toBe('hold');
    expect(d.halt).toBeUndefined();
    expect(d.plan).toBeUndefined();
    expect(d.reason).toMatch(/defensive/);
  });

  it('holds with no_data when the feed has no reference price', () => {
    const d = curve.decide(input({ reading: { conversion: swapOnly } }));
    expect(d.decision).toBe('no_data');
    expect(d.plan).toBeUndefined();
  });
});

// V-heavy inventory: baseTot=2 sBTC-micro @ 600 => V=1.2e9, C=6e8, f=0.667 > F_HARD.
const vHeavy = (over: Partial<StrategyInput> = {}): StrategyInput =>
  input({
    walletBase: BigInt(0),
    ownedBase: BigInt(2_000_000),
    walletQuote: BigInt(0),
    ownedQuote: BigInt(600_000_000),
    ownedBinIds: [520],
    activeBinId: 520,
    ...over,
  });

describe('curve strategy M5 de-risk swap', () => {
  afterEach(() => {
    CONFIG.ENABLE_SWAP = true;
  });

  it('sells V->C toward f_soft when f breaches the hard cap (healthy market)', () => {
    const prev = CONFIG.DERISK_MAX_FRACTION;
    CONFIG.DERISK_MAX_FRACTION = 0; // disable throttle here to verify the reach-f_soft math
    try {
      const d = curve.decide(vHeavy());
      expect(d.decision).toBe('rebalance');
      expect(d.halt).toBeUndefined();
      expect(d.planType).toBe('reposition');
      // wallet base is 0, so we withdraw to source base then swap. The redeploy is
      // decoupled to the next tick (no add_shaped in the de-risk plan) because the
      // swap moves the active bin.
      const kinds = d.plan!.steps.map((s) => s.kind);
      expect(kinds).toEqual(['withdraw_liquidity', 'swap']);
      const swap = d.plan!.steps.find((s) => s.kind === 'swap')!;
      if (swap.kind === 'swap') {
        expect(swap.sell).toBe('base');
        // s = baseTot*(1-f_soft) - f_soft*C/priceMicro = 2e6*0.56 - 0.44*6e8/600 = 6.8e5
        expect(swap.amountIn).toBe(BigInt(680_000));
        expect(swap.amountIn).toBeLessThan(BigInt(2_000_000)); // partial de-risk, not a dump
      }
    } finally {
      CONFIG.DERISK_MAX_FRACTION = prev;
    }
  });

  it('throttles each de-risk swap to DERISK_MAX_FRACTION of V', () => {
    const prev = CONFIG.DERISK_MAX_FRACTION;
    CONFIG.DERISK_MAX_FRACTION = 0.25;
    try {
      const d = curve.decide(vHeavy());
      const swap = d.plan!.steps.find((s) => s.kind === 'swap')!;
      // chunk = 25% of baseTot = 0.25 * 2e6 = 5e5 < sExact (6.8e5) -> capped to 5e5.
      if (swap.kind === 'swap') expect(swap.amountIn).toBe(BigInt(500_000));
    } finally {
      CONFIG.DERISK_MAX_FRACTION = prev;
    }
  });

  it('sells from wallet only (no withdraw, no redeploy) when free base covers it', () => {
    // Pin the throttle so the sell (500k at 25% of V=2e6) fits inside free wallet
    // base (600k) regardless of the ambient config default -- otherwise a larger
    // default fraction would push the sell past the wallet and force a withdraw.
    const prev = CONFIG.DERISK_MAX_FRACTION;
    CONFIG.DERISK_MAX_FRACTION = 0.25;
    try {
      // Same f, but hold the base free in the wallet -> swap-only plan, curve untouched.
      const d = curve.decide(vHeavy({ walletBase: BigInt(600_000), ownedBase: BigInt(1_400_000) }));
      expect(d.decision).toBe('rebalance');
      expect(d.plan!.steps.map((s) => s.kind)).toEqual(['swap']);
    } finally {
      CONFIG.DERISK_MAX_FRACTION = prev;
    }
  });

  it('applies a partial bid pull (M4 skew) on a reposition while f* < f < f_soft', () => {
    // baseTot=1e6 @600 => V=6e8; C sized for f=0.41 (midpoint of f*..f_soft).
    // active bin left range -> reposition, so the skewed curve is deployed.
    const d = curve.decide(
      input({
        walletBase: BigInt(0),
        ownedBase: BigInt(1_000_000),
        walletQuote: BigInt(0),
        ownedQuote: BigInt(863_400_000),
        ownedBinIds: [495, 500, 505],
        activeBinId: 540,
      }),
    );
    expect(d.decision).toBe('rebalance');
    const shaped = d.plan!.steps.find((s) => s.kind === 'add_shaped_liquidity')!;
    if (shaped.kind === 'add_shaped_liquidity') expect(shaped.bidFraction).toBeCloseTo(0.5, 1);
  });

  it('halts (broken market) before de-risking even when f is over the hard cap', () => {
    const d = curve.decide(vHeavy({ reading: reading({ peg: { deviationBps: 200, broken: true } }) }));
    expect(d.halt?.kind).toBe('broken_market');
    expect(d.plan).toBeUndefined();
  });

  it('goes defensive (hold) before de-risking on warn-level divergence', () => {
    // 100bps divergence: warn < 100 <= halt; defensive tier wins over M5.
    const d = curve.decide(vHeavy({ activeBinPrice: 606 }));
    expect(d.decision).toBe('hold');
    expect(d.reason).toMatch(/defensive/);
    expect(d.plan).toBeUndefined();
  });

  it('does not de-risk while f is between f_soft and f_hard', () => {
    // baseTot=1e6 @600 => V=6e8; C sized for f=0.47 (in the soft..hard band).
    const d = curve.decide(
      input({
        walletBase: BigInt(0),
        ownedBase: BigInt(1_000_000),
        walletQuote: BigInt(0),
        ownedQuote: BigInt(676_600_000),
        ownedBinIds: [520],
        activeBinId: 520,
      }),
    );
    expect(d.decision).toBe('hold');
    expect(d.plan).toBeUndefined();
  });

  it('holds (no de-risk plan) when swaps are disabled', () => {
    CONFIG.ENABLE_SWAP = false;
    const d = curve.decide(vHeavy());
    expect(d.decision).toBe('hold');
    expect(d.plan).toBeUndefined();
  });

  it('leans into extra bids (M6) without a swap when cash-heavy (f < f*)', () => {
    // baseTot=1e6 @600 => V=6e8; C sized for f=0.19 (halfway below f*).
    // lean t = (0.38-0.19)/0.38 = 0.5 -> bidFraction = 1 + 0.5*(1.5-1) = 1.25.
    const d = curve.decide(
      input({
        walletBase: BigInt(0),
        ownedBase: BigInt(1_000_000),
        walletQuote: BigInt(0),
        ownedQuote: BigInt(2_557_890_000),
        ownedBinIds: [495, 500, 505],
        activeBinId: 540,
      }),
    );
    expect(d.decision).toBe('rebalance');
    // Pure shaping -- no market-buy of V.
    expect(d.plan!.steps.some((s) => s.kind === 'swap')).toBe(false);
    const shaped = d.plan!.steps.find((s) => s.kind === 'add_shaped_liquidity')!;
    if (shaped.kind === 'add_shaped_liquidity') expect(shaped.bidFraction).toBeCloseTo(1.25, 2);
  });
});

describe('curve strategy M2 volatility scaling', () => {
  const shapedOf = (over: Partial<StrategyInput>) => {
    const d = curve.decide(input({ ownedBinIds: [], ...over }));
    const shaped = d.plan!.steps.find((s) => s.kind === 'add_shaped_liquidity')!;
    if (shaped.kind !== 'add_shaped_liquidity') throw new Error('no shaped step');
    return shaped;
  };

  it('deploys the base width/size at the reference vol', () => {
    const shaped = shapedOf({ reading: reading({ reference: { price: 600, ageMs: 0, volatility: 0.001 } }) });
    expect(shaped.offsets.length).toBe(11); // base half-width 5 -> 2*5+1
    expect(shaped.sizeFraction).toBeCloseTo(0.6); // base size
  });

  it('widens and shrinks size as vol rises above the reference', () => {
    // 2x SIGMA_REF: half-width -> 10 (offsets 21), size -> 0.6/2 = 0.3
    const shaped = shapedOf({ reading: reading({ reference: { price: 600, ageMs: 0, volatility: 0.002 } }) });
    expect(shaped.offsets.length).toBe(21);
    expect(shaped.sizeFraction).toBeCloseTo(0.3);
  });

  it('caps width at CURVE_MAX_HALF_WIDTH_BINS and floors size at CURVE_MIN_SIZE_FRACTION', () => {
    // 5x SIGMA_REF: half-width would be 25 -> capped 15 (offsets 31); size 0.12 -> floored 0.2
    const shaped = shapedOf({ reading: reading({ reference: { price: 600, ageMs: 0, volatility: 0.005 } }) });
    expect(shaped.offsets.length).toBe(31);
    expect(shaped.sizeFraction).toBeCloseTo(0.2);
  });

  it('falls back to base params when the feed reports no volatility yet', () => {
    const shaped = shapedOf({ reading: reading({ reference: { price: 600, ageMs: 0, volatility: 0 } }) });
    expect(shaped.offsets.length).toBe(11);
    expect(shaped.sizeFraction).toBeCloseTo(0.6);
  });
});
