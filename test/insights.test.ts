import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { HistoryFile, insightsOf, pointOf, seriesOf } from '../src/console/history';
import { TickLike, toView } from '../src/console/model';
import { barsFromLadder } from '../src/console/poolDepth';
import { heldTokensOf } from '../src/console/walletTokens';
import { handleConsole } from '../src/console/server';
import { ConsoleHost, ConsoleStore } from '../src/console/store';
import { createWallet } from '../src/console/wallet';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const LOCAL = { host: '127.0.0.1:4173', contentType: 'application/json' };

const tick = (minutesAgo: number, over: Partial<TickLike> = {}): TickLike => ({
  t: new Date(NOW - minutesAgo * 60_000).toISOString(),
  decision: 'hold',
  reason: 'in_range',
  activeBinId: 500,
  activeBinPrice: 100_000,
  portfolioValue: 1000 - minutesAgo / 100,
  ownedBinIds: [498, 499, 500, 501, 502],
  feesPaidStx: 0,
  ...over,
});

const host: ConsoleHost = {
  spawn: () => 4242,
  stop: () => undefined,
  alive: () => true,
  runManual: () => Promise.resolve(''),
  readRemote: () => Promise.resolve({ history: [], log: '' }),
};

const noBridge = {
  prepare: () => Promise.reject(new Error('off')),
  notify: () => Promise.reject(new Error('off')),
};

describe('history file', () => {
  it('reads only what was appended, and keeps a partial last line for the next sync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-hist-'));
    const file = join(dir, 'm.jsonl');
    writeFileSync(file, `${JSON.stringify(tick(3))}\n${JSON.stringify(tick(2))}\n`);
    const history = new HistoryFile(file);
    history.sync();
    expect(history.recent.length).toBe(2);

    const next = JSON.stringify(tick(1, { decision: 'rebalance', executed: true, txIds: ['0xabc'], planType: 'reposition', feesPaidStx: 0.05 }));
    appendFileSync(file, next.slice(0, 20));
    history.sync();
    expect(history.recent.length).toBe(2);
    appendFileSync(file, `${next.slice(20)}\n`);
    history.sync();
    expect(history.recent.length).toBe(3);
    expect(history.lastTrade).toMatchObject({ planType: 'reposition', sent: true, txIds: ['0xabc'] });

    writeFileSync(file, `${JSON.stringify(tick(0))}\n`);
    history.sync();
    expect(history.recent.length).toBe(1);
  });
});

describe('insights', () => {
  it('counts time in range, trades, and gas over the last day', () => {
    const points = [
      tick(60 * 30, { executed: true, feesPaidStx: 1 }),
      tick(30, { activeBinId: 510 }),
      tick(20, { decision: 'rebalance' }),
      tick(10, { executed: true, decision: 'rebalance', feesPaidStx: 0.1 }),
      tick(5, { ownedBinIds: [] }),
    ].map(pointOf);
    const out = insightsOf(points, null, NOW);
    expect(out.inRange24h).toBeCloseTo(2 / 3, 6);
    expect(out.trades24h).toBe(1);
    expect(out.wouldTrades24h).toBe(1);
    expect(out.tradesAll).toBe(2);
    expect(out.gasStx24h).toBeCloseTo(0.1, 6);
    expect(out.gasStxAll).toBeCloseTo(1.1, 6);
  });

  it('thins a long series and always keeps the latest point', () => {
    const points = Array.from({ length: 1000 }, (_, i) => pointOf(tick(1000 - i)));
    const series = seriesOf(points, 'all', NOW);
    expect(series.length).toBeLessThanOrEqual(301);
    expect(series[series.length - 1].t).toBe(new Date(NOW - 60_000).toISOString());
    expect(seriesOf(points, '1d', NOW).every((p) => Date.parse(p.t) >= NOW - 86_400_000)).toBe(true);
  });
});

describe('pool depth', () => {
  it('values bins in the quote token and scales our bar by our share', () => {
    const ladder = [
      { bin_id: 0, reserve_x: '0', reserve_y: '2000000', price: '1000000000' },
      { bin_id: 1, reserve_x: '100000000', reserve_y: '0', price: '1000000000' },
    ];
    const bars = barsFromLadder(ladder, 0, [{ binIdUnsigned: 501, userShares: '25', binShares: '100' }], 8, 6);
    const active = bars.find((bar) => bar.active);
    const next = bars.find((bar) => bar.id === 501);
    expect(active?.id).toBe(500);
    expect(active?.pool).toBeCloseTo(2, 6);
    // 1 base at a raw price of 1e9 (scaled by 1e8 and 10^(8-6)) is 1000 quote.
    expect(next?.pool).toBeCloseTo(1000, 6);
    expect(next?.ours).toBeCloseTo(250, 6);
    expect(next?.price).toBeCloseTo(1000, 6);
    expect(bars.find((bar) => bar.id === 502)?.price).toBeUndefined();
  });
});

describe('overview fields', () => {
  const record = (over: Partial<TickLike>, env: Record<string, string> = {}) => ({
    id: 'sbtc',
    profile: 'sbtc',
    preview: false,
    pair: 'sBTC / USDCx',
    poolId: 'dlmm_1',
    baseSymbol: 'sBTC',
    quoteSymbol: 'USDCx',
    running: true,
    paused: false,
    mode: 'live' as const,
    keySet: true,
    address: 'SP1',
    env: { KEY_SOURCE: 'import', MIN_TX_FEE_USTX: '50000', ...env },
    lastTick: tick(0, over),
    history: [],
    logs: [],
    bins: [],
    binsHavePoolDepth: false,
  });

  it('values a stopped bot from its live wallet, not a check from before it was funded', () => {
    const stale = { walletBase: 0, walletQuote: 0, ownedBase: 0.001, ownedQuote: 50, portfolioValue: 150 };
    const liveWallet = { base: 0.002, quote: 30, stx: 1, asOf: new Date(NOW).toISOString() };
    const stopped = toView({ ...record(stale), running: false, liveWallet }, false, NOW);
    // (0.002 wallet + 0.001 pooled) sBTC at 100,000, plus 30 + 50 USDCx.
    expect(stopped.portfolioValue).toBeCloseTo(380, 6);
    expect(stopped.inventoryShare).toBeCloseTo(300 / 380, 6);
    // A running bot's own check is seconds old and stays the source.
    expect(toView({ ...record(stale), liveWallet }, false, NOW).portfolioValue).toBe(150);
  });

  it('warns before the fee tank runs dry, not after', () => {
    const low = toView(record({ walletStx: 0.5 }), false, NOW);
    expect(low.gasTxLeft).toBe(10);
    expect(low.needs.map((need) => need.id)).toEqual(['sbtc:gas-low']);
    const fine = toView(record({ walletStx: 5 }), false, NOW);
    expect(fine.needs).toEqual([]);
  });

  it('scales the raw bin price by token decimals (sBTC has 8, USDCx 6)', () => {
    const raw = { ...record({ activeBinPrice: 799.58, ownedBase: 0.01, ownedQuote: 500, signals: { refPrice: 80_120, dBps: 20 } }), priceScale: 100 };
    const view = toView(raw, false, NOW);
    expect(view.price).toBeCloseTo(79_958, 0);
    expect(view.market?.poolPrice).toBeCloseTo(79_958, 0);
    expect(view.inPoolValue).toBeCloseTo(500 + 799.58, 0);
  });

  it('flags tokens the pool does not use, and counts failed reads in a row', () => {
    const stray = { ...record({}), strayTokens: [{ contract: 'SM3.sbtc-token', symbol: 'sBTC', amount: 0.001, known: true }] };
    const view = toView(stray, false, NOW);
    expect(view.strayTokens.length).toBe(1);
    expect(view.needs.map((need) => need.id)).toEqual(['sbtc:stray']);

    const failing = {
      ...record({ decision: 'frozen', reason: 'snapshot_fetch_failed: 503' }),
      env: { KEY_SOURCE: 'import', MAX_CONSECUTIVE_API_ERRORS: '5' },
      history: [tick(8), tick(6, { decision: 'frozen', reason: 'snapshot_fetch_failed: 503' }), tick(4, { decision: 'frozen', reason: 'snapshot_fetch_failed: 503' })],
    };
    expect(toView(failing, false, NOW).readFailures).toEqual({ count: 2, max: 5 });
    expect(toView(record({}), false, NOW).readFailures).toBeNull();
  });

  it('keeps balances from the last real read when later checks were paused after a restart', () => {
    const paused = { t: new Date(NOW).toISOString(), decision: 'frozen', reason: 'kill_switch', walletBase: 0, walletQuote: 0, portfolioValue: null, holdingsAsOf: null, activeBinId: -1, activeBinPrice: 0 };
    const good = tick(10, { walletBase: 9, walletQuote: 0.3, portfolioValue: 3.05, holdingsAsOf: new Date(NOW - 600_000).toISOString(), activeBinPrice: 0.305 });
    const view = toView({ ...record({}), lastTick: paused, history: [good, paused] }, false, NOW);
    expect(view.walletBase).toBe(9);
    expect(view.portfolioValue).toBe(3.05);
    expect(view.holdingsCarried).toBe(true);
    expect(view.decision).toBe('frozen');
    expect(view.lastCheckAt).toBe(paused.t);
  });

  it('trusts the chain over a stale bot reading for "wallet funded"', () => {
    const empty = { ...record({ walletBase: 0, walletQuote: 0, ownedBase: 0, ownedQuote: 0 }), liveWallet: { base: 8.95, quote: 0.3, stx: 8.95, asOf: new Date(NOW).toISOString() } };
    expect(toView(empty, false, NOW).checklist.find((item) => item.id === 'funded')?.ok).toBe(true);
  });

  it('labels wallet tokens from Bitflow’s list and drops empty ones', () => {
    const held = heldTokensOf(
      {
        'SM3.sbtc-token::sbtc-token': { balance: '100000' },
        'SP1.mystery::mystery': { balance: '42' },
        'SP120.usdcx::usdcx-token': { balance: '0' },
      },
      [{ contract_address: 'SM3.sbtc-token', symbol: 'sBTC', decimals: 8 }],
    );
    expect(held).toEqual([
      { contract: 'SM3.sbtc-token', symbol: 'sBTC', amount: 0.001, known: true },
      { contract: 'SP1.mystery', symbol: 'mystery', amount: 42, known: false },
    ]);
  });

  it('reads the market gap and inventory bands from the strategy', () => {
    const view = toView(record({ signals: { refPrice: 99_900, dBps: 10, refAgeMs: 20_000, f: 0.55, width: 6, size: 0.45, repoDrift: 6 } }, { DIVERGENCE_HALT_BPS: '150' }), false, NOW);
    expect(view.market).toMatchObject({ poolPrice: 100_000, refPrice: 99_900, gapBps: 10, haltBps: 150 });
    expect(view.inventory).toMatchObject({ share: 0.55, target: 0.38, soft: 0.52, hard: 0.67 });
    expect(view.curve).toEqual({ width: 6, sizeFraction: 0.45, repoDrift: 6 });
  });
});

describe('history and export routes', () => {
  it('serves chart points and the whole decision history as CSV', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-routes-'));
    const store = new ConsoleStore(root, host, noBridge, NOW);
    const wallet = createWallet();
    await handleConsole(store, { method: 'POST', path: '/api/bots', headers: LOCAL, body: JSON.stringify({ profile: 'sbtc', wallet: 'import', signerKey: wallet.key }) }, NOW);
    mkdirSync(join(root, 'data'), { recursive: true });
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify(tick(300 - i, { reason: 'in range, "quoted"' })));
    writeFileSync(join(root, 'data', 'metrics.sbtc.jsonl'), `${lines.join('\n')}\n`);

    const chart = await handleConsole(store, { method: 'GET', path: '/api/bots/sbtc/history', query: { range: '7d' }, headers: LOCAL, body: '' }, NOW);
    expect((chart.body as { range: string; points: unknown[] }).range).toBe('7d');
    expect((chart.body as { points: unknown[] }).points.length).toBe(300);

    const csv = await handleConsole(store, { method: 'GET', path: '/api/bots/sbtc/decisions.csv', headers: LOCAL, body: '' }, NOW);
    const text = (csv as { file: { text: string } }).file.text.trim().split('\n');
    expect(text.length).toBe(301);
    expect(text[1]).toContain('"in range, ""quoted"""');

    const fleet = await handleConsole(store, { method: 'GET', path: '/api/fleet', headers: LOCAL, body: '' }, NOW);
    const bot = (fleet.body as { bots: Array<{ id: string; insights: { since: string } | null }>; canCreate: boolean });
    expect(bot.canCreate).toBe(true);
    expect(bot.bots.find((item) => item.id === 'sbtc')?.insights?.since).toBe(new Date(NOW - 300 * 60_000).toISOString());
  });
});
