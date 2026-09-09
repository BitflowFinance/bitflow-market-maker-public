// DLMM swaps via dlmm-swap-router-v-1-2 swap-simple-multi. Used to walk the
// active bin toward the target by selling one side; max-steps caps how many
// bins the swap may cross. No NFTs are involved, so this stays on v6.
import {
  FungibleConditionCode,
  PostCondition,
  PostConditionMode,
  contractPrincipalCV,
  createAssetInfo,
  makeContractFungiblePostCondition,
  makeContractSTXPostCondition,
  makeStandardFungiblePostCondition,
  makeStandardSTXPostCondition,
  noneCV,
  someCV,
  uintCV,
} from '@stacks/transactions';
import { LadderBin, PRICE_SCALE, fetchPoolBins, fetchQuotesPool } from './bitflow';
import { CONFIG } from './config';
import { TokenRef, poolRef } from './liquidity';
import { microToString, parseContract } from './stacks';
import { ContractCall } from './wallet';

// Neutral pool roles: base = the quoted asset, quote = the numeraire.
// Native-STX handling (post-conditions) is keyed off the token contract via
// isStx, not the side name.
export type SwapSide = 'base' | 'quote';

const cp = (contract: string) => {
  const { address, name } = parseContract(contract);
  return contractPrincipalCV(address, name);
};

const sellContract = (side: SwapSide): string =>
  side === 'base' ? CONFIG.BASE_TOKEN_CONTRACT : CONFIG.QUOTE_TOKEN_CONTRACT;

// Decimals of a side, for readable log amounts (base/quote may differ, e.g.
// sBTC 8 / USDCx 6).
export const sideDecimals = (side: SwapSide): number =>
  side === 'base' ? CONFIG.BASE_DECIMALS : CONFIG.QUOTE_DECIMALS;

// The side received when selling `side`.
const otherSide = (side: SwapSide): SwapSide => (side === 'base' ? 'quote' : 'base');

export interface SwapEstimate {
  expectedOut: bigint;
  binsTouched: number;
  amountConsumed: bigint;
}

// Walks the price ladder from the active bin, draining each crossed bin's
// opposite-side reserve until the input is spent or max-steps bins are touched.
// x-for-y (selling X) moves the active bin down; y-for-x moves it up. Fees are
// ignored, so the result is a slight over-estimate -- slippage covers the gap.
export const estimateSwapOutput = (
  ladder: LadderBin[],
  activeBinId: number,
  xForY: boolean,
  amountIn: bigint,
  maxSteps: number,
): SwapEstimate => {
  const byId = new Map<number, LadderBin>();
  for (const b of ladder) byId.set(b.binId, b);

  let remaining = Number(amountIn);
  let out = 0;
  let touched = 0;
  let binId = activeBinId;

  while (remaining > 0 && touched < maxSteps) {
    const bin = byId.get(binId);
    if (!bin || bin.price <= 0) break;
    touched += 1;

    if (xForY) {
      const binY = Number(bin.reserveY);
      const maxIn = binY / bin.price; // X needed to drain this bin's Y
      if (remaining <= maxIn) {
        out += remaining * bin.price;
        remaining = 0;
        break;
      }
      out += binY;
      remaining -= maxIn;
      binId -= 1;
    } else {
      const binX = Number(bin.reserveX);
      const maxIn = binX * bin.price; // Y needed to drain this bin's X
      if (remaining <= maxIn) {
        out += remaining / bin.price;
        remaining = 0;
        break;
      }
      out += binX;
      remaining -= maxIn;
      binId += 1;
    }
  }

  return {
    expectedOut: BigInt(Math.floor(out)),
    binsTouched: touched,
    amountConsumed: BigInt(Math.floor(Number(amountIn) - remaining)),
  };
};

const outflowPc = (token: TokenRef, signer: string, amount: bigint): PostCondition => {
  if (token.isStx) {
    return makeStandardSTXPostCondition(signer, FungibleConditionCode.LessEqual, amount);
  }
  const { address, name } = parseContract(token.contract);
  return makeStandardFungiblePostCondition(
    signer,
    FungibleConditionCode.LessEqual,
    amount,
    createAssetInfo(address, name, token.assetName),
  );
};

// The pool sends us the output token (native STX or the SIP-010). Deny mode
// requires this transfer to be covered; min-received is the contract floor, so
// the pool is guaranteed to send at least that.
const inflowPc = (token: TokenRef, poolContract: string, amount: bigint): PostCondition => {
  const pool = parseContract(poolContract);
  if (token.isStx) {
    return makeContractSTXPostCondition(
      pool.address,
      pool.name,
      FungibleConditionCode.GreaterEqual,
      amount,
    );
  }
  const t = parseContract(token.contract);
  return makeContractFungiblePostCondition(
    pool.address,
    pool.name,
    FungibleConditionCode.GreaterEqual,
    amount,
    createAssetInfo(t.address, t.name, token.assetName),
  );
};

export interface SwapPlan {
  poolContract: string;
  xToken: string;
  yToken: string;
  amountIn: bigint;
  minReceived: bigint;
  xForY: boolean;
  maxSteps: number;
  deadline?: number;
}

// NOTE: the router's swap-simple-multi is broken on-chain (its fold calls
// swap-x-for-y-simple-range-multi with the pre-deadline arity and reverts with
// IncorrectArgumentCount). We only need a single pool/direction anyway, so we
// call the direction-specific range-multi entrypoints directly.
export const buildSwapCall = (plan: SwapPlan, signer: string): ContractCall => {
  const pool = poolRef(plan.poolContract, plan.xToken, plan.yToken);
  const inputToken = plan.xForY ? pool.x : pool.y;
  const outputToken = plan.xForY ? pool.y : pool.x;

  return {
    contract: CONFIG.SWAP_ROUTER_CONTRACT,
    functionName: plan.xForY
      ? 'swap-x-for-y-simple-range-multi'
      : 'swap-y-for-x-simple-range-multi',
    functionArgs: [
      cp(plan.poolContract),
      cp(plan.xToken),
      cp(plan.yToken),
      uintCV(plan.amountIn),
      uintCV(plan.minReceived),
      uintCV(plan.maxSteps),
      plan.deadline ? someCV(uintCV(plan.deadline)) : noneCV(),
    ],
    postConditions: [
      outflowPc(inputToken, signer, plan.amountIn),
      inflowPc(outputToken, plan.poolContract, plan.minReceived),
    ],
    postConditionMode:
      CONFIG.SWAP_POST_CONDITION_MODE === 'allow' ? PostConditionMode.Allow : PostConditionMode.Deny,
  };
};

const deadline = (): number => Math.floor(Date.now() / 1000) + CONFIG.TX_DEADLINE_SECONDS;

export interface PreparedSwap {
  call: ContractCall;
  summary: string;
}

export interface SwapRequest {
  poolId: string;
  signer: string;
  sell: SwapSide;
  amountIn: bigint;
  maxSteps?: number;
  minReceived?: bigint;
}

export const prepareSwap = async (req: SwapRequest): Promise<PreparedSwap> => {
  const [quotes, binsRes] = await Promise.all([
    fetchQuotesPool(req.poolId),
    fetchPoolBins(req.poolId),
  ]);

  const activeBin = Number(quotes.active_bin);
  const xForY = sellContract(req.sell) === quotes.token_x;
  const maxSteps = Math.min(319, Math.max(1, req.maxSteps ?? CONFIG.SWAP_MAX_STEPS));

  const ladder: LadderBin[] = (binsRes.bins || [])
    .map((b) => ({
      binId: Number(b.bin_id),
      price: Number(b.price) / PRICE_SCALE,
      reserveX: BigInt(String(b.reserve_x ?? '0').split('.')[0] || '0'),
      reserveY: BigInt(String(b.reserve_y ?? '0').split('.')[0] || '0'),
    }))
    .filter((b) => Number.isFinite(b.binId) && b.price > 0)
    .sort((a, b) => a.binId - b.binId);

  const estimate = estimateSwapOutput(ladder, activeBin, xForY, req.amountIn, maxSteps);
  const slippageMult = 1 - CONFIG.SWAP_SLIPPAGE_BPS / 10000;
  const minReceived =
    req.minReceived ?? BigInt(Math.floor(Number(estimate.expectedOut) * slippageMult));

  const call = buildSwapCall(
    {
      poolContract: quotes.pool_token,
      xToken: quotes.token_x,
      yToken: quotes.token_y,
      amountIn: req.amountIn,
      minReceived,
      xForY,
      maxSteps,
      deadline: deadline(),
    },
    req.signer,
  );

  const recv = otherSide(req.sell);
  const summary =
    `swap sell=${req.sell} amount=${microToString(req.amountIn, sideDecimals(req.sell))} x_for_y=${xForY} ` +
    `max_steps=${maxSteps} est_out_${recv}=${microToString(estimate.expectedOut, sideDecimals(recv))} ` +
    `min_received=${microToString(minReceived, sideDecimals(recv))} est_bins=${estimate.binsTouched} ` +
    `pc_mode=${CONFIG.SWAP_POST_CONDITION_MODE}`;
  return { call, summary };
};
