import { logInfo, logWarn } from './logger';
import {
  PrimitiveResult,
  addLiquidity,
  addShapedLiquidity,
  swap,
  withdrawLiquidity,
} from './primitives';
import { SwapSide, sideDecimals } from './swap';
import { microToString } from './stacks';
import { ExecutionContext, Preflight } from './wallet';

const TAG = 'plan';

// Steps with a real tx builder. A plan containing any other step kind must not
// broadcast in live mode, to avoid half-executing a plan.
const IMPLEMENTED_STEPS: Set<PlanStepKind> = new Set([
  'withdraw_liquidity',
  'swap',
  'add_liquidity',
  'add_shaped_liquidity',
]);

export type PlanStepKind =
  | 'withdraw_liquidity'
  | 'swap'
  | 'add_liquidity'
  | 'add_shaped_liquidity';

export interface WithdrawLiquidityStep {
  kind: 'withdraw_liquidity';
  binIds: number[];
  rationale: string;
  estimated: boolean;
}

export interface SwapStep {
  kind: 'swap';
  sell: SwapSide;
  amountIn: bigint;
  crossedBins: number;
  rationale: string;
  estimated: boolean;
}

export interface AddLiquidityStep {
  kind: 'add_liquidity';
  binId: number;
  amountX: bigint;
  amountY: bigint;
  rationale: string;
  estimated: boolean;
}

// Shaped multi-bin add (curve strategy). Carries the SHAPE (bin offsets relative
// to the active bin + per-offset weights) and the fraction of inventory to
// deploy; the primitive sizes the actual amounts from live balances at execution
// (after any withdraw in the same plan settles), like add_liquidity does.
export interface AddShapedLiquidityStep {
  kind: 'add_shaped_liquidity';
  offsets: number[];
  weights: number[];
  sizeFraction: number;
  // Fraction of the cash (quote) side to deploy as bids (M4 skew): 1 = full
  // two-sided curve, 0 = asks only (bids pulled). Base (V) always deploys fully.
  bidFraction: number;
  rationale: string;
  estimated: boolean;
}

export type PlanStep = WithdrawLiquidityStep | SwapStep | AddLiquidityStep | AddShapedLiquidityStep;

export interface RebalancePlan {
  poolId: string;
  type: 'reposition' | 'within_bin';
  reason: string;
  targetBinId: number;
  steps: PlanStep[];
  notes: string[];
  inventoryBlocked: boolean;
  inventoryRebalanceOnly: boolean;
}

const describeStep = (step: PlanStep): string => {
  switch (step.kind) {
    case 'withdraw_liquidity':
      return `withdraw_liquidity bins=[${step.binIds.join(',')}]`;
    case 'swap':
      return `swap sell=${step.sell} amount_in=${microToString(step.amountIn, sideDecimals(step.sell))} crossed_bins=${step.crossedBins}`;
    case 'add_liquidity':
      return `add_liquidity bin=${step.binId} x=${microToString(step.amountX)} y=${microToString(step.amountY)}`;
    case 'add_shaped_liquidity':
      return `add_shaped_liquidity offsets=[${step.offsets.join(',')}] size_fraction=${step.sizeFraction} bid_fraction=${step.bidFraction}`;
    default:
      return 'unknown_step';
  }
};

export const logPlan = (plan: RebalancePlan): void => {
  logInfo(
    `[${TAG}] plan type=${plan.type} target_bin=${plan.targetBinId} steps=${plan.steps.length} reason="${plan.reason}"`,
  );
  plan.steps.forEach((step, i) => {
    logInfo(
      `[${TAG}] step ${i + 1}/${plan.steps.length} ${describeStep(step)} estimated=${step.estimated} -- ${step.rationale}`,
    );
  });
  plan.notes.forEach((note) => logInfo(`[${TAG}] note: ${note}`));
};

export const executePlan = async (
  plan: RebalancePlan,
  preflight?: Preflight,
): Promise<PrimitiveResult[]> => {
  const results: PrimitiveResult[] = [];

  if (preflight) {
    const unimplemented = plan.steps
      .map((s) => s.kind)
      .filter((kind) => !IMPLEMENTED_STEPS.has(kind));
    if (unimplemented.length > 0) {
      logWarn(
        `[${TAG}] GUARDRAIL plan_has_unimplemented_steps steps=[${unimplemented.join(',')}] -> no live execution`,
      );
      return results;
    }
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    // Each step is a separate transaction, so consume a fresh nonce per step.
    const ctx: ExecutionContext | undefined = preflight
      ? { address: preflight.address, nonce: preflight.nonce + i, fee: preflight.fee }
      : undefined;

    let result: PrimitiveResult;
    switch (step.kind) {
      case 'withdraw_liquidity':
        result = await withdrawLiquidity(plan.poolId, step.binIds, ctx);
        break;
      case 'swap':
        result = await swap(plan.poolId, step.sell, step.amountIn, ctx, Math.max(1, step.crossedBins));
        break;
      case 'add_liquidity':
        result = await addLiquidity(plan.poolId, step.binId, step.amountX, step.amountY, ctx);
        break;
      case 'add_shaped_liquidity':
        result = await addShapedLiquidity(
          plan.poolId,
          step.offsets,
          step.weights,
          step.sizeFraction,
          step.bidFraction,
          ctx,
        );
        break;
      default:
        result = { ok: false, submitted: false, txId: '', note: 'unknown_step' };
    }
    results.push(result);
    logInfo(
      `[${TAG}] step ${i + 1}/${plan.steps.length} ${step.kind} tx=${result.txId || 'none'} ok=${result.ok} status="${result.note}"`,
    );
    if (preflight && result.ok && !result.submitted) {
      logWarn(
        `[${TAG}] step ${i + 1}/${plan.steps.length} ${step.kind} reported ok but did not broadcast (stub); stopping plan to avoid a nonce gap`,
      );
      break;
    }
    if (!result.ok) break;
  }
  return results;
};
