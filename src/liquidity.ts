// The DLMM liquidity calls use "maybe-sent" NFT post-conditions for the bin
// position NFTs (pool-token-id). That condition code (0x12) does not exist in
// @stacks/transactions v6, so this module builds, signs and broadcasts the
// liquidity transactions with v7 (aliased as stacks-tx-v7). The rest of the app
// stays on v6.
import {
  ClarityValue,
  Pc,
  PostCondition,
  broadcastTransaction,
  contractPrincipalCV,
  intCV,
  listCV,
  makeContractCall,
  noneCV,
  principalCV,
  someCV,
  tupleCV,
  uintCV,
} from 'stacks-tx-v7';
import {
  BIN_CENTER,
  PoolBin,
  PoolBinsResponse,
  UserBin,
  fetchPoolBins,
  fetchQuotesPool,
  fetchUserBins,
  userBinLiquidity,
} from './bitflow';
import { CONFIG } from './config';
import { logWarn } from './logger';
import { microToString, parseContract } from './stacks';
import { allocateCurve, CurveLeg } from './strategy/curveShape';
import { ExecutionContext } from './wallet';

const TAG = 'liquidity';

// Matches dlmm-core get-liquidity-value scaling (price is stored * 1e8) and the
// fee scaling (fees are expressed in 1e4 units).
const PRICE_SCALE_BPS = 1e8;
const FEE_SCALE_BPS = 1e4;

const toBig = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? '0').split('.')[0] || '0');
  } catch {
    return BigInt(0);
  }
};

const toNum = (value: unknown): number => Number(String(value ?? '0')) || 0;

const cp = (contract: string): ClarityValue => {
  const { address, name } = parseContract(contract);
  return contractPrincipalCV(address, name);
};

const contractId = (contract: string): `${string}.${string}` => {
  const { address, name } = parseContract(contract);
  return `${address}.${name}`;
};

// dlmm-core stores bin ids as signed ints (-500..500); the BFF reports the
// unsigned 0..1000 form, so shift by the center bin.
export const signedBinId = (unsignedBinId: number): number => unsignedBinId - BIN_CENTER;

export interface TokenRef {
  contract: string;
  isStx: boolean;
  assetName: string;
}

export interface LiquidityPoolRef {
  poolContract: string;
  x: TokenRef;
  y: TokenRef;
}

// SIP-010 asset name (the define-fungible-token name, which can differ from the
// contract name -- e.g. usdcx's asset is "usdcx-token"). Resolve from config by
// side so FT post-conditions reference the real asset; fall back to the contract
// name only for tokens we don't have configured.
const assetNameFor = (contract: string): string => {
  if (contract === CONFIG.BASE_TOKEN_CONTRACT) return CONFIG.BASE_ASSET_NAME;
  if (contract === CONFIG.QUOTE_TOKEN_CONTRACT) return CONFIG.QUOTE_ASSET_NAME;
  return parseContract(contract).name;
};

const tokenRef = (contract: string): TokenRef => ({
  contract,
  // token-stx-v-1-2 transfers move native STX, so it is asserted with STX
  // post-conditions rather than a fungible-token asset.
  isStx: contract === CONFIG.STX_TOKEN_CONTRACT,
  assetName: assetNameFor(contract),
});

export const poolRef = (poolContract: string, xToken: string, yToken: string): LiquidityPoolRef => ({
  poolContract,
  x: tokenRef(xToken),
  y: tokenRef(yToken),
});

export interface PoolFees {
  xProtocol: number;
  xProvider: number;
  xVariable: number;
  yProtocol: number;
  yProvider: number;
  yVariable: number;
}

export interface AddBinMath {
  isActiveBin: boolean;
  binPriceScaled: number;
  reserveX: number;
  reserveY: number;
  binShares: number;
  xAmount: number;
  yAmount: number;
}

export interface AddSlippage {
  minDlp: bigint;
  maxXFee: bigint;
  maxYFee: bigint;
}

// Port of Bitflow's reference calculate_min_dlp_for_bin: estimates the DLP
// (liquidity shares) the add will mint and the liquidity fees an unbalanced add
// to the active bin incurs, then applies slippage tolerance to derive the
// minimum DLP and maximum acceptable fees.
export const calcAddSlippage = (
  bin: AddBinMath,
  fees: PoolFees,
  slippageBps: number,
): AddSlippage => {
  const slippage = slippageBps / FEE_SCALE_BPS;
  const yAmountScaled = bin.yAmount * PRICE_SCALE_BPS;
  const reserveYScaled = bin.reserveY * PRICE_SCALE_BPS;

  const addValue = bin.binPriceScaled * bin.xAmount + yAmountScaled;
  const binValue = bin.binPriceScaled * bin.reserveX + reserveYScaled;

  const dlp =
    bin.binShares === 0 || binValue === 0
      ? Math.sqrt(addValue)
      : (addValue * bin.binShares) / binValue;

  let xFee = 0;
  let yFee = 0;
  if (bin.isActiveBin && dlp > 0) {
    const xLiquidityFee = fees.xProtocol + fees.xProvider + fees.xVariable;
    const yLiquidityFee = fees.yProtocol + fees.yProvider + fees.yVariable;
    const xWithdrawable = (dlp * (bin.reserveX + bin.xAmount)) / (bin.binShares + dlp);
    const yWithdrawable = (dlp * (bin.reserveY + bin.yAmount)) / (bin.binShares + dlp);
    if (yWithdrawable > bin.yAmount && bin.xAmount > xWithdrawable) {
      const maxXFee = ((bin.xAmount - xWithdrawable) * xLiquidityFee) / FEE_SCALE_BPS;
      xFee = bin.xAmount > maxXFee ? maxXFee : bin.xAmount;
    }
    if (xWithdrawable > bin.xAmount && bin.yAmount > yWithdrawable) {
      const maxYFee = ((bin.yAmount - yWithdrawable) * yLiquidityFee) / FEE_SCALE_BPS;
      yFee = bin.yAmount > maxYFee ? maxYFee : bin.yAmount;
    }
  }

  const xPostFees = bin.xAmount - xFee;
  const yPostFeesScaled = (bin.yAmount - yFee) * PRICE_SCALE_BPS;
  const reserveXPostFees = bin.reserveX + xFee;
  const reserveYPostFeesScaled = (bin.reserveY + yFee) * PRICE_SCALE_BPS;

  const addValuePostFees = bin.binPriceScaled * xPostFees + yPostFeesScaled;
  const binValuePostFees = bin.binPriceScaled * reserveXPostFees + reserveYPostFeesScaled;

  const minimumBinShares = 10000;
  const minimumBurntShares = 1000;
  let dlpPostFees: number;
  if (bin.binShares === 0) {
    const intendedDlp = Math.sqrt(addValuePostFees);
    dlpPostFees = intendedDlp >= minimumBinShares ? intendedDlp - minimumBurntShares : 0;
  } else if (binValuePostFees === 0) {
    dlpPostFees = Math.sqrt(addValuePostFees);
  } else {
    dlpPostFees = (addValuePostFees * bin.binShares) / binValuePostFees;
  }

  const minDlpNum = Math.floor(dlpPostFees * (1 - slippage));
  return {
    // dlmm-core asserts min-dlp > 0, so never allow a zero floor.
    minDlp: BigInt(Math.max(1, minDlpNum)),
    maxXFee: BigInt(Math.ceil(xFee * (1 + slippage))),
    maxYFee: BigInt(Math.ceil(yFee * (1 + slippage))),
  };
};

export interface WithdrawAmounts {
  liquidityToRemove: bigint;
  minX: bigint;
  minY: bigint;
}

export const calcWithdrawAmounts = (
  userLiquidity: bigint,
  binLiquidity: bigint,
  reserveX: bigint,
  reserveY: bigint,
  percentage: number,
  slippageBps: number,
): WithdrawAmounts => {
  if (userLiquidity <= BigInt(0) || binLiquidity <= BigInt(0)) {
    return { liquidityToRemove: BigInt(0), minX: BigInt(0), minY: BigInt(0) };
  }
  const pct = Math.max(0, Math.min(100, percentage));
  const liquidityToRemove = (userLiquidity * BigInt(Math.round(pct * 100))) / BigInt(10000);
  if (liquidityToRemove <= BigInt(0)) {
    return { liquidityToRemove: BigInt(0), minX: BigInt(0), minY: BigInt(0) };
  }
  const fraction = Number(liquidityToRemove) / Number(binLiquidity);
  const slippageMult = 1 - slippageBps / FEE_SCALE_BPS;
  return {
    liquidityToRemove,
    minX: BigInt(Math.floor(Number(reserveX) * fraction * slippageMult)),
    minY: BigInt(Math.floor(Number(reserveY) * fraction * slippageMult)),
  };
};

const outflowPc = (token: TokenRef, signer: string, amount: bigint): PostCondition => {
  const builder = Pc.principal(signer).willSendLte(amount);
  return token.isStx ? builder.ustx() : builder.ft(contractId(token.contract), token.assetName);
};

const inflowPc = (token: TokenRef, poolContract: string, amount: bigint): PostCondition => {
  const builder = Pc.principal(contractId(poolContract)).willSendGte(amount);
  return token.isStx ? builder.ustx() : builder.ft(contractId(token.contract), token.assetName);
};

// "maybe-sent" NFT post-conditions for the bin position NFTs. The position NFT
// may be minted (received), burned (sent) or untouched depending on the
// add/withdraw, so maybe-sent covers every case while still satisfying deny
// mode. token-id is the unsigned (0..1000) bin id.
const nftMaybeSentPcs = (binIds: number[], signer: string, poolContract: string): PostCondition[] => {
  const buffer = CONFIG.NFT_PC_BIN_ID_BUFFER;
  const maxBin = BIN_CENTER * 2;
  const target = new Set<number>();
  for (const binId of binIds) {
    const lower = Math.max(0, binId - buffer);
    const upper = Math.min(maxBin, binId + buffer);
    for (let b = lower; b <= upper; b++) target.add(b);
  }
  const asset = `${contractId(poolContract)}::${CONFIG.POOL_NFT_ASSET_NAME}` as `${string}.${string}::${string}`;
  return Array.from(target).map((binId) =>
    Pc.principal(signer)
      .willMaybeSendAsset()
      .nft(asset, tupleCV({ 'token-id': uintCV(binId), owner: principalCV(signer) })),
  );
};

export interface AddPosition {
  binId: number;
  offset: number;
  xAmount: bigint;
  yAmount: bigint;
  minDlp: bigint;
  maxXFee: bigint;
  maxYFee: bigint;
}

export interface ActiveBinTolerance {
  maxDeviation: number;
  expectedSignedBinId: number;
}

export interface LiquidityCall {
  contract: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: 'allow' | 'deny';
}

export interface AddCallOptions {
  activeBinTolerance?: ActiveBinTolerance;
  deadline?: number;
}

export const buildAddLiquidityCall = (
  pool: LiquidityPoolRef,
  positions: AddPosition[],
  signer: string,
  opts: AddCallOptions = {},
): LiquidityCall => {
  const totalX = positions.reduce((sum, p) => sum + p.xAmount, BigInt(0));
  const totalY = positions.reduce((sum, p) => sum + p.yAmount, BigInt(0));

  const postConditions: PostCondition[] = [];
  if (totalX > BigInt(0)) postConditions.push(outflowPc(pool.x, signer, totalX));
  if (totalY > BigInt(0)) postConditions.push(outflowPc(pool.y, signer, totalY));
  postConditions.push(
    ...nftMaybeSentPcs(positions.map((p) => p.binId), signer, pool.poolContract),
  );

  return {
    contract: CONFIG.LIQUIDITY_ROUTER_CONTRACT,
    functionName: 'add-relative-liquidity-same-multi',
    functionArgs: [
      listCV(
        positions.map((p) =>
          tupleCV({
            'active-bin-id-offset': intCV(p.offset),
            'x-amount': uintCV(p.xAmount),
            'y-amount': uintCV(p.yAmount),
            'min-dlp': uintCV(p.minDlp),
            'max-x-liquidity-fee': uintCV(p.maxXFee),
            'max-y-liquidity-fee': uintCV(p.maxYFee),
          }),
        ),
      ),
      cp(pool.poolContract),
      cp(pool.x.contract),
      cp(pool.y.contract),
      opts.activeBinTolerance
        ? someCV(
            tupleCV({
              'max-deviation': uintCV(opts.activeBinTolerance.maxDeviation),
              'expected-bin-id': intCV(opts.activeBinTolerance.expectedSignedBinId),
            }),
          )
        : noneCV(),
      opts.deadline ? someCV(uintCV(opts.deadline)) : noneCV(),
    ],
    postConditions,
    postConditionMode: CONFIG.LIQUIDITY_POST_CONDITION_MODE,
  };
};

export interface WithdrawPosition {
  binId: number;
  amount: bigint;
  minX: bigint;
  minY: bigint;
}

export interface WithdrawCallOptions {
  deadline?: number;
}

export const buildWithdrawLiquidityCall = (
  pool: LiquidityPoolRef,
  positions: WithdrawPosition[],
  signer: string,
  opts: WithdrawCallOptions = {},
): LiquidityCall => {
  const totalAmount = positions.reduce((sum, p) => sum + p.amount, BigInt(0));
  const totalMinX = positions.reduce((sum, p) => sum + p.minX, BigInt(0));
  const totalMinY = positions.reduce((sum, p) => sum + p.minY, BigInt(0));

  const postConditions: PostCondition[] = [
    // Exactly this much DLP (pool-token) is burned from us.
    Pc.principal(signer)
      .willSendEq(totalAmount)
      .ft(contractId(pool.poolContract), CONFIG.POOL_LP_ASSET_NAME),
  ];
  if (totalMinX > BigInt(0)) postConditions.push(inflowPc(pool.x, pool.poolContract, totalMinX));
  if (totalMinY > BigInt(0)) postConditions.push(inflowPc(pool.y, pool.poolContract, totalMinY));
  postConditions.push(
    ...nftMaybeSentPcs(positions.map((p) => p.binId), signer, pool.poolContract),
  );

  return {
    contract: CONFIG.LIQUIDITY_ROUTER_CONTRACT,
    // Absolute bin-id entrypoint (not the *relative* one): we withdraw specific
    // owned bins. The relative variant resolves bin = liveActive + offset at
    // execution and has no active-bin tolerance, so if the active bin drifts
    // between our snapshot and broadcast it would target the wrong bin (where we
    // hold nothing). Absolute bin-ids are immune to that drift.
    functionName: 'withdraw-liquidity-same-multi',
    functionArgs: [
      listCV(
        positions.map((p) =>
          tupleCV({
            'pool-trait': cp(pool.poolContract),
            'bin-id': intCV(signedBinId(p.binId)),
            amount: uintCV(p.amount),
            'min-x-amount': uintCV(p.minX),
            'min-y-amount': uintCV(p.minY),
          }),
        ),
      ),
      cp(pool.x.contract),
      cp(pool.y.contract),
      uintCV(totalMinX),
      uintCV(totalMinY),
      opts.deadline ? someCV(uintCV(opts.deadline)) : noneCV(),
    ],
    postConditions,
    postConditionMode: CONFIG.LIQUIDITY_POST_CONDITION_MODE,
  };
};

const networkName = (): 'mainnet' | 'testnet' =>
  CONFIG.STACKS_NETWORK_VERSION === 'testnet' ? 'testnet' : 'mainnet';

const clientOpt = (): { baseUrl: string } | undefined =>
  CONFIG.STACKS_NODE_URL ? { baseUrl: CONFIG.STACKS_NODE_URL.replace(/\/$/, '') } : undefined;

export const broadcastLiquidity = async (
  call: LiquidityCall,
  ctx: ExecutionContext,
): Promise<string> => {
  if (!CONFIG.SIGNER_KEY) throw new Error('SIGNER_KEY not set');
  const { address, name } = parseContract(call.contract);
  const tx = await makeContractCall({
    contractAddress: address,
    contractName: name,
    functionName: call.functionName,
    functionArgs: call.functionArgs,
    senderKey: CONFIG.SIGNER_KEY,
    network: networkName(),
    nonce: BigInt(ctx.nonce),
    fee: ctx.fee,
    postConditions: call.postConditions,
    postConditionMode: call.postConditionMode,
    client: clientOpt(),
  });

  const result = await broadcastTransaction({ transaction: tx, network: networkName(), client: clientOpt() });
  const failure = result as { error?: string; reason?: string };
  if (failure.error) {
    throw new Error(`broadcast failed: ${failure.reason || failure.error}`);
  }
  return `0x${(result as { txid: string }).txid}`;
};

const deadline = (): number => Math.floor(Date.now() / 1000) + CONFIG.TX_DEADLINE_SECONDS;

export interface PreparedCall {
  call: LiquidityCall;
  summary: string;
}

export interface AddLiquidityRequest {
  poolId: string;
  signer: string;
  binId?: number;
  xAmount: bigint;
  yAmount: bigint;
}

export const prepareAddLiquidity = async (req: AddLiquidityRequest): Promise<PreparedCall> => {
  const [quotes, binsRes] = await Promise.all([
    fetchQuotesPool(req.poolId),
    fetchPoolBins(req.poolId),
  ]);

  const activeBin = Number(quotes.active_bin);
  const targetBin = req.binId ?? activeBin;
  const offset = targetBin - activeBin;

  // dlmm-core only accepts X above the active bin and Y below it; the active bin
  // takes both. Zero the disallowed side so an off-active add can't revert with
  // ERR_INVALID_X_AMOUNT / ERR_INVALID_Y_AMOUNT.
  const xAmount = offset > 0 ? req.xAmount : offset < 0 ? BigInt(0) : req.xAmount;
  const yAmount = offset < 0 ? req.yAmount : offset > 0 ? BigInt(0) : req.yAmount;

  const bin = (binsRes.bins || []).find((b) => Number(b.bin_id) === targetBin);
  if (!bin) throw new Error(`bin ${targetBin} not found in pool ${req.poolId}`);

  const fees: PoolFees = {
    xProtocol: toNum(quotes.x_protocol_fee),
    xProvider: toNum(quotes.x_provider_fee),
    xVariable: toNum(quotes.x_variable_fee),
    yProtocol: toNum(quotes.y_protocol_fee),
    yProvider: toNum(quotes.y_provider_fee),
    yVariable: toNum(quotes.y_variable_fee),
  };

  const slip = calcAddSlippage(
    {
      isActiveBin: targetBin === activeBin,
      binPriceScaled: toNum(bin.price),
      reserveX: toNum(bin.reserve_x),
      reserveY: toNum(bin.reserve_y),
      binShares: toNum(bin.liquidity),
      xAmount: Number(xAmount),
      yAmount: Number(yAmount),
    },
    fees,
    CONFIG.LIQUIDITY_SLIPPAGE_BPS,
  );

  const pool = poolRef(quotes.pool_token, quotes.token_x, quotes.token_y);
  const position: AddPosition = {
    binId: targetBin,
    offset,
    xAmount,
    yAmount,
    minDlp: slip.minDlp,
    maxXFee: slip.maxXFee,
    maxYFee: slip.maxYFee,
  };

  // Positions are placed at active-bin + offset, and the router asserts
  // abs(active-bin - expected-bin-id) <= max-deviation. So expected-bin-id is the
  // CURRENT active bin (max-deviation only absorbs snapshot->execution drift),
  // not the target bin the offset resolves to.
  const call = buildAddLiquidityCall(pool, [position], req.signer, {
    activeBinTolerance: {
      maxDeviation: CONFIG.ACTIVE_BIN_MAX_DEVIATION,
      expectedSignedBinId: signedBinId(activeBin),
    },
    deadline: deadline(),
  });

  const summary =
    `add bin=${targetBin} offset=${offset} x=${microToString(xAmount)} ` +
    `y=${microToString(yAmount)} min_dlp=${slip.minDlp} ` +
    `max_x_fee=${slip.maxXFee} max_y_fee=${slip.maxYFee} ` +
    `tolerance=${CONFIG.ACTIVE_BIN_MAX_DEVIATION} pc_mode=${CONFIG.LIQUIDITY_POST_CONDITION_MODE} ` +
    `pcs=${call.postConditions.length}`;
  return { call, summary };
};

// Scales a two-sided add down so its STX-denominated value (x*price + y, with
// price as Y per X) stays under capUstx, preserving the x:y ratio. Leftover
// inventory is simply not deployed. capUstx <= 0 disables the cap.
export const capPositionByValue = (
  xAmount: bigint,
  yAmount: bigint,
  price: number,
  capUstx: bigint,
): { xAmount: bigint; yAmount: bigint; capped: boolean } => {
  if (capUstx <= BigInt(0) || price <= 0) return { xAmount, yAmount, capped: false };
  const value = BigInt(Math.floor(Number(xAmount) * price)) + yAmount;
  if (value <= capUstx) return { xAmount, yAmount, capped: false };
  const scale = Number(capUstx) / Number(value);
  return {
    xAmount: BigInt(Math.floor(Number(xAmount) * scale)),
    yAmount: BigInt(Math.floor(Number(yAmount) * scale)),
    capped: true,
  };
};

export interface ShapeLeg {
  x: bigint;
  y: bigint;
  // Bin price, Y per X (real, not scaled).
  price: number;
}

// Scales a multi-bin shape down by a single factor so its total Y-value
// (sum of x*price + y) stays under `residual`, preserving the distribution across
// bins. residual<=0 zeroes every leg; residual >= the shape's value leaves it
// unchanged. Used to apply MAX_POSITION to the curve's shaped add.
export const capShapedByValue = (
  legs: ShapeLeg[],
  residual: bigint,
): { legs: { x: bigint; y: bigint }[]; capped: boolean; addValue: bigint } => {
  const addValue = legs.reduce(
    (s, l) => s + BigInt(Math.floor(Number(l.x) * l.price)) + l.y,
    BigInt(0),
  );
  if (residual <= BigInt(0)) {
    return { legs: legs.map(() => ({ x: BigInt(0), y: BigInt(0) })), capped: true, addValue };
  }
  if (addValue <= residual) {
    return { legs: legs.map((l) => ({ x: l.x, y: l.y })), capped: false, addValue };
  }
  const scale = Number(residual) / Number(addValue);
  return {
    legs: legs.map((l) => ({
      x: BigInt(Math.floor(Number(l.x) * scale)),
      y: BigInt(Math.floor(Number(l.y) * scale)),
    })),
    capped: true,
    addValue,
  };
};

// Sum of the value (x*price + y, in the pool's Y / quote token) of
// every position the signer currently holds in the pool. The position cap counts
// this existing exposure so owned + new add stays under the limit even if a prior
// withdraw was skipped or only partial.
const deployedPositionValue = async (
  poolId: string,
  signer: string,
  binsRes: PoolBinsResponse,
): Promise<bigint> => {
  const userBins: UserBin[] = await fetchUserBins(poolId, signer).catch(() => []);
  if (userBins.length === 0) return BigInt(0);
  const byId = new Map<number, PoolBin>();
  for (const pb of binsRes.bins || []) byId.set(Number(pb.bin_id), pb);

  let value = 0;
  for (const ub of userBins) {
    const pb = byId.get(Number(ub.bin_id));
    if (!pb) continue;
    const total = Number(toBig(pb.liquidity));
    const shares = Number(userBinLiquidity(ub));
    if (total <= 0 || shares <= 0) continue;
    const frac = shares / total;
    const price = Number(pb.price) / PRICE_SCALE_BPS; // Y per X
    value += frac * (Number(toBig(pb.reserve_x)) * price + Number(toBig(pb.reserve_y)));
  }
  return BigInt(Math.floor(value));
};

export interface AutoAddRequest {
  poolId: string;
  signer: string;
  binId?: number;
  baseAvailable: bigint;
  quoteAvailable: bigint;
}

// Sizes a two-sided add from live wallet balances against the live active bin
// (50/50 by value at the bin price, capped by whichever side runs out). We never
// place a single-sided off-active add: if the plan's target bin no longer equals
// the live active bin (market moved, or a reposition swap fell short), we deploy
// two-sided at the current active bin instead of parking inventory off-active,
// and the next tick continues repositioning. binId is left unset on the inner
// call so the offset is always 0 (no inter-fetch race can re-trigger side rules).
export const prepareAddLiquidityAuto = async (req: AutoAddRequest): Promise<PreparedCall> => {
  const [quotes, binsRes] = await Promise.all([
    fetchQuotesPool(req.poolId),
    fetchPoolBins(req.poolId),
  ]);

  const activeBin = Number(quotes.active_bin);
  if (req.binId !== undefined && req.binId !== activeBin) {
    logWarn(
      `[${TAG}] add re-targeted from bin ${req.binId} to live active bin ${activeBin} (no single-sided off-active add)`,
    );
  }

  const baseIsX = quotes.token_x === CONFIG.BASE_TOKEN_CONTRACT;
  const availX = baseIsX ? req.baseAvailable : req.quoteAvailable;
  const availY = baseIsX ? req.quoteAvailable : req.baseAvailable;

  let xAmount = availX;
  let yAmount = availY;
  const bin = (binsRes.bins || []).find((b) => Number(b.bin_id) === activeBin);
  const price = bin ? Number(bin.price) / PRICE_SCALE_BPS : 0; // Y per X
  if (price > 0) {
    // Balance by value at the bin price, capped by whichever side runs out.
    if (Number(availX) * price <= Number(availY)) {
      xAmount = availX;
      yAmount = BigInt(Math.floor(Number(availX) * price));
    } else {
      yAmount = availY;
      xAmount = BigInt(Math.floor(Number(availY) / price));
    }
  }

  // Notional cap counts existing deployed exposure so owned + add stays under it.
  const capUstx = BigInt(CONFIG.MAX_POSITION_USTX);
  if (capUstx > BigInt(0)) {
    const deployed = await deployedPositionValue(req.poolId, req.signer, binsRes);
    if (deployed >= capUstx) {
      throw new Error(
        `position cap reached: deployed=${microToString(deployed)} >= MAX_POSITION=${microToString(capUstx)}; not adding`,
      );
    }
    const residual = capUstx - deployed;
    const cap = capPositionByValue(xAmount, yAmount, price, residual);
    if (cap.capped) {
      logWarn(
        `[${TAG}] add capped by MAX_POSITION=${microToString(capUstx)} ` +
          `(deployed=${microToString(deployed)} residual=${microToString(residual)}; ` +
          `x ${microToString(xAmount)}->${microToString(cap.xAmount)} ` +
          `y ${microToString(yAmount)}->${microToString(cap.yAmount)})`,
      );
    }
    xAmount = cap.xAmount;
    yAmount = cap.yAmount;
  }

  if (xAmount <= BigInt(0) && yAmount <= BigInt(0)) {
    throw new Error('no inventory to add at the active bin');
  }

  const prepared = await prepareAddLiquidity({
    poolId: req.poolId,
    signer: req.signer,
    xAmount,
    yAmount,
  });
  return {
    call: prepared.call,
    summary:
      `${prepared.summary} side=both base_is_x=${baseIsX} ` +
      `avail_base=${microToString(req.baseAvailable)} avail_quote=${microToString(req.quoteAvailable)}`,
  };
};

export interface ShapedAddRequest {
  poolId: string;
  signer: string;
  // Bin offsets relative to the active bin and their (unnormalized) weights.
  offsets: number[];
  weights: number[];
  // Inventory to spread across the curve (already net of any reserve), by side.
  baseAvailable: bigint;
  quoteAvailable: bigint;
}

// Builds a shaped multi-bin add (curve strategy). Spreads baseAvailable across
// the active bin + bins above it and quoteAvailable across the active bin + bins
// below it (DLMM holds X above the active bin, Y below, both at it), weighted by
// the curve so the active bin is heaviest. Each position gets its own min-DLP /
// max-fee from the same per-bin slippage math the single-bin add uses, so it is
// decimal-correct for any token pair (the on-chain bin price already encodes the
// x/y decimal ratio). Bins outside the pool's [0..2*BIN_CENTER] range are skipped.
export const prepareShapedAddLiquidity = async (req: ShapedAddRequest): Promise<PreparedCall> => {
  const [quotes, binsRes] = await Promise.all([
    fetchQuotesPool(req.poolId),
    fetchPoolBins(req.poolId),
  ]);

  const activeBin = Number(quotes.active_bin);
  const baseIsX = quotes.token_x === CONFIG.BASE_TOKEN_CONTRACT;
  // upper side (offset >= 0) is the X token; lower side (offset <= 0) is Y.
  const upperMicro = baseIsX ? req.baseAvailable : req.quoteAvailable;
  const lowerMicro = baseIsX ? req.quoteAvailable : req.baseAvailable;

  const legs: CurveLeg[] = req.offsets.map((offset, i) => ({
    offset,
    weight: req.weights[i] ?? 0,
  }));
  const alloc = allocateCurve(legs, upperMicro, lowerMicro);

  const fees: PoolFees = {
    xProtocol: toNum(quotes.x_protocol_fee),
    xProvider: toNum(quotes.x_provider_fee),
    xVariable: toNum(quotes.x_variable_fee),
    yProtocol: toNum(quotes.y_protocol_fee),
    yProvider: toNum(quotes.y_provider_fee),
    yVariable: toNum(quotes.y_variable_fee),
  };
  const binById = new Map<number, PoolBin>();
  for (const pb of binsRes.bins || []) binById.set(Number(pb.bin_id), pb);

  // First pass: raw per-bin amounts from the shape (in range, non-empty), with
  // each bin's real price (Y per X) for the value/cap math.
  const maxBin = BIN_CENTER * 2;
  const raw: { binId: number; offset: number; bin: PoolBin; x: bigint; y: bigint; price: number }[] = [];
  for (const a of alloc) {
    const binId = activeBin + a.offset;
    if (binId < 0 || binId > maxBin) continue; // respect the pool's bin range
    if (a.upper <= BigInt(0) && a.lower <= BigInt(0)) continue;
    const bin = binById.get(binId);
    if (!bin) continue;
    raw.push({ binId, offset: a.offset, bin, x: a.upper, y: a.lower, price: toNum(bin.price) / PRICE_SCALE_BPS });
  }
  if (raw.length === 0) throw new Error('no shaped positions to add');

  // MAX_POSITION cap: scale the whole shape down by a single factor (preserving
  // its distribution) so owned + new deployed value stays under the cap. Value is
  // in the Y token (x*price + y), matching deployedPositionValue.
  const capUstx = BigInt(CONFIG.MAX_POSITION_USTX);
  if (capUstx > BigInt(0)) {
    const deployed = await deployedPositionValue(req.poolId, req.signer, binsRes);
    if (deployed >= capUstx) {
      throw new Error(
        `position cap reached: deployed=${microToString(deployed)} >= MAX_POSITION=${microToString(capUstx)}; not adding`,
      );
    }
    const residual = capUstx - deployed;
    const capped = capShapedByValue(raw, residual);
    if (capped.capped) {
      raw.forEach((r, i) => {
        r.x = capped.legs[i].x;
        r.y = capped.legs[i].y;
      });
      logWarn(
        `[${TAG}] shaped add capped by MAX_POSITION=${microToString(capUstx)} ` +
          `(deployed=${microToString(deployed)} residual=${microToString(residual)} ` +
          `add_value=${microToString(capped.addValue)})`,
      );
    }
  }

  // Second pass: per-bin slippage on the (possibly capped) amounts.
  const positions: AddPosition[] = [];
  for (const r of raw) {
    if (r.x <= BigInt(0) && r.y <= BigInt(0)) continue;
    const slip = calcAddSlippage(
      {
        isActiveBin: r.binId === activeBin,
        binPriceScaled: toNum(r.bin.price),
        reserveX: toNum(r.bin.reserve_x),
        reserveY: toNum(r.bin.reserve_y),
        binShares: toNum(r.bin.liquidity),
        xAmount: Number(r.x),
        yAmount: Number(r.y),
      },
      fees,
      CONFIG.LIQUIDITY_SLIPPAGE_BPS,
    );
    positions.push({
      binId: r.binId,
      offset: r.offset,
      xAmount: r.x,
      yAmount: r.y,
      minDlp: slip.minDlp,
      maxXFee: slip.maxXFee,
      maxYFee: slip.maxYFee,
    });
  }

  if (positions.length === 0) throw new Error('no shaped positions to add after cap');

  const pool = poolRef(quotes.pool_token, quotes.token_x, quotes.token_y);
  const call = buildAddLiquidityCall(pool, positions, req.signer, {
    activeBinTolerance: {
      maxDeviation: CONFIG.ACTIVE_BIN_MAX_DEVIATION,
      expectedSignedBinId: signedBinId(activeBin),
    },
    deadline: deadline(),
  });

  const totalX = positions.reduce((s, p) => s + p.xAmount, BigInt(0));
  const totalY = positions.reduce((s, p) => s + p.yAmount, BigInt(0));
  const xDecimals = baseIsX ? CONFIG.BASE_DECIMALS : CONFIG.QUOTE_DECIMALS;
  const yDecimals = baseIsX ? CONFIG.QUOTE_DECIMALS : CONFIG.BASE_DECIMALS;
  const summary =
    `add_shaped active_bin=${activeBin} bins=[${positions.map((p) => p.binId).join(',')}] ` +
    `x=${microToString(totalX, xDecimals)} y=${microToString(totalY, yDecimals)} positions=${positions.length} ` +
    `base_is_x=${baseIsX} tolerance=${CONFIG.ACTIVE_BIN_MAX_DEVIATION} ` +
    `pc_mode=${CONFIG.LIQUIDITY_POST_CONDITION_MODE} pcs=${call.postConditions.length}`;
  return { call, summary };
};

export interface WithdrawLiquidityRequest {
  poolId: string;
  signer: string;
  binIds?: number[];
  percentage?: number;
}

export const prepareWithdrawLiquidity = async (
  req: WithdrawLiquidityRequest,
): Promise<PreparedCall> => {
  const pct = req.percentage ?? 100;
  const [quotes, userBins, binsRes] = await Promise.all([
    fetchQuotesPool(req.poolId),
    fetchUserBins(req.poolId, req.signer),
    fetchPoolBins(req.poolId),
  ]);

  const wanted = req.binIds && req.binIds.length > 0 ? new Set(req.binIds) : null;

  // Bin total shares + reserves come from the pool-bins endpoint (the user
  // endpoint only returns the user's share count).
  const poolBins = new Map<number, { liquidity: bigint; reserveX: bigint; reserveY: bigint }>();
  for (const pb of binsRes.bins || []) {
    poolBins.set(Number(pb.bin_id), {
      liquidity: toBig(pb.liquidity),
      reserveX: toBig(pb.reserve_x),
      reserveY: toBig(pb.reserve_y),
    });
  }

  const positions: WithdrawPosition[] = [];
  for (const ub of userBins) {
    const binId = Number(ub.bin_id);
    if (wanted && !wanted.has(binId)) continue;
    const pool = poolBins.get(binId);
    if (!pool) continue;
    const amounts = calcWithdrawAmounts(
      userBinLiquidity(ub),
      pool.liquidity,
      pool.reserveX,
      pool.reserveY,
      pct,
      CONFIG.LIQUIDITY_SLIPPAGE_BPS,
    );
    if (amounts.liquidityToRemove <= BigInt(0)) continue;
    positions.push({
      binId,
      amount: amounts.liquidityToRemove,
      minX: amounts.minX,
      minY: amounts.minY,
    });
  }

  if (positions.length === 0) throw new Error('no withdrawable positions found');

  const pool = poolRef(quotes.pool_token, quotes.token_x, quotes.token_y);
  const call = buildWithdrawLiquidityCall(pool, positions, req.signer, { deadline: deadline() });

  const bins = positions.map((p) => p.binId).join(',');
  const totalMinX = positions.reduce((s, p) => s + p.minX, BigInt(0));
  const totalMinY = positions.reduce((s, p) => s + p.minY, BigInt(0));
  const baseIsX = quotes.token_x === CONFIG.BASE_TOKEN_CONTRACT;
  const xDecimals = baseIsX ? CONFIG.BASE_DECIMALS : CONFIG.QUOTE_DECIMALS;
  const yDecimals = baseIsX ? CONFIG.QUOTE_DECIMALS : CONFIG.BASE_DECIMALS;
  const summary =
    `withdraw pct=${pct} bins=[${bins}] min_x=${microToString(totalMinX, xDecimals)} ` +
    `min_y=${microToString(totalMinY, yDecimals)} pc_mode=${CONFIG.LIQUIDITY_POST_CONDITION_MODE} ` +
    `pcs=${call.postConditions.length}`;
  return { call, summary };
};
