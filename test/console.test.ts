import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { checkBridgeInput, xOnlyKey } from '../src/console/bridgeLive';
import { bookOf, humanReason, parseLogLine, validateSettings } from '../src/console/model';
import { decimalToMicro } from '../src/console/money';
import { handleConsole, RequestHeaders } from '../src/console/server';
import { BridgeClient, BridgeInput, BridgeJob, ConsoleHost, ConsoleStore, HttpError, manualOutcome } from '../src/console/store';
import { createWallet } from '../src/console/wallet';
import { checkMemo, checkPayoutAddress, stxSweepAmount } from '../src/payout';

const LOCAL = { host: '127.0.0.1:4173', contentType: 'application/json' };
const PAGE = { host: '127.0.0.1:5191', origin: 'http://127.0.0.1:5191', secFetchSite: 'same-origin', contentType: 'application/json' };

class MemHost implements ConsoleHost {
  aliveIds = new Set<number>();
  seq = 1000;
  manual: string[][] = [];
  root = '';
  dataDirAtSpawn: boolean[] = [];

  spawn(): number {
    if (this.root) this.dataDirAtSpawn.push(existsSync(join(this.root, 'data')));
    this.seq += 1;
    this.aliveIds.add(this.seq);
    return this.seq;
  }

  stop(pid: number): void {
    this.aliveIds.delete(pid);
  }

  alive(pid: number): boolean {
    return this.aliveIds.has(pid);
  }

  manualOutput = 'manual ok';
  manualGate: Promise<void> | null = null;

  async runManual(_profile: string, args: string[], opts?: { onOutput?: (text: string) => void }): Promise<string> {
    this.manual.push(args);
    if (this.manualGate) await this.manualGate;
    if (opts?.onOutput) opts.onOutput(this.manualOutput);
    return this.manualOutput;
  }

  readRemote(): Promise<{ history: []; log: string }> {
    return Promise.resolve({ history: [], log: '' });
  }
}

const fakeBridge = (): { client: BridgeClient; seen: BridgeInput[] } => {
  const seen: BridgeInput[] = [];
  const client: BridgeClient = {
    prepare: (input) => {
      seen.push(input);
      const job: BridgeJob = {
        id: '',
        botId: input.botId,
        pair: '',
        direction: input.direction,
        amount: input.amount,
        status: 'needs_deposit',
        message: 'Send BTC to the deposit address.',
        depositAddress: 'bc1qexample',
        stacksAddress: input.stacksAddress,
      };
      return Promise.resolve(job);
    },
    notify: (job, txid) => Promise.resolve({ ...job, status: 'pending', message: txid }),
  };
  return { client, seen };
};

const boot = () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-ui-'));
  const host = new MemHost();
  host.root = root;
  const bridge = fakeBridge();
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new ConsoleStore(root, host, bridge.client, now);
  const call = async (method: string, path: string, body?: unknown, headers: RequestHeaders = LOCAL) => {
    try {
      return await handleConsole(store, { method, path, headers, body: body ? JSON.stringify(body) : '' }, now);
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.code, message: err.message } };
      throw err;
    }
  };
  return { root, host, bridge, now, store, call };
};

describe('local console', () => {
  it('answers the page and local tools without a code', async () => {
    const { call } = boot();
    const page = await call('GET', '/api/fleet', undefined, { host: '127.0.0.1:5191', origin: 'http://127.0.0.1:5191', secFetchSite: 'same-origin' });
    expect(page.status).toBe(200);
    const agent = await call('POST', '/api/bots/preview-sbtc/pause', undefined, { host: 'localhost:4173', contentType: 'application/json' });
    expect(agent.status).toBe(200);
  });

  it('refuses calls from other websites and non-local hostnames', async () => {
    const { call } = boot();
    const otherSite = await call('POST', '/api/bots/preview-sbtc/pause', undefined, {
      host: '127.0.0.1:5191',
      origin: 'https://evil.example',
      contentType: 'application/json',
    });
    expect(otherSite.status).toBe(403);
    const fetchMeta = await call('GET', '/api/fleet', undefined, { host: '127.0.0.1:5191', secFetchSite: 'cross-site' });
    expect(fetchMeta.status).toBe(403);
    const rebound = await call('GET', '/api/fleet', undefined, { host: 'evil.example:4173' });
    expect(rebound.status).toBe(403);
    const formPost = await call('POST', '/api/bots/preview-sbtc/pause', undefined, { host: '127.0.0.1:4173', contentType: 'text/plain' });
    expect(formPost.status).toBe(415);
  });

  it('keeps bridging turned off for now', async () => {
    const { call } = boot();
    const bridge = await call('POST', '/api/bridge', { botId: 'sbtc', direction: 'btc_to_sbtc', amount: '0.01' });
    expect(bridge.status).toBe(404);
    const profiles = await call('GET', '/api/profiles');
    expect(JSON.stringify(profiles.body)).not.toContain('bridge');
  });

  it('starts with preview bots that have fake funds and no wallet', async () => {
    const { call } = boot();
    const res = await call('GET', '/api/fleet');
    expect(res.status).toBe(200);
    const body = res.body as { bots: Array<{ id: string; preview: boolean; address: string | null; keySet: boolean; walletBase: number }> };
    const preview = body.bots.find((bot) => bot.id === 'preview-sbtc');
    expect(preview?.preview).toBe(true);
    expect(preview?.address).toBeNull();
    expect(preview?.keySet).toBe(false);
    expect(preview?.walletBase).toBeGreaterThan(0);
  });

  it('keeps preview balances when paused', async () => {
    const { call } = boot();
    const before = (await call('GET', '/api/bots/preview-sbtc')).body as { walletBase: number };
    const paused = await call('POST', '/api/bots/preview-sbtc/pause');
    const bot = paused.body as { decision: string; holdingsCarried: boolean; walletBase: number; reasonRaw: string; reason: { kind: string } };
    expect(bot.decision).toBe('frozen');
    expect(bot.reasonRaw).toBe('kill_switch');
    expect(bot.reason.kind).toBe('paused');
    expect(bot.holdingsCarried).toBe(true);
    expect(bot.walletBase).toBe(before.walletBase);
  });

  it('labels a preview by what it is doing, since the badge already says preview', async () => {
    const { call } = boot();
    const label = async (path: string) => ((await call('POST', path)).body as { state: { label: string } }).state.label;
    expect(((await call('GET', '/api/bots/preview-sbtc')).body as { state: { label: string } }).state.label).toBe('Running');
    expect(await label('/api/bots/preview-sbtc/pause')).toBe('Paused');
    expect(await label('/api/bots/preview-sbtc/stop')).toBe('Stopped');
  });

  it('does not call an empty book zero', () => {
    const book = bookOf([]);
    expect(book.real.label).toBe('No bots running');
    expect(book.real.value).toBeNull();
  });

  it('writes a new dry-run bot without returning the private key', async () => {
    const { call, root } = boot();
    const wallet = createWallet();
    const created = await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    expect(created.status).toBe(200);
    const text = JSON.stringify(created.body);
    expect(text).not.toContain(wallet.key);
    expect(text).toContain(wallet.address);
    const env = readFileSync(join(root, '.env.sbtc'), 'utf8');
    expect(env).toContain(`SIGNER_KEY=${wallet.key}`);
    expect(env).toContain('EXECUTION_MODE=dry_run');
    const bot = (created.body as { bot: { mode: string; keySet: boolean; needs: Array<{ id: string }> } }).bot;
    expect(bot.mode).toBe('dry_run');
    expect(bot.keySet).toBe(true);
    expect(bot.needs.some((item) => item.id.endsWith(':nocheck'))).toBe(true);
  });

  it('flags two bots that share a wallet', async () => {
    const { call } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: wallet.key });
    const fleet = await call('GET', '/api/fleet');
    const bots = (fleet.body as { bots: Array<{ id: string; checklist: Array<{ id: string; ok: boolean }> }> }).bots;
    const real = bots.find((bot) => bot.id === 'sbtc');
    expect(real?.checklist.find((item) => item.id === 'one-wallet')?.ok).toBe(false);
  });

  it('refuses manual trades in dry run, and a withdraw that is not paused', async () => {
    const { call, host, root } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    const dry = await call('POST', '/api/bots/sbtc/manual', {
      action: 'swap',
      amount: '1',
      side: 'quote',
      acknowledged: true,
      poolName: 'sBTC / USDCx',
    });
    expect(dry.status).toBe(409);
    expect((dry.body as { error: string }).error).toBe('dry_run');
    expect(host.manual.length).toBe(0);

    const envPath = join(root, '.env.sbtc');
    const env = readFileSync(envPath, 'utf8').replace('EXECUTION_MODE=dry_run', 'EXECUTION_MODE=live');
    writeFileSync(envPath, env);
    for (const action of [{ action: 'withdraw', pct: 100 }, { action: 'swap', side: 'quote', amount: '1' }, { action: 'add', xAmount: '0.001', yAmount: '1' }]) {
      const early = await call('POST', '/api/bots/sbtc/manual', { ...action, acknowledged: true, poolName: 'sBTC / USDCx' });
      expect((early.body as { error: string }).error).toBe('pause_first');
    }

    // A stopped bot has no loop to race, so it needs no pause.
    await call('POST', '/api/bots/sbtc/stop');
    expect((await call('POST', '/api/bots/sbtc/manual', { action: 'swap', side: 'quote', amount: '1', acknowledged: true, poolName: 'sBTC / USDCx' })).status).toBe(200);
    await call('POST', '/api/bots/sbtc/start');
    await call('POST', '/api/bots/sbtc/pause');
    const sent = await call('POST', '/api/bots/sbtc/manual', {
      action: 'withdraw',
      pct: 100,
      acknowledged: true,
      poolName: 'sBTC / USDCx',
    });
    expect(sent.status).toBe(200);
    expect(host.manual[host.manual.length - 1]).toEqual(['--withdraw-liquidity', '--pct', '100']);
  });

  it('asks before leaving dry run, then restarts', async () => {
    const { call, host, root } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    writeFileSync(
      join(root, 'data', 'metrics.sbtc.jsonl'),
      `${JSON.stringify({ t: '2026-01-01T00:00:00.000Z', decision: 'hold', reason: 'in_range', activeBinPrice: 100000, portfolioValue: 10, walletBase: 0, walletQuote: 10, ownedBase: 0, ownedQuote: 0 })}\n`,
    );
    const blocked = await call('POST', '/api/bots/sbtc/settings', { settings: { EXECUTION_MODE: 'live' } });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: string }).error).toBe('confirm_live');
    const before = host.aliveIds.size;
    const live = await call('POST', '/api/bots/sbtc/settings', {
      settings: { EXECUTION_MODE: 'live' },
      confirmLive: true,
      poolName: 'sBTC / USDCx',
    });
    expect(live.status).toBe(200);
    expect((live.body as { mode: string }).mode).toBe('live');
    expect(host.aliveIds.size).toBe(before);
    const secret = await call('POST', '/api/bots/sbtc/settings', { settings: { SIGNER_KEY: 'nope' } });
    expect(secret.status).toBe(400);
  });

  it('resets profit by touching the request file', async () => {
    const { call, root } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: wallet.key });
    const res = await call('POST', '/api/bots/stx/baseline-reset');
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'data', 'metrics-baseline.stx.json.reset'), 'utf8').length).toBeGreaterThan(0);
  });

  it('refuses to bridge a preview and confirms a real deposit (store only while the route is off)', async () => {
    const { call, bridge, store } = boot();
    const base = { direction: 'btc_to_sbtc', amount: '0.01', poolName: 'sBTC / USDCx' };
    await expect(store.startBridge({ ...base, botId: 'preview-sbtc', acknowledged: true })).rejects.toMatchObject({ status: 409 });
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    await expect(store.startBridge({ ...base, botId: 'sbtc', acknowledged: false })).rejects.toMatchObject({ status: 409 });
    const job = await store.startBridge({ ...base, botId: 'sbtc', acknowledged: true, reclaimPublicKey: '11'.repeat(32) });
    expect(job.depositAddress).toBe('bc1qexample');
    expect(JSON.stringify(job)).not.toContain(wallet.key);
    expect(bridge.seen[0].stacksAddress).toBe(wallet.address);
  });

  it('creates the data folder before starting a new bot', async () => {
    const { call, host } = boot();
    const wallet = createWallet();
    const created = await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: wallet.key });
    expect(created.status).toBe(200);
    expect(host.dataDirAtSpawn).toEqual([true]);
  });

  it('keeps preview funds out of the real book', async () => {
    const { call, root } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    writeFileSync(
      join(root, 'data', 'metrics.sbtc.jsonl'),
      `${JSON.stringify({ t: '2026-01-01T00:00:00.000Z', decision: 'hold', reason: 'in range; holding shaped position (f=0.380)', activeBinPrice: 100000, portfolioValue: 12.5, walletBase: 0, walletQuote: 12.5, ownedBase: 0, ownedQuote: 0 })}\n`,
    );
    const fleet = await call('GET', '/api/fleet');
    const book = (fleet.body as { book: { real: { value: number; botCount: number }; preview: { botCount: number; value: number } } }).book;
    expect(book.real.botCount).toBe(1);
    expect(book.real.value).toBeCloseTo(12.5, 6);
    expect(book.preview.botCount).toBe(2);
    expect(book.preview.value).toBeGreaterThan(100);
  });

  it('never lists preview bots under Needs you', async () => {
    const { call } = boot();
    await call('POST', '/api/bots/preview-sbtc/stop');
    const fleet = await call('GET', '/api/fleet');
    expect((fleet.body as { needs: unknown[] }).needs).toEqual([]);
  });

  it('flags low gas and a stopped bot once, not twice', async () => {
    const { call, root, host } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    host.aliveIds.clear();
    let fleet = await call('GET', '/api/fleet');
    let needs = (fleet.body as { needs: Array<{ id: string }> }).needs.map((item) => item.id);
    expect(needs).toEqual(['sbtc:stopped']);

    await call('POST', '/api/bots/sbtc/start');
    writeFileSync(
      join(root, 'data', 'metrics.sbtc.jsonl'),
      `${JSON.stringify({ t: '2026-01-01T00:00:00.000Z', decision: 'hold', reason: 'wallet_stx=0.01 cannot cover 3-step fees (~0.15); top up STX', activeBinPrice: 100000, portfolioValue: 5, walletBase: 0, walletQuote: 5, ownedBase: 0, ownedQuote: 0 })}\n`,
    );
    fleet = await call('GET', '/api/fleet');
    needs = (fleet.body as { needs: Array<{ id: string }> }).needs.map((item) => item.id);
    expect(needs).toEqual(['sbtc:gas']);
  });

  it('marks pools that already have a bot', async () => {
    const { call } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: wallet.key });
    const res = await call('GET', '/api/profiles');
    const profiles = (res.body as { profiles: Array<{ id: string; taken: boolean }> }).profiles;
    expect(profiles.find((item) => item.id === 'stx')?.taken).toBe(true);
    expect(profiles.find((item) => item.id === 'sbtc')?.taken).toBe(false);
  });

  it('explains bot reasons in plain words', () => {
    expect(humanReason('pool/external divergence 180bps > halt 150bps', 'frozen').kind).toBe('halt');
    expect(humanReason('reference feed stale 400000ms > halt 300000ms', 'frozen').kind).toBe('halt');
    expect(humanReason('in range; holding shaped position (f=0.380)', 'hold').kind).toBe('holding');
    expect(humanReason('reposition: drift 7 bins; rebuild curve on active bin 512', 'rebalance').kind).toBe('rebuild');
    expect(humanReason('nonce gap detected (missing [4]); holding until cleared', 'hold').kind).toBe('stuck');
    expect(humanReason('kill_switch', 'frozen').kind).toBe('paused');
  });

  it('reads pretty and JSON log lines', () => {
    const pretty = parseLogLine('\u001b[32m[10:15:02.123] INFO (4242): [index] scheduling ticks every 120000ms\u001b[39m');
    expect(pretty).toEqual({ t: '10:15:02', level: 'info', text: '[index] scheduling ticks every 120000ms' });
    const json = parseLogLine('{"level":40,"time":1767225600000,"msg":"[mm] low gas"}');
    expect(json.level).toBe('warn');
    expect(json.text).toBe('[mm] low gas');
  });

  it('rejects settings that do not make sense', () => {
    expect(validateSettings({ CURVE_DECAY: 'abc' }, {})).toContain('CURVE_DECAY');
    expect(validateSettings({ F_STAR: '0.6' }, { F_SOFT: '0.52', F_HARD: '0.67' })).toContain('F_STAR');
    expect(validateSettings({ ENABLE_SWAP: 'yes' }, {})).toContain('ENABLE_SWAP');
    expect(validateSettings({ CURVE_HALF_WIDTH_BINS: '8' }, {})).toBe('');
  });

  it('checks a bridge request before touching the network', () => {
    const base = { botId: 'sbtc', amount: '0.01', stacksAddress: 'SP000', reclaimPublicKey: '', bitcoinAddress: '' };
    expect(checkBridgeInput({ ...base, direction: 'usdc_to_usdcx' })).toContain('not built into the page yet');
    expect(checkBridgeInput({ ...base, direction: 'btc_to_sbtc', amount: '0.0001', reclaimPublicKey: '11'.repeat(32) })).toContain('at least');
    expect(checkBridgeInput({ ...base, direction: 'btc_to_sbtc' })).toContain('public key');
    expect(checkBridgeInput({ ...base, direction: 'btc_to_sbtc', reclaimPublicKey: `02${'ab'.repeat(32)}` })).toBe('');
    expect(xOnlyKey(`03${'ab'.repeat(32)}`)).toBe('ab'.repeat(32));
  });

  it('converts whole tokens to micro units', () => {
    expect(decimalToMicro('0.01', 8)).toBe('1000000');
    expect(decimalToMicro('1.5', 6)).toBe('1500000');
  });

  it('upgrades a legacy pool alias in an existing env file to the contract id', () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-ui-'));
    writeFileSync(join(root, '.env.sbtc'), 'POOL_ID=dlmm_1\nEXECUTION_MODE=dry_run\n');
    new ConsoleStore(root, new MemHost(), fakeBridge().client, Date.now());
    const env = readFileSync(join(root, '.env.sbtc'), 'utf8');
    expect(env).toContain('POOL_ID=SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10');
    expect(env).toContain('EXECUTION_MODE=dry_run');
  });

  it('keeps an old STX file on the pool it named, while new STX bots get the main pool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-ui-'));
    writeFileSync(join(root, '.env.stx'), 'POOL_ID=dlmm_14\n');
    new ConsoleStore(root, new MemHost(), fakeBridge().client, Date.now());
    expect(readFileSync(join(root, '.env.stx'), 'utf8')).toContain('dlmm-pool-stx-usdcx-v-2-bps-10');

    writeFileSync(join(root, '.env.stx'), 'POOL_ID=dlmm_3\n');
    new ConsoleStore(root, new MemHost(), fakeBridge().client, Date.now());
    expect(readFileSync(join(root, '.env.stx'), 'utf8')).toContain('dlmm-pool-stx-usdcx-v-1-bps-10');

    const fresh = boot();
    await fresh.call('POST', '/api/bots', { profile: 'stx', wallet: 'create' });
    expect(readFileSync(join(fresh.root, '.env.stx'), 'utf8')).toMatch(/^POOL_ID=SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD\.dlmm-pool-stx-usdcx-v-1-bps-10$/m);
  });

  it('reads a manual run’s outcome from its output instead of assuming success', () => {
    const fail = (text: string) => `[10:00:00.000] INFO: [index] starting\n\u001b[31m[10:00:01.000] ERROR: [index] ${text}\u001b[39m\n`;
    expect(manualOutcome(fail('withdraw liquidity prepare failed error="no withdrawable positions found"'))).toEqual({ ok: false, message: 'There is nothing in the pool to withdraw.' });
    expect(manualOutcome(fail('fatal error="stx cannot cover tx fee balance=0 fee=0.05"')).message).toContain('enough STX');
    expect(manualOutcome('[10:00:02.000] INFO: [index] swap tx=0xabc ok=false status="abort_by_post_condition"\n').ok).toBe(false);
    expect(manualOutcome('[10:00:02.000] INFO: [index] withdraw_liquidity tx=0xabc ok=true status="success"\n')).toEqual({ ok: true, message: 'withdraw_liquidity tx=0xabc ok=true status="success"' });
    expect(manualOutcome('').ok).toBe(false);
  });

  it('sets API keys only from the page and never returns them', async () => {
    const { call, root } = boot();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: createWallet().key });
    const key = 'hiro_live_abcdef1234567890';
    expect((await call('POST', '/api/bots/sbtc/api-key', { name: 'STACKS_NODE_KEY', value: key })).status).toBe(403);
    expect((await call('POST', '/api/bots/sbtc/api-key', { name: 'SIGNER_KEY', value: key }, PAGE)).status).toBe(400);
    expect((await call('POST', '/api/bots/sbtc/api-key', { name: 'STACKS_NODE_KEY', value: 'has spaces in it' }, PAGE)).status).toBe(400);
    const saved = await call('POST', '/api/bots/sbtc/api-key', { name: 'STACKS_NODE_KEY', value: key }, PAGE);
    expect((saved.body as { keysSet: Record<string, boolean> }).keysSet.STACKS_NODE_KEY).toBe(true);
    expect(JSON.stringify((await call('GET', '/api/fleet')).body)).not.toContain(key);
    expect(readFileSync(join(root, '.env.sbtc'), 'utf8')).toContain(`STACKS_NODE_KEY=${key}`);
    expect((await call('POST', '/api/bots/sbtc/settings', { settings: { STACKS_NODE_KEY: 'x' } })).status).toBe(400);
  });

  it('does not start a stopped bot when its settings are saved', async () => {
    const { call, host } = boot();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: createWallet().key });
    await call('POST', '/api/bots/sbtc/stop');
    const spawned = host.seq;
    const saved = await call('POST', '/api/bots/sbtc/settings', { settings: { CURVE_HALF_WIDTH_BINS: '7' } });
    expect(saved.status).toBe(200);
    expect((saved.body as { running: boolean }).running).toBe(false);
    expect(host.seq).toBe(spawned);
  });

  it('ignores a pid file that names some other process', async () => {
    const { call, host, root } = boot();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: createWallet().key });
    // The page restarts and finds the old pid file, whose number now belongs to something else.
    (host as unknown as { isBot: (pid: number, profile: string) => boolean }).isBot = () => false;
    const store = new ConsoleStore(root, host, fakeBridge().client, Date.now());
    const view = await store.one('sbtc', Date.now());
    expect(view.running).toBe(false);
    const alive = host.aliveIds.size;
    await store.stop('sbtc');
    expect(host.aliveIds.size).toBe(alive);
  });

  it('keeps env files private to this user', async () => {
    const { call, root, host } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: wallet.key });
    expect(statSync(join(root, '.env.sbtc')).mode & 0o777).toBe(0o600);

    writeFileSync(join(root, '.env.stx'), `SIGNER_KEY=${wallet.key}\n`, { mode: 0o644 });
    new ConsoleStore(root, host, fakeBridge().client, Date.now());
    expect(statSync(join(root, '.env.stx')).mode & 0o777).toBe(0o600);
  });

  it('shows a new key only to the page, and records the backup once the user proves they have it', async () => {
    const { call } = boot();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'create' });
    const before = (await call('GET', '/api/bots/sbtc')).body as { keyBackedUp: boolean; checklist: Array<{ id: string; ok: boolean }> };
    expect(before.keyBackedUp).toBe(false);
    expect(before.checklist.find((item) => item.id === 'backup')?.ok).toBe(false);

    const agent = await call('POST', '/api/bots/sbtc/key-backup', { acknowledged: true });
    expect(agent.status).toBe(403);
    const unconfirmed = await call('POST', '/api/bots/sbtc/key-backup', {}, PAGE);
    expect(unconfirmed.status).toBe(409);
    const shown = await call('POST', '/api/bots/sbtc/key-backup', { acknowledged: true }, PAGE);
    expect(shown.status).toBe(200);
    const key = (shown.body as { key: string }).key;
    expect(key).toMatch(/^[0-9a-f]{64}(01)?$/);

    expect((await call('POST', '/api/bots/sbtc/key-saved', { keyTail: 'zzzz' }, PAGE)).status).toBe(400);
    expect((await call('POST', '/api/bots/sbtc/key-saved', { keyTail: key.slice(-4) })).status).toBe(403);
    const saved = await call('POST', '/api/bots/sbtc/key-saved', { keyTail: key.slice(-4) }, PAGE);
    expect(saved.status).toBe(200);
    const after = saved.body as { keyBackedUp: boolean; keyBackupAt: string | null };
    expect(after.keyBackedUp).toBe(true);
    expect(after.keyBackupAt).not.toBeNull();
    expect(JSON.stringify((await call('GET', '/api/fleet')).body)).not.toContain(key);
  });

  it('does not ask to back up an imported key', async () => {
    const { call } = boot();
    const wallet = createWallet();
    await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: wallet.key });
    const bot = (await call('GET', '/api/bots/stx')).body as { keyBackedUp: boolean; keySource: string };
    expect(bot.keySource).toBe('import');
    expect(bot.keyBackedUp).toBe(true);
  });

  it('only lets the page set the payout address, and checks it', async () => {
    const { call } = boot();
    const bot = createWallet();
    const mine = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: bot.key });
    const tail = mine.address.slice(-4);

    expect((await call('POST', '/api/bots/sbtc/payout', { address: mine.address, addressTail: tail })).status).toBe(403);
    const viaSettings = await call('POST', '/api/bots/sbtc/settings', { settings: { PAYOUT_ADDRESS: mine.address } });
    expect(viaSettings.status).toBe(400);

    const own = await call('POST', '/api/bots/sbtc/payout', { address: bot.address, addressTail: bot.address.slice(-4) }, PAGE);
    expect((own.body as { message: string }).message).toContain('own wallet');
    const contract = await call('POST', '/api/bots/sbtc/payout', { address: `${mine.address}.vault`, addressTail: 'ault' }, PAGE);
    expect(contract.status).toBe(400);
    const wrongTail = await call('POST', '/api/bots/sbtc/payout', { address: mine.address, addressTail: 'XXXX' }, PAGE);
    expect((wrongTail.body as { error: string }).error).toBe('payout_tail');

    const saved = await call('POST', '/api/bots/sbtc/payout', { address: mine.address, memo: '12345', addressTail: tail }, PAGE);
    expect(saved.status).toBe(200);
    expect((saved.body as { payoutAddress: string; payoutMemo: string }).payoutAddress).toBe(mine.address);
    expect((saved.body as { payoutMemo: string }).payoutMemo).toBe('12345');
  });

  it('cashes out in dry run to the saved address, after pausing and stopping the bot', async () => {
    const { call, host, root, store } = boot();
    const bot = createWallet();
    const mine = createWallet();
    await call('POST', '/api/bots', { profile: 'sbtc', wallet: 'import', signerKey: bot.key });
    const confirm = { acknowledged: true, poolName: 'sBTC / USDCx' };

    expect(((await call('POST', '/api/bots/preview-sbtc/cash-out', confirm)).body as { error: string }).error).toBe('preview');
    expect(((await call('POST', '/api/bots/sbtc/cash-out', confirm)).body as { error: string }).error).toBe('no_payout');
    await call('POST', '/api/bots/sbtc/payout', { address: mine.address, addressTail: mine.address.slice(-4) }, PAGE);
    expect(((await call('POST', '/api/bots/sbtc/cash-out', { acknowledged: true, poolName: 'nope' })).body as { error: string }).error).toBe('confirm');
    expect(host.manual.length).toBe(0);

    let release: () => void = () => undefined;
    host.manualGate = new Promise((resolve) => {
      release = resolve;
    });
    host.manualOutput = '[10:00:00.000] INFO (1): [token_meta] noise\n[10:00:01.000] INFO (1): [cashout] done to=x stx_left=0\n';
    const started = await call('POST', '/api/bots/sbtc/cash-out', confirm);
    expect(started.status).toBe(200);
    expect((started.body as { status: string; to: string }).to).toBe(mine.address);
    expect(host.manual[0]).toEqual(['--cash-out', '--to', mine.address]);
    expect(existsSync(join(root, 'data', 'kill.sbtc'))).toBe(true);
    const during = (await call('GET', '/api/bots/sbtc')).body as { running: boolean; paused: boolean; cashOut: { status: string } };
    expect(during.running).toBe(false);
    expect(during.paused).toBe(true);
    expect(during.cashOut.status).toBe('running');
    expect(((await call('POST', '/api/bots/sbtc/start')).body as { error: string }).error).toBe('cashing_out');

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const job = (await store.one('sbtc', Date.now())).cashOut;
    expect(job?.status).toBe('done');
    expect(job?.lines.map((line) => line.text)).toEqual(['[cashout] done to=x stx_left=0']);
  });

  it('marks a cash out that did not finish as failed', async () => {
    const { call, host, store } = boot();
    const bot = createWallet();
    const mine = createWallet();
    await call('POST', '/api/bots', { profile: 'stx', wallet: 'import', signerKey: bot.key });
    await call('POST', '/api/bots/stx/payout', { address: mine.address, memo: 'm1', addressTail: mine.address.slice(-4) }, PAGE);
    host.manualOutput = '[10:00:01.000] ERROR (1): [cashout] failed error="stx cannot cover tx fee"\n';
    await call('POST', '/api/bots/stx/cash-out', { acknowledged: true, poolName: 'STX / USDCx' });
    expect(host.manual[0]).toEqual(['--cash-out', '--to', mine.address, '--memo', 'm1']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await store.one('stx', Date.now())).cashOut?.status).toBe('failed');
  });

  it('checks payout addresses and memos, and leaves the fee when sweeping STX', () => {
    const bot = createWallet().address;
    const mine = createWallet().address;
    expect(checkPayoutAddress(mine, bot)).toBe('');
    expect(checkPayoutAddress(bot, bot)).toContain('own wallet');
    expect(checkPayoutAddress('', bot)).toContain('Enter');
    expect(checkPayoutAddress('SPnotreal', bot)).toContain('valid');
    expect(checkPayoutAddress(mine, bot, false)).toContain('testnet');
    expect(checkMemo('a'.repeat(34))).toBe('');
    expect(checkMemo('a'.repeat(35))).toContain('34');
    expect(checkMemo('é')).toContain('plain');
    expect(stxSweepAmount(BigInt(1_000_000), BigInt(50_000))).toBe(BigInt(950_000));
    expect(stxSweepAmount(BigInt(10_000), BigInt(50_000))).toBe(BigInt(0));
  });
});
