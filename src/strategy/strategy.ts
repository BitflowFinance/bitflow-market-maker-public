import { LadderBin } from '../bitflow';
import { MarketReading } from '../feeds/priceFeed';
import { RebalancePlan } from '../plan';

export type Decision = 'hold' | 'rebalance' | 'frozen' | 'no_data';

export interface TargetBin {
  binId: number;
  price: number;
  driftFromPegBps: number;
}

export interface BandTarget {
  target: TargetBin;
  inBand: boolean;
  lowerEdgePrice: number;
  upperEdgePrice: number;
}

// Everything a strategy needs to decide an action this tick. Reserves and
// balances are atomic (micro) and oriented as neutral base/quote sides (quote is
// the numeraire the fair price is denominated in); the orchestrator resolves
// token X/Y to these before calling.
export interface StrategyInput {
  poolId: string;
  activeBinId: number;
  activeBinPrice: number;
  ladder: LadderBin[];
  ownedBinIds: number[];
  // Active bin total reserves (both LPs) by side.
  binBase: bigint;
  binQuote: bigint;
  // Our holdings, split free wallet vs deployed.
  walletBase: bigint;
  walletQuote: bigint;
  ownedBase: bigint;
  ownedQuote: bigint;
  // The price feed's reading for this tick: external `reference`, peg status,
  // and swap-only conversion. The curve uses reference for safety + inventory.
  reading: MarketReading;
}

export interface StrategyLog {
  level: 'info' | 'warn';
  msg: string;
}

// A strategy-signalled halt: stop quoting and pull liquidity to safety. Used by
// market-follower strategies (e.g. on a broken peg or a stale price feed) that
// own this judgement themselves rather than relying on the orchestrator's global
// guardrails. `operational` = recoverable (withdraw, resume when clear);
// `broken_market` = hold inventory as-is, no blind swaps.
export interface StrategyHalt {
  kind: 'operational' | 'broken_market';
  reason: string;
}

// The strategy's verdict for the tick. It is pure: it does not log or broadcast.
// The curve hands back a prebuilt `plan` (and/or a `halt`); the orchestrator
// executes it through the global guards only.
export interface StrategyDecision {
  decision: Decision;
  planType: 'reposition' | 'within_bin' | null;
  target: TargetBin | null;
  binOffset: number | null;
  reason?: string;
  skewRebalance: boolean;
  meaningfulIdle: boolean;
  plan?: RebalancePlan;
  halt?: StrategyHalt;
  // Signals surfaced for logging / metrics.
  activeBinImbalanceBps: number;
  ourSkewBps: number;
  ourBinShareBps: number;
  pegDriftBps: number;
  band: BandTarget | null;
  logs: StrategyLog[];
  // Optional numeric signals for structured metrics (JSONL), keyed freely by the
  // strategy (e.g. curve: f, bidFraction, width, size, sigma, dBps).
  signals?: Record<string, number>;
}

export interface Strategy {
  readonly name: string;
  decide(input: StrategyInput): StrategyDecision;
}

// One-sided imbalance in bps of total value (0 = balanced 50/50, 10000 = fully
// one-sided). `ratio` (quote per base) converts the base side into quote value.
export const computeImbalanceBps = (quote: bigint, base: bigint, ratio: number): number => {
  const quoteValue = Number(quote);
  const baseValueInQuote = Number(base) * ratio;
  const total = quoteValue + baseValueInQuote;
  if (total <= 0) return 0;
  return Math.round((Math.abs(quoteValue - baseValueInQuote) / total) * 10000);
};

// Absolute drift of an observed price from the peg, in bps.
export const driftBps = (peg: number, observed: number): number => {
  if (peg <= 0) return 0;
  return Math.round((Math.abs(observed - peg) / peg) * 10000);
};
