import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/config';
import {
  checkEngineTip,
  fetchPoolBins,
  fetchQuotesPool,
  fetchUserBins,
  getPoolSnapshot,
  userBinLiquidity,
} from '../src/bitflow';
import { poolFeesFrom } from '../src/liquidity';
import fixtures from './fixtures/bff.json';

// These assert against payloads captured from mainnet, so they pin what the BFF
// actually returns rather than what the migration guide says it returns.

const POOL = 'dlmm_1';
const SIGNER = 'SP15VM42Q85WEKQFW9NQDKKCFNJF2NG2VBTPR6CBR';

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
});

const route = (overrides: Record<string, unknown> = {}) =>
  vi.fn(async (url: string) => {
    for (const [fragment, body] of Object.entries(overrides)) {
      // An override is either a JSON body or, to model a non-200, a full response.
      if (url.includes(fragment)) {
        return body && typeof body === 'object' && 'status' in body ? body : ok(body);
      }
    }
    if (url.includes('/quotes/v1/pools/')) return ok(fixtures.v1.pool);
    if (url.includes('/quotes/v2/pools/')) return ok(fixtures.v2.pool);
    if (url.includes('/quotes/v1/bins/')) return ok(fixtures.v1.bins);
    if (url.includes('/quotes/v2/bins/')) return ok(fixtures.v2.bins);
    if (url.includes('/current-bins')) return ok(fixtures.v2.currentBins);
    if (url.includes('/positions/')) return ok(fixtures.v1.positions);
    // Anything else (app pool, FT balances) is tolerated by the caller.
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  });

const original = CONFIG.BFF_API_VERSION;

beforeEach(() => {
  CONFIG.STACKS_CALL_MAX_RETRIES = 0;
});

afterEach(() => {
  CONFIG.BFF_API_VERSION = original;
  vi.unstubAllGlobals();
});

describe('v2 bin id domain', () => {
  it('normalizes the signed ladder onto v1 unsigned ids, value for value', async () => {
    vi.stubGlobal('fetch', route());

    CONFIG.BFF_API_VERSION = 'v1';
    const v1 = await fetchPoolBins(POOL);
    CONFIG.BFF_API_VERSION = 'v2';
    const v2 = await fetchPoolBins(POOL);

    const byId = new Map(v1.bins.map((b) => [Number(b.bin_id), b]));
    expect(v2.bins.length).toBeGreaterThan(0);
    for (const bin of v2.bins) {
      const ref = byId.get(Number(bin.bin_id));
      expect(ref, `bin ${bin.bin_id} missing from v1`).toBeDefined();
      expect(bin.reserve_x).toBe(ref!.reserve_x);
      expect(bin.reserve_y).toBe(ref!.reserve_y);
      expect(bin.price).toBe(ref!.price);
    }
    // Raw v2 ids are signed; nothing downstream should ever see a negative id.
    expect(Math.min(...v2.bins.map((b) => Number(b.bin_id)))).toBeGreaterThanOrEqual(0);
  });

  it('reports the active bin in the unsigned domain on both versions', async () => {
    vi.stubGlobal('fetch', route());

    CONFIG.BFF_API_VERSION = 'v1';
    const v1 = await fetchQuotesPool(POOL);
    CONFIG.BFF_API_VERSION = 'v2';
    const v2 = await fetchQuotesPool(POOL);

    // v1 identifies the pool by alias, v2 by contract principal...
    expect(v1.pool_id).toBe('dlmm_1');
    expect(v2.pool_id).toMatch(/\.dlmm-pool/);
    // ...but the active bin must land in the same domain either way.
    expect(fixtures.v2.pool.active_bin).toBe(139);
    expect(v2.active_bin).toBe(639);
    expect(v2.active_bin).toBe(v1.active_bin);
  });

  it('falls back to pool_id for the contract principal that v2 nulls out', async () => {
    vi.stubGlobal('fetch', route());
    CONFIG.BFF_API_VERSION = 'v2';

    const pool = await fetchQuotesPool(POOL);
    expect(fixtures.v2.pool.pool_token).toBeNull();
    expect(pool.pool_token).toBe(fixtures.v1.pool.pool_token);
    expect(pool.pool_token).toMatch(/^S[PM][0-9A-Z]+\.dlmm-pool/);
  });
});

describe('v2 inventory (current-bins)', () => {
  it('reads raw integer shares, not the human-scaled userLiquidity float', async () => {
    vi.stubGlobal('fetch', route());
    CONFIG.BFF_API_VERSION = 'v2';

    const bins = await fetchUserBins(POOL, SIGNER);
    expect(bins).toHaveLength(6);

    // The trap: v2's positions endpoint reports userLiquidity ~2.57 for a bin
    // holding 372231798 shares. Reading the float would understate by ~1.4e8.
    expect(userBinLiquidity(bins[0])).toBe(BigInt('372231798'));
    expect(userBinLiquidity({ bin_id: 1, userShares: '372231798', userLiquidity: 2.568 })).toBe(
      BigInt('372231798'),
    );
  });

  it('matches v1 share-for-share on the same wallet', async () => {
    vi.stubGlobal('fetch', route());

    CONFIG.BFF_API_VERSION = 'v1';
    const v1 = await fetchUserBins(POOL, SIGNER);
    CONFIG.BFF_API_VERSION = 'v2';
    const v2 = await fetchUserBins(POOL, SIGNER);

    const shares = (bins: Awaited<ReturnType<typeof fetchUserBins>>) =>
      new Map(bins.map((b) => [Number(b.bin_id), userBinLiquidity(b).toString()]));
    expect(shares(v2)).toEqual(shares(v1));
  });

  it('throws rather than reporting an empty position when the snapshot is dirty', async () => {
    vi.stubGlobal(
      'fetch',
      route({ '/current-bins': { ...fixtures.v2.currentBins, clean: false, errorCode: 'RECONCILE_DIRTY' } }),
    );
    CONFIG.BFF_API_VERSION = 'v2';

    await expect(fetchUserBins(POOL, SIGNER)).rejects.toThrow(/RECONCILE_DIRTY/);
  });

  it('accepts a genuinely empty book (clean + complete + no bins)', async () => {
    vi.stubGlobal(
      'fetch',
      route({ '/current-bins': { clean: true, complete: true, bins: [], overallUserShares: '0' } }),
    );
    CONFIG.BFF_API_VERSION = 'v2';

    await expect(fetchUserBins(POOL, SIGNER)).resolves.toEqual([]);
  });
});

describe('owned inventory is version-independent', () => {
  it('derives identical owned reserves from v1 and v2', async () => {
    vi.stubGlobal('fetch', route());

    CONFIG.BFF_API_VERSION = 'v1';
    const v1 = await getPoolSnapshot(POOL, SIGNER);
    CONFIG.BFF_API_VERSION = 'v2';
    const v2 = await getPoolSnapshot(POOL, SIGNER);

    expect(v2.ownedBinCount).toBe(v1.ownedBinCount);
    expect(v2.ownedBinIds).toEqual(v1.ownedBinIds);
    expect(v2.activeBinId).toBe(v1.activeBinId);
    expect(v2.ownedReserveX).toBe(v1.ownedReserveX);
    expect(v2.ownedReserveY).toBe(v1.ownedReserveY);
    expect(v2.ownedReserveX).toBeGreaterThan(BigInt(0));
  });

  it('prices owned bins that v2 nulls out in the ladder', async () => {
    // Strip every ladder liquidity value: v2 does this on low-liquidity bins, and
    // owned-bin math must survive it by using the inventory's own bin totals.
    const stripped = {
      ...fixtures.v2.bins,
      bins: fixtures.v2.bins.bins.map((b) => ({ ...b, liquidity: null })),
    };
    vi.stubGlobal('fetch', route({ '/quotes/v2/bins/': stripped }));
    CONFIG.BFF_API_VERSION = 'v2';

    const snap = await getPoolSnapshot(POOL, SIGNER);
    expect(snap.ownedReserveX).toBeGreaterThan(BigInt(0));
  });
});

describe('pool fee guard', () => {
  it('reads the same 50 bps fee table from both versions', () => {
    const v1 = poolFeesFrom(fixtures.v1.pool as never);
    expect(v1).toMatchObject({ xProtocol: 25, xProvider: 25 });
    expect(poolFeesFrom(fixtures.v2.pool as never)).toEqual(v1);
  });

  it('refuses to size an add when the BFF reports no fees at all', () => {
    // A zero fee table yields a max-fee post-condition of 0, which the contract
    // aborts against. v2 briefly served this for dlmm_1 before it was fixed.
    const zeroFees = { ...fixtures.v1.pool, x_protocol_fee: 0, x_provider_fee: 0, y_protocol_fee: 0, y_provider_fee: 0 };
    expect(() => poolFeesFrom(zeroFees as never)).toThrow(/zero fees/);
  });
});

describe('engine tip gate', () => {
  const status = (body: unknown) => route({ '/quotes/v2/status': body });

  it('passes when the engine is caught up', async () => {
    vi.stubGlobal('fetch', status({ ready: true, tip_lag: 0, state_height: 8999734 }));
    CONFIG.BFF_API_VERSION = 'v2';

    await expect(checkEngineTip()).resolves.toMatchObject({ fresh: true });
  });

  it('holds when the engine trails the chain tip', async () => {
    vi.stubGlobal('fetch', status({ ready: true, tip_lag: 3 }));
    CONFIG.BFF_API_VERSION = 'v2';

    const res = await checkEngineTip();
    expect(res.fresh).toBe(false);
    expect(res.reason).toMatch(/tip_lag=3/);
  });

  it('treats an unknown tip as stale, never as caught up', async () => {
    vi.stubGlobal('fetch', status({ ready: true, tip_lag: null }));
    CONFIG.BFF_API_VERSION = 'v2';

    await expect(checkEngineTip()).resolves.toMatchObject({ fresh: false });
  });

  it('respects a relaxed BFF_MAX_TIP_LAG policy', async () => {
    vi.stubGlobal('fetch', status({ ready: true, tip_lag: 2 }));
    CONFIG.BFF_API_VERSION = 'v2';
    CONFIG.BFF_MAX_TIP_LAG = 2;

    await expect(checkEngineTip()).resolves.toMatchObject({ fresh: true });
    CONFIG.BFF_MAX_TIP_LAG = 0;
  });

  it('is a no-op on v1, which has no tip surface', async () => {
    vi.stubGlobal('fetch', route());
    CONFIG.BFF_API_VERSION = 'v1';

    await expect(checkEngineTip()).resolves.toMatchObject({ fresh: true });
  });
});

describe('a wallet with no position yet', () => {
  // Every entrant's first tick. Neither version may report this as a failure,
  // or the api-error breaker halts the bot before it can make its first deploy.
  it('reads v1\'s 404 as an empty book rather than an error', async () => {
    vi.stubGlobal(
      'fetch',
      route({
        '/positions/': {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ detail: 'user has no pool bins' }),
        },
      }),
    );
    CONFIG.BFF_API_VERSION = 'v1';

    await expect(fetchUserBins(POOL, SIGNER)).resolves.toEqual([]);
  });

  it('names the alias/principal mix-up that v2 reports as POOL_NOT_FOUND', async () => {
    vi.stubGlobal(
      'fetch',
      route({ '/current-bins': { error: 'pool is not in the MM inventory cohort', errorCode: 'POOL_NOT_FOUND' } }),
    );
    CONFIG.BFF_API_VERSION = 'v2';

    await expect(fetchUserBins(POOL, SIGNER)).rejects.toThrow(/must be the BFF alias/);
  });
});
