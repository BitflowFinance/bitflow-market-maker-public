import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { toView } from '../src/console/model';
import { PoolCatalog, PoolCatalogReader, RawPool, rankPools } from '../src/console/pools';
import { PROFILES } from '../src/console/profiles';
import { handleConsole } from '../src/console/server';
import { ConsoleHost, ConsoleStore, HttpError } from '../src/console/store';
import { createWallet } from '../src/console/wallet';

const STX = PROFILES.stx;
const D = 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD';
const LOCAL = { host: '127.0.0.1:4173', contentType: 'application/json' };

// Raw prices are quote-micro per base-micro x 1e8; STX and USDCx are both 6 decimals.
const raw = (name: string, active: number, priceRaw: number, over: Partial<RawPool['listed']> = {}, depthReserveY = 1_000_000_000): RawPool => ({
  listed: {
    pool_id: `${D}.${name}`,
    amm_type: 'dlmm',
    token_x: STX.baseContract,
    token_y: STX.quoteContract,
    bin_step: 10,
    active_bin: active,
    active: true,
    quotable: true,
    pool_status: 'active',
    x_total_fee_bps: '50',
    price_range: { min: '16659493', max: '45262576' },
    ...over,
  },
  ladder: { active, bins: [{ bin_id: active, reserve_x: '0', reserve_y: String(depthReserveY), price: String(priceRaw) }] },
});

describe('pool ranking', () => {
  it('recommends the deepest pool that passes, and says why the rest do not', () => {
    const ranked = rankPools(
      STX,
      [
        raw('main', 100, 30_700_000, {}, 50_000_000_000),
        raw('shallow', 0, 30_710_000, {}, 10_000_000),
        raw('edge', 495, 30_700_000),
        raw('fine-bins', 0, 30_700_000, { bin_step: 1 }),
        raw('off-market', 0, 40_000_000, { price_range: { min: '10000000', max: '90000000' } }),
        raw('above', 0, 50_000_000, { price_range: { min: '40000000', max: '108000000' } }),
      ],
      0.307,
      150,
    );
    const by = (name: string) => ranked.find((pool) => pool.name === name)!;
    expect(ranked[0].name).toBe('main');
    expect(ranked[0].recommended).toBe(true);
    expect(by('shallow').ok).toBe(true);
    expect(by('shallow').recommended).toBe(false);
    expect(by('edge').reasons.join(' ')).toContain('top of this pool’s range');
    expect(by('fine-bins').reasons.join(' ')).toContain('1 bps');
    expect(by('off-market').reasons.join(' ')).toContain('halts above 150');
    expect(by('above').reasons.join(' ')).toContain('market price is below this pool’s range');
  });

  it('prices an empty active bin from the range floor instead of skipping the checks', () => {
    const empty = raw('gap', 0, 0, { price_range: { min: '40000000', max: '108000000' } });
    empty.ladder = { active: 0, bins: [] };
    const [pool] = rankPools(STX, [empty], 0.307, 150);
    expect(pool.price).toBeCloseTo(0.4 * Math.pow(1.001, 500), 4);
    expect(pool.ok).toBe(false);
  });
});

const NEXT = `${D}.dlmm-pool-stx-usdcx-v-3-bps-10`;

class Host implements ConsoleHost {
  alive_ = new Set<number>();
  seq = 100;
  manual: string[][] = [];
  spawn(): number {
    this.seq += 1;
    this.alive_.add(this.seq);
    return this.seq;
  }
  stop(pid: number): void {
    this.alive_.delete(pid);
  }
  alive(pid: number): boolean {
    return this.alive_.has(pid);
  }
  runManual(_profile: string, args: string[]): Promise<string> {
    this.manual.push(args);
    return Promise.resolve('[10:00:00.000] INFO (1): [index] withdraw_liquidity tx=0xabc ok=true status="success"\n');
  }
  readRemote(): Promise<{ history: []; log: string }> {
    return Promise.resolve({ history: [], log: '' });
  }
}

const catalogWith = (empties: Array<boolean | null>): PoolCatalogReader & { checks: number } => {
  const reader = {
    checks: 0,
    catalog: (): Promise<PoolCatalog> =>
      Promise.resolve({
        profile: 'stx',
        pair: STX.pair,
        market: 0.307,
        recommended: STX.poolId,
        readAt: '',
        pools: rankPools(STX, [raw('dlmm-pool-stx-usdcx-v-1-bps-10', 100, 30_700_000), raw('dlmm-pool-stx-usdcx-v-3-bps-10', 0, 30_700_000)], 0.307, 150),
      }),
    positionEmpty: (): Promise<boolean | null> => {
      const value = empties[Math.min(reader.checks, empties.length - 1)];
      reader.checks += 1;
      return Promise.resolve(value);
    },
  };
  return reader;
};

const setup = async (empties: Array<boolean | null>, live: boolean) => {
  const root = mkdtempSync(join(tmpdir(), 'mm-pools-'));
  const host = new Host();
  const pools = catalogWith(empties);
  const store = new ConsoleStore(root, host, { prepare: () => Promise.reject(new Error('off')), notify: () => Promise.reject(new Error('off')) }, Date.now(), undefined, pools);
  store.wait = () => Promise.resolve();
  const call = async (method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    try {
      return await handleConsole(store, { method, path, query, headers: LOCAL, body: body ? JSON.stringify(body) : '' }, Date.now());
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.code, message: err.message } };
      throw err;
    }
  };
  await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: createWallet().key });
  if (live) {
    const envPath = join(root, '.env.stx');
    writeFileSync(envPath, readFileSync(envPath, 'utf8').replace('EXECUTION_MODE=dry_run', 'EXECUTION_MODE=live'));
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { root, host, store, pools, call, settle };
};

const confirm = { acknowledged: true, poolName: 'STX / USDCx' };

describe('pool change', () => {
  it('withdraws, confirms the old pool is empty, then moves the bot and leaves it paused', async () => {
    const { root, host, store, pools, call, settle } = await setup([false, true], true);
    const started = await call('POST', '/api/bots/stx/pool', { poolId: NEXT, ...confirm });
    expect(started.status).toBe(200);
    for (let i = 0; i < 5; i += 1) await settle();
    const bot = await store.one('stx', Date.now());
    expect(bot.poolSwitch?.status).toBe('done');
    expect(host.manual[0]).toEqual(['--withdraw-liquidity', '--pct', '100']);
    expect(pools.checks).toBe(2);
    expect(readFileSync(join(root, '.env.stx'), 'utf8')).toContain(`POOL_ID=${NEXT}`);
    expect(bot.paused).toBe(true);
    expect(bot.running).toBe(true);
    expect(bot.poolSwitch?.lines.some((line) => line.text.includes('tx=0xabc'))).toBe(true);
  });

  it('changes nothing while the old pool still holds liquidity', async () => {
    const { root, store, call, settle } = await setup([false], false);
    await call('POST', '/api/bots/stx/pool', { poolId: NEXT, ...confirm });
    for (let i = 0; i < 5; i += 1) await settle();
    const bot = await store.one('stx', Date.now());
    expect(bot.poolSwitch?.status).toBe('failed');
    expect(readFileSync(join(root, '.env.stx'), 'utf8')).toContain(`POOL_ID=${STX.poolId}`);
  });

  it('refuses another pair’s pool, the same pool, and an unconfirmed change', async () => {
    const { call } = await setup([true], false);
    expect(((await call('POST', '/api/bots/stx/pool', { poolId: `${D}.dlmm-pool-sbtc-usdcx-v-1-bps-10`, ...confirm })).body as { error: string }).error).toBe('unknown_pool');
    expect(((await call('POST', '/api/bots/stx/pool', { poolId: STX.poolId, ...confirm })).body as { error: string }).error).toBe('same_pool');
    expect(((await call('POST', '/api/bots/stx/pool', { poolId: NEXT, acknowledged: true, poolName: 'nope' })).body as { error: string }).error).toBe('confirm');
  });

  it('lists the pools and lets a new bot start in a chosen one', async () => {
    const { root, call } = await setup([true], false);
    const list = await call('GET', '/api/pools', undefined, { profile: 'stx' });
    expect((list.body as PoolCatalog).recommended).toBe(STX.poolId);
    const root2 = mkdtempSync(join(tmpdir(), 'mm-pools-'));
    void root;
    const store2 = new ConsoleStore(root2, new Host(), { prepare: () => Promise.reject(new Error('off')), notify: () => Promise.reject(new Error('off')) }, Date.now(), undefined, catalogWith([true]));
    await handleConsole(store2, { method: 'POST', path: '/api/bots', headers: LOCAL, body: JSON.stringify({ profile: 'stx', wallet: 'create', poolId: NEXT }) }, Date.now());
    expect(readFileSync(join(root2, '.env.stx'), 'utf8')).toMatch(new RegExp(`^POOL_ID=${NEXT.replace('.', '\\.')}$`, 'm'));
  });
});

describe('near the edge of a pool', () => {
  it('asks for attention once the price is within three curve widths of the range end', () => {
    const record = (activeBinId: number) => ({
      id: 'stx',
      profile: 'stx',
      preview: false,
      pair: 'STX / USDCx',
      poolId: STX.poolId,
      baseSymbol: 'STX',
      quoteSymbol: 'USDCx',
      running: true,
      paused: false,
      mode: 'live' as const,
      keySet: true,
      address: 'SP1',
      env: { CURVE_HALF_WIDTH_BINS: '13' },
      lastTick: { t: new Date().toISOString(), decision: 'hold', reason: 'in_range', activeBinId, activeBinPrice: 0.3 },
      history: [],
      logs: [],
      bins: [],
      binsHavePoolDepth: false,
    });
    expect(toView(record(970), false, Date.now()).needs.map((need) => need.id)).toEqual(['stx:edge']);
    expect(toView(record(970), false, Date.now()).poolEdgeRoom).toBe(30);
    expect(toView(record(600), false, Date.now()).needs).toEqual([]);
  });
});
