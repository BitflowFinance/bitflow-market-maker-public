import { CONFIG } from './config';
import { fetchJson, getFtBalance } from './stacks';
import { logDebug } from './logger';

export const BIN_CENTER = 500;
export const PRICE_SCALE = 1e8;

export interface QuotesPool {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  pool_status: string | boolean;
  x_protocol_fee: number;
  x_provider_fee: number;
  x_variable_fee: number;
  y_protocol_fee: number;
  y_provider_fee: number;
  y_variable_fee: number;
  pool_token: string;
  core_address: string;
}

export interface AppPoolToken {
  contract: string;
  symbol: string;
  decimals: number;
}

export interface AppPool {
  poolId: string;
  poolContract: string;
  poolStatus: boolean;
  tokens: { tokenX: AppPoolToken; tokenY: AppPoolToken };
}

export interface PoolBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

export interface PoolBinsResponse {
  success: boolean;
  pool_id: string;
  bins: PoolBin[];
}

// The user-positions endpoint returns a minimal shape (bin_id, price,
// userLiquidity); bin total shares + reserves come from the pool-bins endpoint.
// Older/other responses may use snake_case, so both are accepted.
export interface UserBin {
  bin_id: number;
  userLiquidity?: string | number;
  user_liquidity?: string | number;
  liquidity?: string;
  reserve_x?: string;
  reserve_y?: string;
  price?: string | number;
}

export const userBinLiquidity = (bin: UserBin): bigint => {
  const raw = bin.userLiquidity ?? bin.user_liquidity ?? '0';
  try {
    return BigInt(String(raw).split('.')[0] || '0');
  } catch {
    return BigInt(0);
  }
};

export interface TokenSide {
  contract: string;
  symbol: string;
  decimals: number;
}

export interface LadderBin {
  binId: number;
  price: number;
  reserveX: bigint;
  reserveY: bigint;
}

export interface PoolSnapshot {
  poolId: string;
  poolContract: string;
  poolActive: boolean;
  binStep: number;
  activeBinId: number;
  activeBinPrice: number;
  tokenX: TokenSide;
  tokenY: TokenSide;
  activeBinReserveX: bigint;
  activeBinReserveY: bigint;
  walletX: bigint;
  walletY: bigint;
  // Our pro-rata token reserves summed across all owned bins (userLiquidity /
  // bin shares x bin reserves). The plan vacates all owned bins, so this is the
  // inventory we can redeploy.
  ownedReserveX: bigint;
  ownedReserveY: bigint;
  ownedBinCount: number;
  priceLadder: LadderBin[];
  ownedBinIds: number[];
}

const toBig = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? '0').split('.')[0] || '0');
  } catch {
    return BigInt(0);
  }
};

// Normalize the BFF pool status into a boolean. Treat the pool as active unless
// it explicitly reports an inactive state, so an unexpected truthy value never
// halts the bot, but a clear "paused/disabled/false" does.
const INACTIVE_STATES = ['inactive', 'paused', 'disabled', 'closed', 'halted', 'false'];
export const isPoolActive = (status: string | boolean | undefined, appStatus?: boolean): boolean => {
  if (typeof status === 'boolean') return status;
  if (typeof status === 'string') return !INACTIVE_STATES.includes(status.toLowerCase());
  if (typeof appStatus === 'boolean') return appStatus;
  return true;
};

const base = (): string => {
  if (!CONFIG.BFF_API_BASE_URL) throw new Error('BFF_API_BASE_URL is not configured');
  return CONFIG.BFF_API_BASE_URL.replace(/\/$/, '');
};

export interface BffToken {
  contract_address: string;
  symbol: string;
  name: string;
  decimals: number;
  asset_name: string;
}

export interface TokensResponse {
  tokens: BffToken[];
}

// Registry of every token the BFF knows, keyed by contract. Source of truth for
// SIP-010 asset names + decimals, so we don't hardcode them per pool.
export const fetchTokens = (): Promise<TokensResponse> =>
  fetchJson<TokensResponse>(`${base()}/quotes/v1/tokens`, CONFIG.BFF_API_KEY);

export const fetchQuotesPool = (poolId: string): Promise<QuotesPool> =>
  fetchJson<QuotesPool>(`${base()}/quotes/v1/pools/${poolId}`, CONFIG.BFF_API_KEY);

export const fetchAppPool = (poolId: string): Promise<AppPool> =>
  fetchJson<AppPool>(`${base()}/app/v1/pools/${poolId}`, CONFIG.BFF_API_KEY);

export const fetchPoolBins = (poolId: string): Promise<PoolBinsResponse> =>
  fetchJson<PoolBinsResponse>(`${base()}/quotes/v1/bins/${poolId}`, CONFIG.BFF_API_KEY);

export const fetchUserBins = async (
  poolId: string,
  address: string,
): Promise<UserBin[]> => {
  const url = `${base()}/app/v1/users/${address}/positions/${poolId}/bins`;
  const res = await fetchJson<{ bins?: UserBin[]; detail?: string }>(url, CONFIG.BFF_API_KEY);
  if (Array.isArray(res.bins)) return res.bins;
  if (res.detail) logDebug(`[bitflow] no user bins: ${res.detail}`);
  return [];
};

const toSide = (token: AppPoolToken | undefined, contract: string): TokenSide => ({
  contract,
  symbol: token?.symbol || contract.split('.').pop() || contract,
  decimals: typeof token?.decimals === 'number' ? token.decimals : 6,
});

export const getPoolSnapshot = async (
  poolId: string,
  address: string,
): Promise<PoolSnapshot> => {
  const [quotesPool, appPool, binsRes] = await Promise.all([
    fetchQuotesPool(poolId),
    fetchAppPool(poolId).catch((err) => {
      logDebug(`[bitflow] app pool read failed error="${(err as Error).message}"`);
      return null;
    }),
    fetchPoolBins(poolId),
  ]);

  const activeBinId = Number(quotesPool.active_bin);
  const activeBin = binsRes.bins?.find((b) => Number(b.bin_id) === activeBinId);

  const tokenX = toSide(appPool?.tokens?.tokenX, quotesPool.token_x);
  const tokenY = toSide(appPool?.tokens?.tokenY, quotesPool.token_y);

  const userBins = address
    ? await fetchUserBins(poolId, address).catch((err) => {
        logDebug(`[bitflow] user bins read failed error="${(err as Error).message}"`);
        return [] as UserBin[];
      })
    : [];

  const [walletX, walletY] = await Promise.all([
    getFtBalance(tokenX.contract, address).catch(() => BigInt(0)),
    getFtBalance(tokenY.contract, address).catch(() => BigInt(0)),
  ]);

  // Owned reserves are our share of each bin: the user-positions endpoint only
  // returns our share count, so join with pool bins for totals + reserves.
  const poolBinById = new Map<number, PoolBin>();
  for (const b of binsRes.bins || []) poolBinById.set(Number(b.bin_id), b);

  let ownedReserveX = BigInt(0);
  let ownedReserveY = BigInt(0);
  for (const ub of userBins) {
    const pb = poolBinById.get(Number(ub.bin_id));
    if (!pb) continue;
    const shares = userBinLiquidity(ub);
    const total = toBig(pb.liquidity);
    if (shares <= BigInt(0) || total <= BigInt(0)) continue;
    ownedReserveX += (toBig(pb.reserve_x) * shares) / total;
    ownedReserveY += (toBig(pb.reserve_y) * shares) / total;
  }

  const priceLadder: LadderBin[] = (binsRes.bins || [])
    .map((b) => ({
      binId: Number(b.bin_id),
      price: Number(b.price) / PRICE_SCALE,
      reserveX: toBig(b.reserve_x),
      reserveY: toBig(b.reserve_y),
    }))
    .filter((b) => Number.isFinite(b.binId) && b.price > 0)
    .sort((a, b) => a.binId - b.binId);

  return {
    poolId: quotesPool.pool_id,
    poolContract: appPool?.poolContract || '',
    poolActive: isPoolActive(quotesPool.pool_status, appPool?.poolStatus),
    binStep: Number(quotesPool.bin_step),
    activeBinId,
    activeBinPrice: activeBin ? Number(activeBin.price) / PRICE_SCALE : 0,
    tokenX,
    tokenY,
    activeBinReserveX: toBig(activeBin?.reserve_x),
    activeBinReserveY: toBig(activeBin?.reserve_y),
    walletX,
    walletY,
    ownedReserveX,
    ownedReserveY,
    ownedBinCount: userBins.length,
    priceLadder,
    ownedBinIds: userBins.map((b) => Number(b.bin_id)).filter((n) => Number.isFinite(n)),
  };
};
