import { PoolProfile } from './profiles';

// Self-contained for the same reason as poolDepth.ts: importing the bot's
// Bitflow reader would load config.ts and a .env file into this process.

const DEFAULT_BASE = 'https://bff.bitflowapis.finance/api';
const PRICE_SCALE = 1e8;
const BIN_EDGE = 500;
const DEPTH_BINS = 10;
const LIST_FRESH_MS = 60_000;
const BINS_FRESH_MS = 30_000;

/** One pool of a pair, scored for a bot running this profile's curve. */
export interface PoolOption {
  poolId: string;
  name: string;
  binStepBps: number;
  feeBps: number | null;
  rangeLow: number | null;
  rangeHigh: number | null;
  price: number | null;
  activeBin: number;
  /** Bins between the active bin and the nearer edge of the pool's range. */
  edgeRoom: number;
  /** Quote-token value held within a few bins of the price; where trades and fees happen. */
  depth: number | null;
  gapBps: number | null;
  ok: boolean;
  reasons: string[];
  recommended: boolean;
}

export interface PoolCatalog {
  profile: string;
  pair: string;
  market: number | null;
  pools: PoolOption[];
  recommended: string | null;
  readAt: string;
}

export interface PoolCatalogReader {
  catalog(profile: PoolProfile, haltBps: number): Promise<PoolCatalog>;
  /**
   * Whether this wallet holds nothing in the pool: true for a clean, current,
   * empty position; false when it holds liquidity; null when it cannot be told.
   */
  positionEmpty(poolId: string, address: string): Promise<boolean | null>;
}

export const noPoolCatalog: PoolCatalogReader = {
  catalog: (profile) =>
    Promise.resolve({ profile: profile.id, pair: profile.pair, market: null, pools: [], recommended: null, readAt: new Date().toISOString() }),
  positionEmpty: () => Promise.resolve(null),
};

interface ListedPool {
  pool_id: string;
  amm_type?: string;
  token_x?: string;
  token_y?: string;
  bin_step?: number;
  active_bin?: number;
  active?: boolean;
  quotable?: boolean;
  pool_status?: string;
  x_total_fee_bps?: string;
  price_range?: { min?: string; max?: string } | null;
}

interface LadderBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

export interface RawPool {
  listed: ListedPool;
  ladder: { bins: LadderBin[]; active: number } | null;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Pure: score a pair's pools against the market and the profile's curve. */
export const rankPools = (profile: PoolProfile, raw: RawPool[], market: number | null, haltBps: number): PoolOption[] => {
  const scale = Math.pow(10, profile.baseDecimals - profile.quoteDecimals) / PRICE_SCALE;
  // A curve needs its own width of bins on each side, plus as much again before
  // a normal move pushes the price out of the range.
  const minEdge = profile.halfWidth * 2;
  const options = raw.map(({ listed, ladder }): PoolOption => {
    const activeBin = ladder ? ladder.active : num(listed.active_bin);
    const activeLadder = ladder?.bins.find((bin) => bin.bin_id === activeBin);
    const binStepBps = num(listed.bin_step);
    const low = listed.price_range?.min != null ? num(listed.price_range.min) * scale : null;
    const high = listed.price_range?.max != null ? num(listed.price_range.max) * scale : null;
    // The ladder skips empty bins, so an unfunded active bin has no row; its price
    // still follows from the range floor and the bin step.
    const price = activeLadder
      ? num(activeLadder.price) * scale
      : low != null && binStepBps > 0
        ? low * Math.pow(1 + binStepBps / 10_000, activeBin + BIN_EDGE)
        : null;
    let depth: number | null = null;
    if (ladder && price != null) {
      depth = 0;
      for (const bin of ladder.bins) {
        if (Math.abs(bin.bin_id - activeBin) > DEPTH_BINS) continue;
        depth += num(bin.reserve_y) / Math.pow(10, profile.quoteDecimals) + (num(bin.reserve_x) / Math.pow(10, profile.baseDecimals)) * price;
      }
    }
    const edgeRoom = BIN_EDGE - Math.abs(activeBin);
    const gapBps = price != null && market ? Math.round((Math.abs(price - market) / market) * 10_000) : null;
    const reasons: string[] = [];
    const usable = listed.active !== false && listed.quotable !== false && (listed.pool_status || 'active') === 'active';
    if (!usable) reasons.push('The pool is not open for trading.');
    if (binStepBps !== profile.binStepBps) reasons.push(`Bins are ${binStepBps} bps; this strategy is tuned for ${profile.binStepBps} bps.`);
    if (edgeRoom < minEdge) {
      reasons.push(activeBin > 0 ? 'The price is at the top of this pool’s range.' : 'The price is at the bottom of this pool’s range.');
    }
    if (market != null && low != null && market < low) reasons.push('The market price is below this pool’s range.');
    else if (market != null && high != null && market > high) reasons.push('The market price is above this pool’s range.');
    else if (gapBps != null && gapBps > haltBps) reasons.push(`The pool price is ${gapBps} bps from the market; the bot halts above ${haltBps}.`);
    if (market == null) reasons.push('Could not read the market price to compare.');
    if (!ladder) reasons.push('Could not read the pool’s bins.');
    return {
      poolId: listed.pool_id,
      name: listed.pool_id.split('.').pop() || listed.pool_id,
      binStepBps,
      feeBps: listed.x_total_fee_bps != null ? num(listed.x_total_fee_bps) : null,
      rangeLow: low,
      rangeHigh: high,
      price,
      activeBin,
      edgeRoom,
      depth,
      gapBps,
      ok: reasons.length === 0,
      reasons,
      recommended: false,
    };
  });
  // Depth near the price decides; room before the edge breaks a tie.
  const ranked = options.sort((a, b) => Number(b.ok) - Number(a.ok) || (b.depth ?? -1) - (a.depth ?? -1) || b.edgeRoom - a.edgeRoom);
  if (ranked[0] && ranked[0].ok) ranked[0].recommended = true;
  return ranked;
};

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
};

export const livePoolCatalog = (apiBase = DEFAULT_BASE): PoolCatalogReader => {
  const base = apiBase.replace(/\/$/, '');
  let list: { at: number; pools: ListedPool[] } | null = null;
  const ladders = new Map<string, { at: number; value: RawPool['ladder'] }>();
  const markets = new Map<string, { at: number; value: number | null }>();

  const listed = async (): Promise<ListedPool[]> => {
    if (list && Date.now() - list.at < LIST_FRESH_MS) return list.pools;
    const res = await getJson<{ pools?: ListedPool[] }>(`${base}/quotes/v2/pools`);
    list = { at: Date.now(), pools: res.pools || [] };
    return list.pools;
  };

  const ladder = async (poolId: string): Promise<RawPool['ladder']> => {
    const hit = ladders.get(poolId);
    if (hit && Date.now() - hit.at < BINS_FRESH_MS) return hit.value;
    const value = await getJson<{ success?: boolean; bins?: LadderBin[]; active_bin_id?: number | null }>(`${base}/quotes/v2/bins/${poolId}`)
      .then((res) => (res.success === false || res.active_bin_id == null ? null : { bins: res.bins || [], active: res.active_bin_id }))
      .catch(() => null);
    ladders.set(poolId, { at: Date.now(), value });
    return value;
  };

  const market = async (coingeckoId: string): Promise<number | null> => {
    const hit = markets.get(coingeckoId);
    if (hit && Date.now() - hit.at < LIST_FRESH_MS) return hit.value;
    const value = await getJson<Record<string, { usd?: number }>>(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
    )
      .then((res) => (res[coingeckoId]?.usd && res[coingeckoId].usd > 0 ? (res[coingeckoId].usd as number) : null))
      .catch(() => null);
    markets.set(coingeckoId, { at: Date.now(), value });
    return value;
  };

  return {
    catalog: async (profile, haltBps) => {
      const pair = (await listed()).filter(
        (pool) => pool.amm_type === 'dlmm' && pool.token_x === profile.baseContract && pool.token_y === profile.quoteContract,
      );
      const [price, raw] = await Promise.all([
        market(profile.coingeckoId),
        Promise.all(pair.map(async (pool) => ({ listed: pool, ladder: await ladder(pool.pool_id) }))),
      ]);
      const pools = rankPools(profile, raw, price, haltBps);
      return {
        profile: profile.id,
        pair: profile.pair,
        market: price,
        pools,
        recommended: pools.find((pool) => pool.recommended)?.poolId || null,
        readAt: new Date().toISOString(),
      };
    },
    positionEmpty: async (poolId, address) => {
      const res = await fetch(`${base}/app/v2/users/${address}/positions/${poolId}/current-bins`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!res) return null;
      const body = (await res.json().catch(() => ({}))) as { bins?: unknown[]; clean?: boolean; complete?: boolean; tipLag?: number | null; errorCode?: string };
      // A wallet the engine has never seen in this pool has nothing in it.
      if (res.status === 503 && body.errorCode === 'NODE_POSITION_NOT_REGISTERED') return true;
      if (!res.ok || body.clean !== true || body.complete !== true || body.tipLag !== 0) return null;
      return (body.bins || []).length === 0;
    },
  };
};
