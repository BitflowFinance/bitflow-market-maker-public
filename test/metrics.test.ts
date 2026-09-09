import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { classifyReason, getHistory, getMetrics, recordTick } from '../src/metrics';
import { TickResult } from '../src/mm';

// Keep tests in-memory: never touch the real data/ files (the defaults), which a
// live run would otherwise read back as a corrupted baseline.
CONFIG.METRICS_LOG_FILE = '';
CONFIG.METRICS_BASELINE_FILE = '';
// These fixtures treat both sides as 6-decimal (stx() = * 1e6).
CONFIG.BASE_DECIMALS = 6;
CONFIG.QUOTE_DECIMALS = 6;

const tick = (over: Partial<TickResult>): TickResult => ({
  tickId: 1,
  poolId: 'dlmm_10',
  activeBinId: 500,
  targetBinId: 500,
  binOffset: 0,
  quotePerBase: 1.2,
  activeBinPrice: 1.2,
  targetBinPrice: 1.2,
  activeBinQuote: BigInt(0),
  activeBinBase: BigInt(0),
  imbalanceBps: 0,
  decision: 'hold',
  executed: false,
  durationSeconds: 1,
  ...over,
});

const stx = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

describe('classifyReason', () => {
  it('maps rebalance regardless of reason', () => {
    expect(classifyReason('rebalance', 'whatever')).toBe('rebalance');
  });

  it('maps known hold/freeze causes to low-cardinality tags', () => {
    expect(classifyReason('frozen', 'kill_switch')).toBe('kill_switch');
    expect(classifyReason('hold', 'pool_inactive')).toBe('pool_inactive');
    expect(classifyReason('frozen', 'peg_unavailable: timeout')).toBe('peg_unavailable');
    expect(
      classifyReason('hold', 'wallet_stx=1 below gas reserve=5; top up STX'),
    ).toBe('low_gas');
    expect(
      classifyReason('hold', 'nonce gap detected (missing [4]); holding until cleared'),
    ).toBe('nonce_gap');
    expect(
      classifyReason('hold', 'a prior tx is still pending in the mempool; holding'),
    ).toBe('pending_tx');
    expect(
      classifyReason('hold', 'holding rather than parking off-active'),
    ).toBe('off_active');
    expect(
      classifyReason('hold', 'holding to avoid churn'),
    ).toBe('churn');
  });

  it('falls back to other for unknown hold reasons', () => {
    expect(classifyReason('hold', 'something novel')).toBe('other');
  });
});

describe('recordTick portfolio + PnL', () => {
  it('captures a baseline and computes PnL vs HODL at the current peg', () => {
    // Baseline tick: 100 quote + 100 base at peg 1.2 -> value 220.
    recordTick(
      tick({
        tickId: 1,
        walletQuote: stx(100),
        walletBase: stx(100),
        ownedQuote: stx(0),
        ownedBase: stx(0),
        quotePerBase: 1.2,
      }),
    );

    // Later tick: earned some base (now 110), same peg. value = 100 + 110*1.2 = 232.
    // HODL of the baseline at peg 1.2 = 100 + 100*1.2 = 220. PnL = +12.
    recordTick(
      tick({
        tickId: 2,
        walletQuote: stx(100),
        walletBase: stx(110),
        ownedQuote: stx(0),
        ownedBase: stx(0),
        quotePerBase: 1.2,
      }),
    );

    const m = getMetrics();
    expect(m.portfolioValue).toBeCloseTo(232, 4);
    expect(m.pnlVsHodl).toBeCloseTo(12, 4);
    const baseline = m.baseline as { quote: number; base: number; peg: number };
    expect(baseline.quote).toBeCloseTo(100, 4);
    expect(baseline.base).toBeCloseTo(100, 4);
  });

  it('accumulates gas fees and counts decisions/holds', () => {
    recordTick(
      tick({
        tickId: 3,
        decision: 'rebalance',
        walletQuote: stx(100),
        walletBase: stx(100),
        ownedQuote: stx(0),
        ownedBase: stx(0),
        executed: true,
        plan: { poolId: 'dlmm_10', type: 'within_bin', reason: 'x', targetBinId: 500, steps: [{}, {}] as never, notes: [], inventoryBlocked: false, inventoryRebalanceOnly: false },
        feesPaidUstx: stx(0.5),
      }),
    );

    const m = getMetrics();
    expect(Number(m.feesPaidStx)).toBeGreaterThanOrEqual(0.5);
    const byDecision = m.byDecision as Record<string, number>;
    expect(byDecision.rebalance).toBeGreaterThanOrEqual(1);
    expect((m.executedSteps as number)).toBeGreaterThanOrEqual(2);
    expect(getHistory(10).length).toBeGreaterThanOrEqual(3);
  });
});
