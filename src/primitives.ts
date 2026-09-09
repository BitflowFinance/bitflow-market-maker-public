import { CONFIG } from './config';
import {
  LiquidityCall,
  broadcastLiquidity,
  prepareAddLiquidityAuto,
  prepareShapedAddLiquidity,
  prepareWithdrawLiquidity,
} from './liquidity';
import { logInfo, logWarn } from './logger';
import { microToString } from './stacks';
import { SwapSide, prepareSwap, sideDecimals } from './swap';
import {
  AccountBalances,
  ContractCall,
  ExecutionContext,
  SubmitResult,
  getAccountBalances,
  signAndBroadcast,
  submitWithConfirmation,
} from './wallet';

const TAG = 'primitive';

export interface PrimitiveResult {
  ok: boolean;
  submitted: boolean;
  txId: string;
  note: string;
  // Gas actually paid (micro-STX), including replace-by-fee bumps. Only set when
  // a tx was broadcast; absent for stubs/short-circuits.
  feeUstx?: bigint;
}

// Logs the intended call without broadcasting and returns a non-submitted stub
// so the executor skips confirmation polling. Hit in dry-run (no ctx/key) or
// when the action's feature flag is off -- not because a tx builder is missing
// (every primitive has one).
const stub = (action: string, detail: string, ctx?: ExecutionContext): PrimitiveResult => {
  const ctxStr = ctx ? ` nonce=${ctx.nonce} fee=${microToString(ctx.fee)}` : '';
  logInfo(`[${TAG}] ${action} ${detail}${ctxStr} status="stub" (dry-run or action disabled)`);
  return { ok: true, submitted: false, txId: `stub-${action}`, note: 'not_broadcast' };
};

// Turns a confirmed/failed SubmitResult into a PrimitiveResult. ok=true only
// when the tx actually reached 'success' on chain; a timeout or abort is ok=false
// so the executor stops and the tick is reported as failed.
const settle = (action: string, detail: string, res: SubmitResult): PrimitiveResult => {
  const bumpStr = res.bumps > 0 ? ` rbf_bumps=${res.bumps}` : '';
  const line = `[${TAG}] ${action} ${detail} tx=${res.txId} fee=${microToString(res.fee)}${bumpStr} status="${res.status}"`;
  if (res.ok) {
    logInfo(line);
    return { ok: true, submitted: true, txId: res.txId, note: res.status, feeUstx: res.fee };
  }
  logWarn(line);
  return { ok: false, submitted: true, txId: res.txId, note: res.status, feeUstx: res.fee };
};

const broadcast = async (
  action: string,
  detail: string,
  call: ContractCall,
  ctx: ExecutionContext,
): Promise<PrimitiveResult> => {
  try {
    const res = await submitWithConfirmation(
      (fee) => signAndBroadcast(call, { ...ctx, fee }),
      ctx.fee,
      `${action} ${detail} nonce=${ctx.nonce}`,
    );
    return settle(action, detail, res);
  } catch (err) {
    return failure(action, err);
  }
};

// Liquidity txs are built and signed by the v7 path (NFT maybe-sent PCs), so
// they broadcast via broadcastLiquidity instead of signAndBroadcast.
const broadcastV7 = async (
  action: string,
  detail: string,
  call: LiquidityCall,
  ctx: ExecutionContext,
): Promise<PrimitiveResult> => {
  try {
    const res = await submitWithConfirmation(
      (fee) => broadcastLiquidity(call, { ...ctx, fee }),
      ctx.fee,
      `${action} ${detail} nonce=${ctx.nonce}`,
    );
    return settle(action, detail, res);
  } catch (err) {
    return failure(action, err);
  }
};

const failure = (action: string, err: unknown): PrimitiveResult => {
  const message = (err as Error).message;
  logWarn(`[${TAG}] ${action} failed error="${message}"`);
  return { ok: false, submitted: false, txId: '', note: message };
};

// STX we can spend without dipping into the gas reserve or this tx's fee.
const spendableStx = (balances: AccountBalances, ctx: ExecutionContext): bigint => {
  const reserve = BigInt(CONFIG.STX_GAS_RESERVE_USTX) + ctx.fee;
  return balances.stx > reserve ? balances.stx - reserve : BigInt(0);
};

const clamp = (want: bigint, available: bigint): bigint => (want < available ? want : available);

// Spendable balance of an arbitrary token side. A side whose contract is the STX
// wrapper resolves to the native STX balance and keeps the gas reserve + this
// tx's fee in hand (it IS the gas tank); any other token returns its full
// balance (gas is a separate asset for those pools).
const sideSpendable = (
  balances: AccountBalances,
  contract: string,
  assetName: string,
  ctx: ExecutionContext,
): bigint => {
  if (contract === CONFIG.STX_TOKEN_CONTRACT) return spendableStx(balances, ctx);
  return balances.tokens[`${contract}::${assetName}`]?.balance ?? BigInt(0);
};

// Contract + SIP-010 asset name of a swap side (base = quoted asset, quote =
// numeraire). Native STX needs no asset name -- balance and post-conditions
// key off the STX contract via isStx, not the asset name.
const sideRef = (side: SwapSide): { contract: string; assetName: string } =>
  side === 'base'
    ? { contract: CONFIG.BASE_TOKEN_CONTRACT, assetName: CONFIG.BASE_ASSET_NAME }
    : { contract: CONFIG.QUOTE_TOKEN_CONTRACT, assetName: CONFIG.QUOTE_ASSET_NAME };

export const withdrawLiquidity = async (
  poolId: string,
  binIds: number[],
  ctx?: ExecutionContext,
): Promise<PrimitiveResult> => {
  const detail = `pool="${poolId}" bins=[${binIds.join(',')}]`;
  if (!ctx || !CONFIG.SIGNER_KEY) return stub('withdraw_liquidity', detail, ctx);
  if (!CONFIG.ENABLE_WITHDRAW_LIQUIDITY) {
    return stub('withdraw_liquidity', `${detail} (ENABLE_WITHDRAW_LIQUIDITY=false)`, ctx);
  }
  try {
    const prepared = await prepareWithdrawLiquidity({
      poolId,
      signer: ctx.address,
      binIds,
      percentage: 100,
    });
    return broadcastV7('withdraw_liquidity', prepared.summary, prepared.call, ctx);
  } catch (err) {
    return failure('withdraw_liquidity', err);
  }
};

// Sized from live wallet balances at execution time against the live active
// bin: by the time this runs prior withdraw/swap steps have confirmed, so the
// plan's pre-estimated amounts are only informational. The auto-sizer
// re-targets to the live active bin and always adds two-sided (offset 0).
export const addLiquidity = async (
  poolId: string,
  binId: number,
  amountX: bigint,
  amountY: bigint,
  ctx?: ExecutionContext,
): Promise<PrimitiveResult> => {
  const detail = `pool="${poolId}" bin=${binId} est_x=${microToString(amountX)} est_y=${microToString(amountY)}`;
  if (!ctx || !CONFIG.SIGNER_KEY) return stub('add_liquidity', detail, ctx);
  if (!CONFIG.ENABLE_ADD_LIQUIDITY) {
    return stub('add_liquidity', `${detail} (ENABLE_ADD_LIQUIDITY=false)`, ctx);
  }
  try {
    const balances = await getAccountBalances(ctx.address);
    const baseAvailable = sideSpendable(
      balances,
      CONFIG.BASE_TOKEN_CONTRACT,
      CONFIG.BASE_ASSET_NAME,
      ctx,
    );
    const quoteAvailable = sideSpendable(
      balances,
      CONFIG.QUOTE_TOKEN_CONTRACT,
      CONFIG.QUOTE_ASSET_NAME,
      ctx,
    );
    if (baseAvailable <= BigInt(0) && quoteAvailable <= BigInt(0)) {
      return { ok: false, submitted: false, txId: '', note: 'no_inventory_to_add' };
    }
    const prepared = await prepareAddLiquidityAuto({
      poolId,
      signer: ctx.address,
      binId,
      baseAvailable,
      quoteAvailable,
    });
    return broadcastV7('add_liquidity', prepared.summary, prepared.call, ctx);
  } catch (err) {
    return failure('add_liquidity', err);
  }
};

// Shaped multi-bin add (curve strategy). Sizes from live balances at execution
// (so a withdraw earlier in the same plan has settled), deploying sizeFraction of
// each side across the curve and holding the rest in reserve. base/quote map to
// X/Y inside prepareShapedAddLiquidity via the pool's token order.
export const addShapedLiquidity = async (
  poolId: string,
  offsets: number[],
  weights: number[],
  sizeFraction: number,
  bidFraction: number,
  ctx?: ExecutionContext,
): Promise<PrimitiveResult> => {
  const detail = `pool="${poolId}" offsets=[${offsets.join(',')}] size_fraction=${sizeFraction} bid_fraction=${bidFraction}`;
  if (!ctx || !CONFIG.SIGNER_KEY) return stub('add_shaped_liquidity', detail, ctx);
  if (!CONFIG.ENABLE_ADD_LIQUIDITY) {
    return stub('add_shaped_liquidity', `${detail} (ENABLE_ADD_LIQUIDITY=false)`, ctx);
  }
  try {
    const balances = await getAccountBalances(ctx.address);
    const baseAvail = sideSpendable(balances, CONFIG.BASE_TOKEN_CONTRACT, CONFIG.BASE_ASSET_NAME, ctx);
    const quoteAvail = sideSpendable(balances, CONFIG.QUOTE_TOKEN_CONTRACT, CONFIG.QUOTE_ASSET_NAME, ctx);
    const frac = Math.min(1, Math.max(0, sizeFraction));
    // bidFrac may exceed 1 (M6 lean deploys more cash); the final cash amount is
    // clamped to what we actually hold below.
    const bidFrac = Math.max(0, bidFraction);
    // Base (V) always deploys as asks (no idle V); the cash (quote) side is scaled
    // by bidFrac so M4 can pull bids (hold cash) and M6 can lean into more bids.
    const baseDeploy = BigInt(Math.floor(Number(baseAvail) * frac));
    const quoteWanted = Math.floor(Number(quoteAvail) * frac * bidFrac);
    const quoteDeploy = BigInt(Math.min(Number(quoteAvail), Math.max(0, quoteWanted)));
    if (baseDeploy <= BigInt(0) && quoteDeploy <= BigInt(0)) {
      return { ok: false, submitted: false, txId: '', note: 'no_inventory_to_add' };
    }
    const prepared = await prepareShapedAddLiquidity({
      poolId,
      signer: ctx.address,
      offsets,
      weights,
      baseAvailable: baseDeploy,
      quoteAvailable: quoteDeploy,
    });
    return broadcastV7('add_shaped_liquidity', prepared.summary, prepared.call, ctx);
  } catch (err) {
    return failure('add_shaped_liquidity', err);
  }
};

export const swap = async (
  poolId: string,
  sell: SwapSide,
  amountIn: bigint,
  ctx?: ExecutionContext,
  maxSteps?: number,
): Promise<PrimitiveResult> => {
  const detail = `pool="${poolId}" sell=${sell} amount_in=${microToString(amountIn, sideDecimals(sell))}`;
  if (!ctx || !CONFIG.SIGNER_KEY) return stub('swap', detail, ctx);
  if (!CONFIG.ENABLE_SWAP) return stub('swap', `${detail} (ENABLE_SWAP=false)`, ctx);
  try {
    // Clamp the sold side to live wallet balance so the swap can't overspend.
    const balances = await getAccountBalances(ctx.address);
    const ref = sideRef(sell);
    const available = sideSpendable(balances, ref.contract, ref.assetName, ctx);
    const amount = clamp(amountIn, available);
    if (amount <= BigInt(0)) {
      return { ok: false, submitted: false, txId: '', note: `insufficient_${sell}_for_swap` };
    }
    const prepared = await prepareSwap({ poolId, signer: ctx.address, sell, amountIn: amount, maxSteps });
    return broadcast('swap', prepared.summary, prepared.call, ctx);
  } catch (err) {
    return failure('swap', err);
  }
};

