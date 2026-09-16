import { CONFIG } from './config';
import { fetchJson, fetchJsonAllowMissing, getFtBalance } from './stacks';
import { logDebug, logWarn } from './logger';

export const BIN_CENTER = 500;
export const PRICE_SCALE = 1e8;

export interface QuotesPool {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  pool_status: string | boolean;
  // v2 adds these; `quotable` is the engine's own "safe to trade" signal.
  active?: boolean;
  quotable?: boolean;
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
  // v2 moved the raw integer share count here and repurposed `userLiquidity` as
  // a human-scaled float, so prefer this when present or we would read e.g. 2
  // shares instead of 372231798.
  userShares?: string | number;
  liquidity?: string;
  reserve_x?: string;
  reserve_y?: string;
  price?: string | number;
}

export const userBinLiquidity = (bin: UserBin): bigint => {
  const raw = bin.userShares ?? bin.userLiquidity ?? bin.user_liquidity ?? '0';
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

// The BFF has two incompatible generations. Everything below normalizes v2 onto
// the v1 shape so the rest of the bot never learns which one it is talking to:
// bin ids stay unsigned (0..1000), user shares stay raw integers.
export const apiVersion = (): 'v1' | 'v2' => (CONFIG.BFF_API_VERSION === 'v2' ? 'v2' : 'v1');

// v2 serves the ladder in a signed domain centered on BIN_CENTER.
export const unsignedBinId = (signed: number): number => signed + BIN_CENTER;

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
  fetchJson<TokensResponse>(`${base()}/quotes/${apiVersion()}/tokens`, CONFIG.BFF_API_KEY);

export const fetchQuotesPool = async (poolId: string): Promise<QuotesPool> => {
  const v = apiVersion();
  const raw = await fetchJson<QuotesPool>(
    `${base()}/quotes/${v}/pools/${poolId}`,
    CONFIG.BFF_API_KEY,
  );
  if (v === 'v1') return raw;
  // v2 nulls pool_token/core_address but puts the pool's contract principal --
  // the value v1 returned as pool_token -- in pool_id. Every add/withdraw/swap
  // post-condition is built against that principal.
  return {
    ...raw,
    active_bin: unsignedBinId(Number(raw.active_bin)),
    pool_token: raw.pool_token || raw.pool_id,
  };
};

export const fetchAppPool = (poolId: string): Promise<AppPool> =>
  fetchJson<AppPool>(`${base()}/app/v1/pools/${poolId}`, CONFIG.BFF_API_KEY);

export interface EngineStatus {
  ready?: boolean;
  tip_lag?: number | null;
  state_height?: number;
  chain_tip?: number;
}

export interface TipCheck {
  fresh: boolean;
  reason: string;
}

// v2 serves quotes from in-memory AMM state at the applied tip, so there is no
// stale-DB fallback to lean on: freshness has to be asserted before we size an
// add against these reserves. v1 has no equivalent gate.
export const checkEngineTip = async (): Promise<TipCheck> => {
  if (apiVersion() !== 'v2') return { fresh: true, reason: 'v1 (no tip gate)' };
  const s = await fetchJson<EngineStatus>(`${base()}/quotes/v2/status`, CONFIG.BFF_API_KEY);
  if (s.ready === false) return { fresh: false, reason: 'engine not ready' };
  // A null lag means the engine cannot see the tip, which is not the same as
  // being caught up and must never be read as such.
  if (typeof s.tip_lag !== 'number') {
    return { fresh: false, reason: `tip_lag unknown (state_height=${s.state_height})` };
  }
  const max = CONFIG.BFF_MAX_TIP_LAG;
  if (s.tip_lag > max) {
    return { fresh: false, reason: `tip_lag=${s.tip_lag} > max=${max}` };
  }
  return { fresh: true, reason: `tip_lag=${s.tip_lag}` };
};

export const fetchPoolBins = async (poolId: string): Promise<PoolBinsResponse> => {
  const v = apiVersion();
  const res = await fetchJson<PoolBinsResponse>(
    `${base()}/quotes/${v}/bins/${poolId}`,
    CONFIG.BFF_API_KEY,
  );
  if (v === 'v1') return res;
  return {
    ...res,
    bins: (res.bins || []).map((b) => ({ ...b, bin_id: unsignedBinId(Number(b.bin_id)) })),
  };
};

// v2 inventory ("current-bins"): the market-maker source of truth. Unlike
// .../positions/.../bins it carries raw integer shares, both bin-id domains, the
// bin totals, and tip freshness -- so owned-bin math never depends on the ladder
// (whose `liquidity` v2 nulls out on low-liquidity bins).
interface CurrentBin {
  binIdUnsigned: number;
  binIdSigned: number;
  userShares: string;
  binShares: string;
  reserveX: string;
  reserveY: string;
}

interface CurrentBinsResponse {
  bins?: CurrentBin[];
  clean?: boolean;
  complete?: boolean;
  reservesComplete?: boolean;
  tipLag?: number | null;
  overallUserShares?: string;
  errorCode?: string;
}

const fetchUserBinsV2 = async (poolId: string, address: string): Promise<UserBin[]> => {
  const url = `${base()}/app/v2/users/${address}/positions/${poolId}/current-bins`;
  const res = await fetchJson<CurrentBinsResponse>(url, CONFIG.BFF_API_KEY);
  // This endpoint keys off the pool alias and 404s on a contract principal --
  // the reverse of the other app/v2 routes -- so say so rather than reporting it
  // as a dirty snapshot.
  if (res.errorCode === 'POOL_NOT_FOUND') {
    throw new Error(
      `pool "${poolId}" not found in the v2 MM inventory cohort; POOL_ID must be the ` +
        'BFF alias (e.g. dlmm_1), not the pool contract principal',
    );
  }
  // An empty book is only ever reported as clean+complete with bins: []. A dirty
  // or tip-lagging snapshot must never be read as "no inventory" -- that would
  // make the bot redeploy on top of liquidity it already owns.
  if (res.clean !== true || res.complete !== true) {
    throw new Error(
      `inventory snapshot unusable clean="${res.clean}" complete="${res.complete}" ` +
        `tip_lag="${res.tipLag}" code="${res.errorCode || ''}"`,
    );
  }
  // clean+complete is not the same as current: the engine still answers 200 while
  // it is some blocks behind, and only escalates to a 503 TIP_LAG further back.
  // A lagging book can omit bins we have since deployed, so repositioning off it
  // would add on top of liquidity we already own -- the exact failure the clean
  // check exists to prevent.
  if (typeof res.tipLag !== 'number' || res.tipLag > CONFIG.BFF_MAX_TIP_LAG) {
    throw new Error(
      `inventory snapshot stale tip_lag="${res.tipLag}" max="${CONFIG.BFF_MAX_TIP_LAG}"`,
    );
  }
  return (res.bins || []).map((b) => ({
    bin_id: Number(b.binIdUnsigned),
    userShares: b.userShares,
    liquidity: b.binShares,
    reserve_x: b.reserveX,
    reserve_y: b.reserveY,
  }));
};

export const fetchUserBins = async (
  poolId: string,
  address: string,
): Promise<UserBin[]> => {
  if (apiVersion() === 'v2') return fetchUserBinsV2(poolId, address);
  const url = `${base()}/app/v1/users/${address}/positions/${poolId}/bins`;
  // v1 answers 404 -- not an empty list -- for a wallet that has never deployed
  // to the pool, which is every wallet's first tick. The pool id is already
  // proven good by the quotes read in the same snapshot, so a 404 here can only
  // mean "no position yet" and must not trip the api-error breaker.
  const res = await fetchJsonAllowMissing<{ bins?: UserBin[]; detail?: string }>(
    url,
    CONFIG.BFF_API_KEY,
  );
  if (!res) {
    logDebug('[bitflow] no user bins: wallet has no position in this pool');
    return [];
  }
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
  // app/v2 rejects the short aliases (dlmm_1) and only answers to the contract
  // principal, and it carries nothing the quotes pool doesn't already give us
  // here, so v2 skips the call entirely rather than resolving the alias twice.
  const [quotesPool, appPool, binsRes] = await Promise.all([
    fetchQuotesPool(poolId),
    apiVersion() === 'v2'
      ? Promise.resolve(null)
      : fetchAppPool(poolId).catch((err) => {
          logDebug(`[bitflow] app pool read failed error="${(err as Error).message}"`);
          return null;
        }),
    fetchPoolBins(poolId),
  ]);

  const activeBinId = Number(quotesPool.active_bin);
  const activeBin = binsRes.bins?.find((b) => Number(b.bin_id) === activeBinId);

  const tokenX = toSide(appPool?.tokens?.tokenX, quotesPool.token_x);
  const tokenY = toSide(appPool?.tokens?.tokenY, quotesPool.token_y);

  // Deliberately not swallowed: a failed inventory read is not an empty
  // position. Degrading to [] would tell the strategy it owns nothing and
  // invite a redeploy on top of live liquidity, so let the tick's API-error
  // breaker see it instead.
  const userBins = address ? await fetchUserBins(poolId, address) : [];

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
  let unpricedBins = 0;
  for (const ub of userBins) {
    const shares = userBinLiquidity(ub);
    if (shares <= BigInt(0)) continue;
    // Prefer the inventory's own bin totals (v2 current-bins carries them). The
    // ladder is only a fallback: v2 nulls `liquidity` on low-liquidity bins, and
    // silently skipping those would under-report what we hold.
    const pb = poolBinById.get(Number(ub.bin_id));
    const total = toBig(ub.liquidity ?? pb?.liquidity);
    if (total <= BigInt(0)) {
      unpricedBins += 1;
      continue;
    }
    ownedReserveX += (toBig(ub.reserve_x ?? pb?.reserve_x) * shares) / total;
    ownedReserveY += (toBig(ub.reserve_y ?? pb?.reserve_y) * shares) / total;
  }
  if (unpricedBins > 0) {
    logWarn(
      `[bitflow] owned_inventory_understated bins=${unpricedBins} reason="bin total shares unavailable" ` +
        `api_version="${apiVersion()}"`,
    );
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
    poolContract: appPool?.poolContract || quotesPool.pool_token || '',
    poolActive:
      quotesPool.active === false || quotesPool.quotable === false
        ? false
        : isPoolActive(quotesPool.pool_status, appPool?.poolStatus),
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
