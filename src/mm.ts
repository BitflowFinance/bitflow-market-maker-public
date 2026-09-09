import { existsSync } from 'fs';
import { CONFIG } from './config';
import { logInfo, logWarn } from './logger';
import { getPoolSnapshot, PoolSnapshot } from './bitflow';
import { RebalancePlan, executePlan, logPlan } from './plan';
import { withdrawLiquidity } from './primitives';
import { microToString } from './stacks';
import { preflight } from './wallet';
import { Decision, computeImbalanceBps, driftBps } from './strategy/strategy';
import { resolvePlugins } from './registry';

const TAG = 'mm';

const { feed, strategy } = resolvePlugins(CONFIG.POOL_STRATEGY);

export { computeImbalanceBps, driftBps };
export type { Decision };
export type { TargetBin } from './strategy/strategy';

export interface TickResult {
  tickId: number;
  poolId: string;
  activeBinId: number;
  targetBinId: number | null;
  binOffset: number | null;
  quotePerBase: number | null;
  activeBinPrice: number;
  targetBinPrice: number | null;
  activeBinQuote: bigint;
  activeBinBase: bigint;
  imbalanceBps: number;
  decision: Decision;
  reason?: string;
  plan?: RebalancePlan;
  executed: boolean;
  durationSeconds: number;
  walletQuote?: bigint;
  walletBase?: bigint;
  ownedQuote?: bigint;
  ownedBase?: bigint;
  feesPaidUstx?: bigint;
  signals?: Record<string, number>;
}

export interface RuntimeState {
  consecutiveApiErrors: number;
  breakerTripped: boolean;
  killSwitch: boolean;
}

interface Sides {
  quote: bigint;
  base: bigint;
  walletQuote: bigint;
  walletBase: bigint;
  ownedQuote: bigint;
  ownedBase: bigint;
  baseIsX: boolean;
  // STX available for gas. When one pool side IS the STX token (STX/USDCx) it's
  // that side's wallet balance; for sBTC/USDCx it's unknown from the snapshot
  // (-1), so the cheap pre-preflight gas check is skipped.
  gasStx: bigint;
}

const resolveSides = (snapshot: PoolSnapshot): Sides => {
  const baseIsX =
    Boolean(CONFIG.BASE_TOKEN_CONTRACT) && snapshot.tokenX.contract === CONFIG.BASE_TOKEN_CONTRACT;
  const sides = baseIsX
    ? {
        quote: snapshot.activeBinReserveY,
        base: snapshot.activeBinReserveX,
        walletQuote: snapshot.walletY,
        walletBase: snapshot.walletX,
        ownedQuote: snapshot.ownedReserveY,
        ownedBase: snapshot.ownedReserveX,
        baseIsX,
      }
    : {
        quote: snapshot.activeBinReserveX,
        base: snapshot.activeBinReserveY,
        walletQuote: snapshot.walletX,
        walletBase: snapshot.walletY,
        ownedQuote: snapshot.ownedReserveX,
        ownedBase: snapshot.ownedReserveY,
        baseIsX,
      };

  const baseContract = baseIsX ? snapshot.tokenX.contract : snapshot.tokenY.contract;
  const quoteContract = baseIsX ? snapshot.tokenY.contract : snapshot.tokenX.contract;
  const stxToken = CONFIG.STX_TOKEN_CONTRACT;
  const gasStx =
    stxToken && quoteContract === stxToken
      ? sides.walletQuote
      : stxToken && baseContract === stxToken
        ? sides.walletBase
        : BigInt(-1);

  return { ...sides, gasStx };
};

let tickCounter = 0;

const emptyResult = (
  tickId: number,
  startMs: number,
  decision: Decision,
  reason: string,
): TickResult => ({
  tickId,
  poolId: CONFIG.POOL_ID,
  activeBinId: -1,
  targetBinId: null,
  binOffset: null,
  quotePerBase: null,
  activeBinPrice: 0,
  targetBinPrice: null,
  activeBinQuote: BigInt(0),
  activeBinBase: BigInt(0),
  imbalanceBps: 0,
  decision,
  reason,
  executed: false,
  durationSeconds: Number(((Date.now() - startMs) / 1000).toFixed(2)),
});

let consecutiveApiErrors = 0;
let breakerTripped = false;
let lastKnownOwnedBinIds: number[] = [];

export const nextBreakerCount = (current: number, ok: boolean): number =>
  ok ? 0 : current + 1;

export const isBreakerTripped = (count: number, max: number): boolean =>
  max > 0 && count >= max;

export const wouldParkOffActive = (binOffset: number | null, hasSwap: boolean): boolean =>
  binOffset !== null && binOffset !== 0 && !hasSwap;

export const killSwitchActive = (): boolean => {
  if (CONFIG.KILL_SWITCH) return true;
  if (CONFIG.KILL_SWITCH_FILE && existsSync(CONFIG.KILL_SWITCH_FILE)) return true;
  return false;
};

export const getRuntimeState = (): RuntimeState => ({
  consecutiveApiErrors,
  breakerTripped,
  killSwitch: killSwitchActive(),
});

const emergencyWithdrawAll = async (poolId: string): Promise<void> => {
  if (!CONFIG.BREAKER_WITHDRAW_ALL) return;
  if (CONFIG.EXECUTION_MODE !== 'live') {
    logWarn(`[${TAG}] breaker withdraw_all skipped (mode=${CONFIG.EXECUTION_MODE})`);
    return;
  }
  if (lastKnownOwnedBinIds.length === 0) {
    logWarn(`[${TAG}] breaker withdraw_all: no known owned bins to withdraw`);
    return;
  }
  try {
    const pf = await preflight();
    const ctx = { address: pf.address, nonce: pf.nonce, fee: pf.fee };
    const res = await withdrawLiquidity(poolId, lastKnownOwnedBinIds, ctx);
    logWarn(
      `[${TAG}] breaker withdraw_all bins=[${lastKnownOwnedBinIds.join(',')}] ok=${res.ok} status="${res.note}" tx=${res.txId || 'none'}`,
    );
  } catch (err) {
    logWarn(`[${TAG}] breaker withdraw_all failed error="${(err as Error).message}"`);
  }
};

const executeGuardedPlan = async (
  plan: RebalancePlan,
  gasStx: bigint,
): Promise<{ decision: Decision; reason?: string; executed: boolean; feesPaidUstx: bigint }> => {
  if (CONFIG.EXECUTION_MODE === 'live') {
    const minGas = BigInt(CONFIG.MIN_TX_FEE_USTX);
    if (gasStx >= BigInt(0) && gasStx < minGas) {
      const reason = `wallet_stx=${microToString(gasStx)} below min tx fee=${microToString(minGas)}; top up STX before rebalancing`;
      logWarn(`[${TAG}] GUARDRAIL low_gas ${reason} -> hold`);
      return { decision: 'hold', reason, executed: false, feesPaidUstx: BigInt(0) };
    }
  }
  logPlan(plan);
  if (CONFIG.EXECUTION_MODE !== 'live') {
    logInfo(`[${TAG}] dry_run: plan logged, no transactions sent`);
    return { decision: 'rebalance', executed: false, feesPaidUstx: BigInt(0) };
  }
  try {
    const pf = await preflight();
    const estTotalFees = pf.fee * BigInt(plan.steps.length);
    if (pf.missingNonces.length > 0) {
      const reason = `nonce gap detected (missing [${pf.missingNonces.join(',')}]); holding until cleared`;
      logWarn(`[${TAG}] GUARDRAIL nonce_gap ${reason} -> hold`);
      return { decision: 'hold', reason, executed: false, feesPaidUstx: BigInt(0) };
    }
    if (pf.mempoolPending) {
      const reason = `a prior tx is still pending in the mempool; holding to avoid piling up nonces`;
      logWarn(`[${TAG}] GUARDRAIL pending_tx ${reason} -> hold`);
      return { decision: 'hold', reason, executed: false, feesPaidUstx: BigInt(0) };
    }
    if (pf.stxBalance < estTotalFees) {
      const reason = `wallet_stx=${microToString(pf.stxBalance)} cannot cover ${plan.steps.length}-step fees (~${microToString(estTotalFees)}); top up STX`;
      logWarn(`[${TAG}] GUARDRAIL low_gas_multistep ${reason} -> hold`);
      return { decision: 'hold', reason, executed: false, feesPaidUstx: BigInt(0) };
    }
    const results = await executePlan(plan, pf);
    const executed = results.length > 0 && results.every((r) => r.ok);
    const feesPaidUstx = results.reduce((sum, r) => sum + (r.feeUstx ?? BigInt(0)), BigInt(0));
    logInfo(`[${TAG}] plan_executed steps=${results.length} ok=${executed}`);
    return { decision: 'rebalance', executed, feesPaidUstx };
  } catch (err) {
    logWarn(`[${TAG}] GUARDRAIL preflight_failed error="${(err as Error).message}" -> no execution`);
    return { decision: 'hold', reason: 'preflight_failed', executed: false, feesPaidUstx: BigInt(0) };
  }
};

const recordApiError = async (poolId: string, reason: string): Promise<void> => {
  consecutiveApiErrors = nextBreakerCount(consecutiveApiErrors, false);
  const max = CONFIG.MAX_CONSECUTIVE_API_ERRORS;
  logWarn(
    `[${TAG}] GUARDRAIL api_error count=${consecutiveApiErrors}/${max || 'off'} reason="${reason}"`,
  );
  if (isBreakerTripped(consecutiveApiErrors, max) && !breakerTripped) {
    breakerTripped = true;
    logWarn(
      `[${TAG}] GUARDRAIL circuit_breaker TRIPPED after ${consecutiveApiErrors} consecutive API errors -> freezing all actions`,
    );
    await emergencyWithdrawAll(poolId);
  }
};

const resetApiErrors = (): void => {
  if (consecutiveApiErrors > 0 || breakerTripped) {
    logInfo(
      `[${TAG}] api_recovered after ${consecutiveApiErrors} consecutive errors; circuit breaker cleared`,
    );
  }
  consecutiveApiErrors = 0;
  breakerTripped = false;
};

export const runTick = async (): Promise<TickResult> => {
  const tickId = ++tickCounter;
  const startMs = Date.now();
  logInfo(`[${TAG}] tick_start id=${tickId} mode="${CONFIG.EXECUTION_MODE}" pool="${CONFIG.POOL_ID}"`);

  if (!CONFIG.POOL_ID) {
    logWarn(`[${TAG}] POOL_ID unset; nothing to do`);
    const result = emptyResult(tickId, startMs, 'no_data', 'pool_id_unset');
    logInfo(`[${TAG}] tick_end id=${tickId} decision="no_data" duration="${result.durationSeconds}s"`);
    return result;
  }

  if (killSwitchActive()) {
    const via = CONFIG.KILL_SWITCH ? 'KILL_SWITCH=true' : `file ${CONFIG.KILL_SWITCH_FILE}`;
    logWarn(`[${TAG}] GUARDRAIL kill_switch active (${via}) -> frozen, no actions`);
    const result = emptyResult(tickId, startMs, 'frozen', 'kill_switch');
    logInfo(`[${TAG}] tick_end id=${tickId} decision="frozen" duration="${result.durationSeconds}s"`);
    return result;
  }

  const feedOutcome = feed
    .read()
    .then((reading) => ({ ok: true as const, reading }))
    .catch((err) => ({ ok: false as const, error: (err as Error).message }));

  let snapshot: PoolSnapshot;
  let feedRes: Awaited<typeof feedOutcome>;
  try {
    [snapshot, feedRes] = await Promise.all([
      getPoolSnapshot(CONFIG.POOL_ID, CONFIG.SIGNER_ADDRESS),
      feedOutcome,
    ]);
  } catch (err) {
    const message = (err as Error).message;
    await recordApiError(CONFIG.POOL_ID, `snapshot_fetch_failed: ${message}`);
    const result = emptyResult(tickId, startMs, 'frozen', `snapshot_fetch_failed: ${message}`);
    logInfo(`[${TAG}] tick_end id=${tickId} decision="frozen" duration="${result.durationSeconds}s"`);
    return result;
  }

  lastKnownOwnedBinIds = snapshot.ownedBinIds;

  const { quote, base, walletQuote, walletBase, ownedQuote, ownedBase, gasStx } =
    resolveSides(snapshot);

  if (
    CONFIG.BASE_TOKEN_CONTRACT &&
    snapshot.tokenX.contract !== CONFIG.BASE_TOKEN_CONTRACT &&
    snapshot.tokenY.contract !== CONFIG.BASE_TOKEN_CONTRACT
  ) {
    logWarn(
      `[${TAG}] GUARDRAIL base_token_mismatch tokenX="${snapshot.tokenX.contract}" tokenY="${snapshot.tokenY.contract}" expected="${CONFIG.BASE_TOKEN_CONTRACT}" -> base/quote mapping may be wrong`,
    );
  }

  const qLabel = CONFIG.QUOTE_ASSET_NAME;
  const bLabel = CONFIG.BASE_ASSET_NAME;
  const qFmt = (v: bigint): string => microToString(v, CONFIG.QUOTE_DECIMALS);
  const bFmt = (v: bigint): string => microToString(v, CONFIG.BASE_DECIMALS);
  logInfo(
    `[${TAG}] active_bin id=${snapshot.activeBinId} bin_step=${snapshot.binStep} ${qLabel}=${qFmt(quote)} ${bLabel}=${bFmt(base)} active_bin_price=${snapshot.activeBinPrice.toFixed(6)}`,
  );
  logInfo(
    `[${TAG}] wallet ${qLabel}=${qFmt(walletQuote)} ${bLabel}=${bFmt(walletBase)} owned_bins=${snapshot.ownedBinCount}`,
  );

  if (!snapshot.poolActive) {
    logWarn(`[${TAG}] GUARDRAIL pool_inactive pool="${snapshot.poolId}" -> hold (not trading)`);
    const durationSeconds = Number(((Date.now() - startMs) / 1000).toFixed(2));
    logInfo(`[${TAG}] tick_end id=${tickId} decision="hold" duration="${durationSeconds}s"`);
    return {
      tickId,
      poolId: snapshot.poolId,
      activeBinId: snapshot.activeBinId,
      targetBinId: null,
      binOffset: null,
      quotePerBase: null,
      activeBinPrice: snapshot.activeBinPrice,
      targetBinPrice: null,
      activeBinQuote: quote,
      activeBinBase: base,
      imbalanceBps: 0,
      decision: 'hold',
      reason: 'pool_inactive',
      executed: false,
      durationSeconds,
      walletQuote,
      walletBase,
      ownedQuote,
      ownedBase,
    };
  }

  if (!feedRes.ok) {
    logWarn(
      `[${TAG}] GUARDRAIL peg_unavailable error="${feedRes.error}" -> frozen, no rebalance this tick`,
    );
    await recordApiError(CONFIG.POOL_ID, `peg_unavailable: ${feedRes.error}`);
    const result = emptyResult(tickId, startMs, 'frozen', `peg_unavailable: ${feedRes.error}`);
    result.activeBinId = snapshot.activeBinId;
    result.activeBinPrice = snapshot.activeBinPrice;
    result.activeBinQuote = quote;
    result.activeBinBase = base;
    logInfo(`[${TAG}] tick_end id=${tickId} decision="frozen" duration="${result.durationSeconds}s"`);
    return result;
  }

  resetApiErrors();

  const reading = feedRes.reading;
  const decimalFactor = Math.pow(10, CONFIG.QUOTE_DECIMALS - CONFIG.BASE_DECIMALS);
  const quotePerBase = (reading.reference?.price ?? 0) * decimalFactor;

  logInfo(`[${TAG}] conversion=swap_only (rebalance via pool swaps)`);

  const dec = strategy.decide({
    poolId: snapshot.poolId,
    activeBinId: snapshot.activeBinId,
    activeBinPrice: snapshot.activeBinPrice,
    ladder: snapshot.priceLadder,
    ownedBinIds: snapshot.ownedBinIds,
    binBase: base,
    binQuote: quote,
    walletBase,
    walletQuote,
    ownedBase,
    ownedQuote,
    reading,
  });

  for (const entry of dec.logs) {
    if (entry.level === 'warn') logWarn(`[${TAG}] ${entry.msg}`);
    else logInfo(`[${TAG}] ${entry.msg}`);
  }

  let decision: Decision = dec.decision;
  let reason: string | undefined = dec.reason;
  const plan: RebalancePlan | undefined = dec.plan;
  let executed = false;
  let feesPaidUstx = BigInt(0);

  if (dec.halt) {
    decision = 'frozen';
    reason = `${dec.halt.kind}: ${dec.halt.reason}`;
    logWarn(
      `[${TAG}] GUARDRAIL strategy_halt kind=${dec.halt.kind} reason="${dec.halt.reason}" -> withdraw all + frozen`,
    );
    await emergencyWithdrawAll(snapshot.poolId);
  } else if (dec.plan) {
    const guarded = await executeGuardedPlan(dec.plan, gasStx);
    decision = guarded.decision;
    if (guarded.reason) reason = guarded.reason;
    executed = guarded.executed;
    feesPaidUstx = guarded.feesPaidUstx;
  }

  const durationSeconds = Number(((Date.now() - startMs) / 1000).toFixed(2));
  logInfo(`[${TAG}] tick_end id=${tickId} decision="${decision}" duration="${durationSeconds}s"`);

  return {
    tickId,
    poolId: snapshot.poolId,
    activeBinId: snapshot.activeBinId,
    targetBinId: dec.target ? dec.target.binId : null,
    binOffset: dec.binOffset,
    quotePerBase,
    activeBinPrice: snapshot.activeBinPrice,
    targetBinPrice: dec.target ? dec.target.price : null,
    activeBinQuote: quote,
    activeBinBase: base,
    imbalanceBps: dec.activeBinImbalanceBps,
    decision,
    reason,
    plan,
    executed,
    durationSeconds,
    walletQuote,
    walletBase,
    ownedQuote,
    ownedBase,
    feesPaidUstx,
    signals: dec.signals,
  };
};
