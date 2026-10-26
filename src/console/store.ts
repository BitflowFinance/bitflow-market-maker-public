import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { checkMemo, checkPayoutAddress } from '../payout';
import {
  insideRoot,
  readEnv,
  readEnvFile,
  removeFile,
  tightenSecretFile,
  touchFile,
  upsertEnv,
  writeEnvUpdates,
  writeSecretFile,
} from './envFile';
import {
  BinBar,
  BookView,
  BotRecord,
  API_KEY_NAMES,
  BotView,
  CashOutJob,
  PoolSwitchJob,
  LogLine,
  SETTING_KEYS,
  TickLike,
  bookOf,
  humanReason,
  liveBlockedBy,
  valuedTick,
  parseLogLine,
  toView,
  validateSettings,
} from './model';
import { decimalToMicro } from './money';
import { HistoryFile, Range, insightsOf, lastTradeOf, pointOf, seriesOf } from './history';
import { PoolDepthReader, noPoolDepth } from './poolDepth';
import { PoolCatalog, PoolCatalogReader, noPoolCatalog } from './pools';
import { WalletTokenReader, noWalletTokens } from './walletTokens';
import { PreviewBook } from './preview';
import { PROFILE_IDS, PROFILES, profileById } from './profiles';

type Profile = NonNullable<ReturnType<typeof profileById>>;
import { createWallet, walletFromPrivateKey } from './wallet';

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RemoteRead {
  history: TickLike[];
  log: string;
}

export interface ConsoleHost {
  spawn(profile: string): number;
  stop(pid: number): void;
  alive(pid: number): boolean;
  /**
   * Whether a live pid is this profile's bot. A pid file left by a crash or reboot
   * can name an unrelated process that reused the number; without this check the
   * page would show the bot as running and Stop would signal that process.
   */
  isBot?(pid: number, profile: string): boolean;
  runManual(profile: string, args: string[], opts?: { timeoutMs?: number; onOutput?: (text: string) => void }): Promise<string>;
  readRemote(profile: string, port: number): Promise<RemoteRead>;
}

export interface BridgeInput {
  botId: string;
  direction: string;
  amount: string;
  stacksAddress: string;
  reclaimPublicKey: string;
  bitcoinAddress: string;
}

export interface BridgeJob {
  id: string;
  botId: string;
  pair: string;
  direction: string;
  amount: string;
  status: string;
  message: string;
  depositAddress: string | null;
  stacksAddress: string;
}

export interface BridgeClient {
  prepare(input: BridgeInput): Promise<BridgeJob>;
  notify(job: BridgeJob, txid: string): Promise<BridgeJob>;
}

// Each step waits for its transaction to confirm and may replace-by-fee, so the
// whole run (withdraw + up to three transfers) needs far more than a manual trade.
const CASH_OUT_TIMEOUT_MS = 30 * 60_000;

export interface CreateInput {
  profile: string;
  wallet: 'create' | 'import';
  /** A pool of this pair from the pool list; the profile's default when omitted. */
  poolId?: string;
  signerKey?: string;
  signerAddress?: string;
}

const SECRET_KEYS = ['SIGNER_KEY', ...API_KEY_NAMES];

const templateFor = (root: string, profile: Profile): string => {
  const example = join(root, `.env.${profile.id}.example`);
  if (existsSync(example)) return readFileSync(example, 'utf8');
  return [
    'EXECUTION_MODE=dry_run',
    'TICK_INTERVAL_MS=120000',
    `POOL_ID=${profile.poolId}`,
    `POOL_STRATEGY=${profile.strategy}`,
    'SIGNER_ADDRESS=',
    'SIGNER_KEY=',
    `CURVE_HALF_WIDTH_BINS=${profile.halfWidth}`,
    `CURVE_SIZE_FRACTION=${profile.sizeFraction}`,
    'ENABLE_SWAP=true',
    'F_STAR=0.38',
    'F_SOFT=0.52',
    'F_HARD=0.67',
    'DIVERGENCE_HALT_BPS=150',
    'STX_GAS_RESERVE_USTX=5000000',
    'MAX_POSITION_USTX=0',
    'MAX_CONSECUTIVE_API_ERRORS=5',
    'BREAKER_WITHDRAW_ALL=false',
    `METRICS_HTTP_PORT=${profile.metricsPort}`,
    'LOG_PRETTY=true',
    '',
  ].join('\n');
};


const barsFromTick = (tick: TickLike | null): BinBar[] => {
  if (!tick || tick.activeBinId == null || tick.activeBinId < 0) return [];
  const owned = new Set(tick.ownedBinIds || []);
  const active = tick.activeBinId;
  const bars: BinBar[] = [];
  const start = Math.min(active - 8, ...(owned.size ? Array.from(owned) : [active]));
  const end = Math.max(active + 8, ...(owned.size ? Array.from(owned) : [active]));
  for (let id = start; id <= end; id += 1) {
    bars.push({ id, pool: 0, ours: owned.has(id) ? 1 : 0, active: id === active });
  }
  return bars;
};

const tailLog = (file: string): LogLine[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-120)
    .map(parseLogLine)
    .filter((line) => line.text.length > 0)
    .reverse();
};

const readPid = (file: string): number | null => {
  if (!existsSync(file)) return null;
  const value = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(value) && value > 0 ? value : null;
};

export class ConsoleStore {
  root: string;
  host: ConsoleHost;
  bridge: BridgeClient;
  preview: PreviewBook;
  jobs = new Map<string, BridgeJob>();
  private jobSeq = 1;

  depth: PoolDepthReader;
  pools: PoolCatalogReader;
  walletTokens: WalletTokenReader;
  /** Pause between checks while confirming a pool change; tests swap in an instant one. */
  wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  private histories = new Map<string, HistoryFile>();
  private poolSwitches = new Map<string, PoolSwitchJob>();

  constructor(
    root: string,
    host: ConsoleHost,
    bridge: BridgeClient,
    nowMs: number,
    depth: PoolDepthReader = noPoolDepth,
    pools: PoolCatalogReader = noPoolCatalog,
    walletTokens: WalletTokenReader = noWalletTokens,
  ) {
    this.walletTokens = walletTokens;
    this.root = root;
    this.host = host;
    this.bridge = bridge;
    this.depth = depth;
    this.pools = pools;
    this.preview = new PreviewBook(
      PROFILE_IDS.map((id) => PROFILES[id]),
      nowMs,
    );
    for (const id of PROFILE_IDS) {
      const file = this.envPath(id);
      tightenSecretFile(file);
      // The BFF v2 API dropped the short pool aliases; upgrade files written before that.
      const poolId = readEnvFile(file).POOL_ID;
      const upgraded = poolId ? PROFILES[id].legacyPoolIds[poolId] : undefined;
      if (upgraded) writeEnvUpdates(file, { POOL_ID: upgraded });
    }
  }

  private cashOuts = new Map<string, CashOutJob>();

  private startErrors = new Map<string, string>();

  async fleet(nowMs: number): Promise<{ book: BookView; bots: BotView[]; needs: BotView['needs']; canCreate: boolean }> {
    this.preview.advance(nowMs, 4000);
    const bots = await this.views(nowMs);
    const needs = bots.flatMap((bot) => bot.needs);
    return { book: bookOf(bots), bots, needs, canCreate: PROFILE_IDS.some((id) => !existsSync(this.envPath(id))) };
  }

  /** Value points for the overview chart over a range, thinned to a drawable count. */
  history(id: string, range: Range, nowMs: number): { range: Range; points: Array<{ t: string; value: number }> } {
    if (id.startsWith('preview-')) {
      const record = this.preview.record(id);
      return { range, points: seriesOf(record.history.map(pointOf), range, nowMs) };
    }
    const profile = this.requireProfile(id);
    const file = this.historyFile(profile.id, readEnvFile(this.envPath(profile.id)));
    file.sync();
    return { range, points: seriesOf(file.points, range, nowMs) };
  }

  /** Every recorded check as CSV, read straight from the bot's metrics file. */
  decisionsCsv(id: string): { filename: string; text: string } {
    if (id.startsWith('preview-')) throw new HttpError(400, 'preview', 'Preview history lives in the page. Use its export.');
    const profile = this.requireProfile(id);
    const env = readEnvFile(this.envPath(profile.id));
    const file = insideRoot(this.root, env.METRICS_LOG_FILE || `data/metrics.${profile.id}.jsonl`);
    const ticks: TickLike[] = [];
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          ticks.push(JSON.parse(line) as TickLike);
        } catch {
          // A torn line is skipped.
        }
      }
    }
    return { filename: `${profile.id}-decisions-all.csv`, text: decisionsCsvOf(ticks) };
  }

  async one(id: string, nowMs: number): Promise<BotView> {
    const { bots } = await this.fleet(nowMs);
    const bot = bots.find((item) => item.id === id);
    if (!bot) throw new HttpError(404, 'not_found', 'No bot with that id.');
    return bot;
  }

  profiles(): {
    id: string;
    pair: string;
    poolId: string;
    baseSymbol: string;
    quoteSymbol: string;
    halfWidth: number;
    taken: boolean;
    suggest: Profile['suggest'];
  }[] {
    return PROFILE_IDS.map((id) => {
      const profile = PROFILES[id];
      return {
        id,
        pair: profile.pair,
        poolId: profile.poolId,
        baseSymbol: profile.baseSymbol,
        quoteSymbol: profile.quoteSymbol,
        halfWidth: profile.halfWidth,
        taken: existsSync(this.envPath(id)),
        suggest: profile.suggest,
      };
    });
  }

  async pause(id: string, nowMs: number): Promise<BotView> {
    if (id.startsWith('preview-')) {
      this.preview.pause(id, nowMs);
      return this.one(id, nowMs);
    }
    const profile = this.requireProfile(id);
    const envPath = this.envPath(profile.id);
    const env = readEnvFile(envPath);
    const killRel = env.KILL_SWITCH_FILE || `data/kill.${profile.id}`;
    if (env.KILL_SWITCH_FILE !== killRel) writeEnvUpdates(envPath, { KILL_SWITCH_FILE: killRel });
    touchFile(insideRoot(this.root, killRel));
    const wasRunning = this.runningPid(profile.id) != null;
    if (wasRunning && !env.KILL_SWITCH_FILE) await this.restart(profile.id);
    return this.one(id, nowMs);
  }

  async resume(id: string, nowMs: number): Promise<BotView> {
    if (id.startsWith('preview-')) {
      this.preview.resume(id, nowMs);
      return this.one(id, nowMs);
    }
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    const envPath = this.envPath(profile.id);
    const env = readEnvFile(envPath);
    if (env.KILL_SWITCH_FILE) {
      const file = insideRoot(this.root, env.KILL_SWITCH_FILE);
      removeFile(file);
    }
    if (env.KILL_SWITCH === 'true') {
      writeEnvUpdates(envPath, { KILL_SWITCH: 'false' });
      await this.restart(profile.id);
    }
    return this.one(id, nowMs);
  }

  async start(id: string): Promise<BotView> {
    if (id.startsWith('preview-')) {
      this.preview.start(id, Date.now());
      return this.one(id, Date.now());
    }
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    if (this.runningPid(profile.id) != null) return this.one(id, Date.now());
    const failed = this.launch(profile.id);
    if (failed) throw new HttpError(500, 'start_failed', failed);
    return this.one(id, Date.now());
  }

  async stop(id: string): Promise<BotView> {
    if (id.startsWith('preview-')) {
      this.preview.stop(id);
      return this.one(id, Date.now());
    }
    const profile = this.requireProfile(id);
    const pid = this.runningPid(profile.id);
    if (pid == null) return this.one(id, Date.now());
    this.host.stop(pid);
    const started = Date.now();
    while (this.host.alive(pid) && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pidFile = this.pidPath(profile.id);
    if (readPid(pidFile) === pid) removeFile(pidFile);
    return this.one(id, Date.now());
  }

  async create(input: CreateInput): Promise<{ bot: BotView; funding: Profile['suggest'] }> {
    const profile = profileById(input.profile);
    if (!profile) throw new HttpError(400, 'unknown_pool', 'Pick the sBTC pool or the STX pool.');
    const envPath = this.envPath(profile.id);
    if (existsSync(envPath)) {
      throw new HttpError(409, 'exists', 'That pool already has a bot. Each pool needs its own wallet.');
    }
    let material: { address: string; key: string };
    try {
      material =
        input.wallet === 'import'
          ? walletFromPrivateKey(input.signerKey || '')
          : input.wallet === 'create'
            ? createWallet()
            : { address: '', key: '' };
    } catch (err) {
      throw new HttpError(400, 'wallet', (err as Error).message);
    }
    if (!material.key) throw new HttpError(400, 'wallet', 'Create a new wallet or import one.');
    if (input.wallet === 'import' && input.signerAddress && input.signerAddress !== material.address) {
      throw new HttpError(400, 'address_mismatch', 'That key does not match the address you entered.');
    }
    const poolId = input.poolId && input.poolId !== profile.poolId ? await this.requirePairPool(profile, input.poolId) : profile.poolId;
    const text = upsertEnv(templateFor(this.root, profile), {
      POOL_ID: poolId,
      EXECUTION_MODE: 'dry_run',
      SIGNER_ADDRESS: material.address,
      SIGNER_KEY: material.key,
      KEY_SOURCE: input.wallet,
      KILL_SWITCH: 'false',
      KILL_SWITCH_FILE: `data/kill.${profile.id}`,
      PID_FILE: `data/bot.${profile.id}.pid`,
      METRICS_HTTP_PORT: String(profile.metricsPort),
      LOG_PRETTY: 'true',
    });
    writeSecretFile(envPath, text);
    this.launch(profile.id);
    // A failed start leaves the bot created and stopped; the error shows on its page.
    const bot = await this.one(profile.id, Date.now());
    return { bot, funding: profile.suggest };
  }

  async updateSettings(
    id: string,
    updates: Record<string, string>,
    confirm: { confirmLive?: boolean; poolName?: string },
  ): Promise<BotView> {
    if (id.startsWith('preview-')) {
      throw new HttpError(400, 'preview', 'Preview bots have no settings file.');
    }
    for (const key of Object.keys(updates)) {
      if (SECRET_KEYS.indexOf(key) >= 0) {
        throw new HttpError(400, 'secret', 'The private key is not edited here. It stays in the env file.');
      }
      if (SETTING_KEYS.indexOf(key) < 0) throw new HttpError(400, 'unknown_setting', `Unknown setting ${key}.`);
    }
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    const envPath = this.envPath(profile.id);
    const current = readEnvFile(envPath);
    const problem = validateSettings(updates, current);
    if (problem) throw new HttpError(400, 'invalid_setting', problem);
    const nextMode = updates.EXECUTION_MODE || current.EXECUTION_MODE || 'dry_run';
    if (nextMode !== 'dry_run' && nextMode !== 'live') {
      throw new HttpError(400, 'mode', 'Mode is dry run or live.');
    }
    const leavingDry = (current.EXECUTION_MODE || 'dry_run') !== 'live' && nextMode === 'live';
    if (leavingDry) {
      const bot = await this.one(id, Date.now());
      const blocked = liveBlockedBy(bot.checklist);
      if (blocked.length) {
        throw new HttpError(409, 'not_ready', blocked.map((item) => item.label).join(', ') + '.');
      }
      if (!confirm.confirmLive || confirm.poolName !== profile.pair) {
        throw new HttpError(
          409,
          'confirm_live',
          `Leaving dry run restarts the bot and real money can move. Tick the box and type ${profile.pair}.`,
        );
      }
    }
    writeEnvUpdates(envPath, updates);
    const failed = await this.restart(profile.id);
    if (failed) throw new HttpError(500, 'start_failed', `Settings were saved, but the bot did not restart: ${failed}`);
    return this.one(id, Date.now());
  }

  async resetBaseline(id: string): Promise<{ ok: true; file: string }> {
    if (id.startsWith('preview-')) throw new HttpError(400, 'preview', 'Preview profit is fake and is not reset.');
    const profile = this.requireProfile(id);
    const env = readEnvFile(this.envPath(profile.id));
    const baseline = env.METRICS_BASELINE_FILE || `data/metrics-baseline.${profile.id}.json`;
    const file = insideRoot(this.root, `${baseline}.reset`);
    touchFile(file);
    return { ok: true, file: `${baseline}.reset` };
  }

  async manual(id: string, body: ManualBody): Promise<{ ok: true; output: string }> {
    if (id.startsWith('preview-')) {
      throw new HttpError(409, 'preview', 'This is a preview bot. It has no wallet and cannot move funds.');
    }
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    const env = readEnvFile(this.envPath(profile.id));
    if ((env.EXECUTION_MODE || 'dry_run') !== 'live') {
      throw new HttpError(409, 'dry_run', 'Dry run refuses manual trades. The bot is only practicing.');
    }
    if (!body.acknowledged || body.poolName !== profile.pair) {
      throw new HttpError(
        409,
        'confirm',
        `This moves real funds. Tick the box and type ${profile.pair}.`,
      );
    }
    // A running loop and a manual transaction would race for the same nonce, and
    // the loop's next check would undo the trade anyway; pausing settles both. A
    // stopped bot has no loop to race.
    if (!this.isPaused(env) && this.runningPid(profile.id) != null) {
      throw new HttpError(
        409,
        'pause_first',
        'Pause the bot first. Otherwise its next check would undo this, and the two could send clashing transactions.',
      );
    }
    const args = manualArgs(profile, body);
    // A real add or withdraw waits for its transaction to confirm and may bump the fee.
    const output = await this.host.runManual(profile.id, args, { timeoutMs: MANUAL_TIMEOUT_MS });
    const outcome = manualOutcome(output);
    if (!outcome.ok) throw new HttpError(502, 'manual_failed', outcome.message);
    return { ok: true, output: outcome.message };
  }

  /** Sets or clears an optional provider key. The server gates this route to the page; the value is never returned. */
  async setApiKey(id: string, name: string, value: string): Promise<BotView> {
    if (id.startsWith('preview-')) throw new HttpError(400, 'preview', 'Preview bots have no settings file.');
    if (API_KEY_NAMES.indexOf(name) < 0) throw new HttpError(400, 'unknown_key', 'That is not a key the bot uses.');
    const trimmed = value.trim();
    // Keys go into an env file line and an HTTP header, so no spaces, quotes or newlines.
    if (trimmed && !/^[A-Za-z0-9._~+/=-]{8,256}$/.test(trimmed)) {
      throw new HttpError(400, 'bad_key', 'That does not look like an API key. Paste it without spaces or quotes.');
    }
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    writeEnvUpdates(this.envPath(profile.id), { [name]: trimmed });
    const failed = await this.restart(profile.id);
    if (failed) throw new HttpError(500, 'start_failed', `Saved, but the bot did not restart: ${failed}`);
    return this.one(id, Date.now());
  }

  /** The raw key, for the page's backup step only. The server gates this route to the page. */
  keyBackup(id: string, acknowledged: boolean): { address: string; key: string; pair: string; file: string } {
    if (id.startsWith('preview-')) throw new HttpError(400, 'preview', 'Preview bots have no wallet.');
    const profile = this.requireProfile(id);
    if (!acknowledged) {
      throw new HttpError(409, 'confirm', 'Anyone with this key controls the wallet. Confirm before showing it.');
    }
    const env = readEnvFile(this.envPath(profile.id));
    if (!env.SIGNER_KEY || !env.SIGNER_ADDRESS) throw new HttpError(409, 'no_wallet', 'This bot has no wallet key.');
    return { address: env.SIGNER_ADDRESS, key: env.SIGNER_KEY, pair: profile.pair, file: `.env.${profile.id}` };
  }

  /** Records the backup once the user proves they have the key by typing its last characters. */
  async keySaved(id: string, keyTail: string): Promise<BotView> {
    if (id.startsWith('preview-')) throw new HttpError(400, 'preview', 'Preview bots have no wallet.');
    const profile = this.requireProfile(id);
    const envPath = this.envPath(profile.id);
    const env = readEnvFile(envPath);
    const tail = keyTail.trim().toLowerCase();
    if (!env.SIGNER_KEY || tail.length < KEY_TAIL_CHARS || !env.SIGNER_KEY.toLowerCase().endsWith(tail)) {
      throw new HttpError(400, 'key_tail', `That does not match. Type the last ${KEY_TAIL_CHARS} characters of the key you saved.`);
    }
    writeEnvUpdates(envPath, { KEY_BACKUP_AT: new Date().toISOString() });
    return this.one(id, Date.now());
  }

  /** Saves where cash-out sends funds. The server gates this route to the page, so an agent cannot redirect funds. */
  async setPayout(id: string, body: { address: string; memo: string; addressTail: string }): Promise<BotView> {
    if (id.startsWith('preview-')) throw new HttpError(400, 'preview', 'Preview bots have no wallet.');
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    const envPath = this.envPath(profile.id);
    const env = readEnvFile(envPath);
    const address = body.address.trim();
    const memo = body.memo.trim();
    const problem = checkPayoutAddress(address, env.SIGNER_ADDRESS || '') || checkMemo(memo);
    if (problem) throw new HttpError(400, 'payout', problem);
    if (body.addressTail.trim().toUpperCase() !== address.slice(-PAYOUT_TAIL_CHARS).toUpperCase()) {
      throw new HttpError(400, 'payout_tail', `Type the last ${PAYOUT_TAIL_CHARS} characters of the address to confirm it.`);
    }
    writeEnvUpdates(envPath, { PAYOUT_ADDRESS: address, PAYOUT_MEMO: memo });
    return this.one(id, Date.now());
  }

  /**
   * Pauses and stops the bot, then runs the cash-out in the background. Works in
   * dry run: the funds are real even when the bot is only practicing.
   */
  async cashOut(id: string, confirm: { acknowledged: boolean; poolName: string }): Promise<CashOutJob> {
    if (id.startsWith('preview-')) {
      throw new HttpError(409, 'preview', 'This is a preview bot. It has no wallet and cannot move funds.');
    }
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    const envPath = this.envPath(profile.id);
    const env = readEnvFile(envPath);
    if (!env.PAYOUT_ADDRESS) throw new HttpError(409, 'no_payout', 'Save a payout address on the Wallet tab first.');
    const problem = checkPayoutAddress(env.PAYOUT_ADDRESS, env.SIGNER_ADDRESS || '') || checkMemo(env.PAYOUT_MEMO || '');
    if (problem) throw new HttpError(409, 'payout', `The saved payout address is not usable: ${problem}`);
    if (!confirm.acknowledged || confirm.poolName !== profile.pair) {
      throw new HttpError(409, 'confirm', `This sends every token in the bot wallet to ${env.PAYOUT_ADDRESS}. Tick the box and type ${profile.pair}.`);
    }

    // Pause before stopping so a restart from anywhere cannot redeploy the funds
    // mid-way, and stop so the loop cannot race the cash-out for nonces.
    const killRel = env.KILL_SWITCH_FILE || `data/kill.${profile.id}`;
    if (env.KILL_SWITCH_FILE !== killRel) writeEnvUpdates(envPath, { KILL_SWITCH_FILE: killRel });
    touchFile(insideRoot(this.root, killRel));
    await this.stop(profile.id);

    const job: CashOutJob = {
      status: 'running',
      to: env.PAYOUT_ADDRESS,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lines: [],
    };
    this.cashOuts.set(profile.id, job);
    let raw = '';
    const args = ['--cash-out', '--to', env.PAYOUT_ADDRESS];
    if (env.PAYOUT_MEMO) args.push('--memo', env.PAYOUT_MEMO);
    void this.host
      .runManual(profile.id, args, {
        timeoutMs: CASH_OUT_TIMEOUT_MS,
        onOutput: (text) => {
          raw += text;
          job.lines = cashOutLines(raw);
        },
      })
      .then((output) => {
        if (!raw) raw = output;
        job.lines = cashOutLines(raw);
        job.status = /\[cashout\] done\b/.test(raw) ? 'done' : 'failed';
      })
      .catch((err: Error) => {
        job.lines = [...cashOutLines(raw), { t: '', level: 'error', text: `Cash out did not run: ${err.message}` }];
        job.status = 'failed';
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return job;
  }

  /** Every pool of a pair, scored against the market and the curve, best first. */
  async poolCatalog(profileId: string): Promise<PoolCatalog> {
    const profile = profileById(profileId);
    if (!profile) throw new HttpError(404, 'unknown_pool', 'Pick the sBTC pool or the STX pool.');
    const env = readEnvFile(this.envPath(profile.id));
    return this.pools.catalog(profile, Number(env.DIVERGENCE_HALT_BPS || '150'));
  }

  /**
   * Moves a bot to another pool of its pair: pause, stop, withdraw everything from
   * the old pool (live only), confirm the old position is empty, then point the
   * bot at the new pool and restart it paused. Nothing changes unless the old
   * pool is confirmed empty, so liquidity is never left where the bot can't see it.
   */
  async switchPool(id: string, body: { poolId: string; acknowledged: boolean; poolName: string }): Promise<PoolSwitchJob> {
    if (id.startsWith('preview-')) throw new HttpError(409, 'preview', 'Preview bots have no pool to change.');
    const profile = this.requireProfile(id);
    this.refuseDuringJob(profile.id);
    const envPath = this.envPath(profile.id);
    const env = readEnvFile(envPath);
    const from = env.POOL_ID || profile.poolId;
    if (body.poolId === from) throw new HttpError(400, 'same_pool', 'The bot is already in that pool.');
    const to = await this.requirePairPool(profile, body.poolId);
    if (!body.acknowledged || body.poolName !== profile.pair) {
      throw new HttpError(409, 'confirm', `Changing pools withdraws everything from the current pool. Tick the box and type ${profile.pair}.`);
    }

    const job: PoolSwitchJob = { status: 'running', from, to, startedAt: new Date().toISOString(), finishedAt: null, lines: [] };
    this.poolSwitches.set(profile.id, job);
    const say = (text: string, level = 'info'): void => {
      job.lines.push({ t: new Date().toTimeString().slice(0, 8), level, text });
    };
    const finish = (status: PoolSwitchJob['status']): void => {
      job.status = status;
      job.finishedAt = new Date().toISOString();
    };

    void (async () => {
      const killRel = env.KILL_SWITCH_FILE || `data/kill.${profile.id}`;
      if (env.KILL_SWITCH_FILE !== killRel) writeEnvUpdates(envPath, { KILL_SWITCH_FILE: killRel });
      touchFile(insideRoot(this.root, killRel));
      const wasRunning = this.runningPid(profile.id) != null;
      await this.stop(profile.id);
      say('Paused and stopped the bot.');

      if (env.EXECUTION_MODE === 'live') {
        say('Withdrawing everything from the current pool…');
        const output = await this.host
          .runManual(profile.id, ['--withdraw-liquidity', '--pct', '100'], { timeoutMs: 10 * 60_000 })
          .catch((err: Error) => `withdraw did not run: ${err.message}`);
        for (const line of output.split('\n').map(parseLogLine)) {
          if (/withdraw_liquidity tx=|no withdrawable positions|did not run|failed/.test(line.text)) say(line.text, line.level);
        }
      } else {
        say('Dry run: nothing to withdraw. Checking the current pool is empty…');
      }

      // The engine indexes the withdraw a few blocks after it confirms.
      let empty: boolean | null = null;
      for (let attempt = 0; attempt < 12 && empty !== true; attempt += 1) {
        if (attempt) await this.wait(5000);
        empty = env.SIGNER_ADDRESS ? await this.pools.positionEmpty(from, env.SIGNER_ADDRESS) : true;
        if (empty === false && env.EXECUTION_MODE !== 'live') break;
      }
      if (empty !== true) {
        say(
          empty === false
            ? 'The current pool still holds this wallet’s liquidity, so nothing was changed. Withdraw it (this needs live mode), then try again.'
            : 'Could not confirm the current pool is empty, so nothing was changed. Try again in a minute.',
          'error',
        );
        finish('failed');
        return;
      }
      say('The current pool is empty.');

      writeEnvUpdates(envPath, { POOL_ID: to });
      say(`Now using ${to.split('.').pop()}.`);
      if (wasRunning) {
        const failed = this.launch(profile.id);
        say(failed || 'Restarted, still paused. Resume when you are ready; the bot then deploys in the new pool.', failed ? 'error' : 'info');
        finish(failed ? 'failed' : 'done');
        return;
      }
      say('The bot is stopped and paused. Start and resume it to deploy in the new pool.');
      finish('done');
    })().catch((err: Error) => {
      say(`The pool change stopped: ${err.message}`, 'error');
      finish('failed');
    });
    return job;
  }

  private async requirePairPool(profile: Profile, poolId: string): Promise<string> {
    const catalog = await this.poolCatalog(profile.id).catch(() => null);
    const match = catalog?.pools.find((pool) => pool.poolId === poolId);
    if (!match) {
      throw new HttpError(400, 'unknown_pool', catalog?.pools.length ? `That is not a ${profile.pair} pool.` : 'Could not load the pool list to check that pool. Try again.');
    }
    return match.poolId;
  }

  async startBridge(body: BridgeBody): Promise<BridgeJob> {
    if (body.botId.startsWith('preview-')) {
      throw new HttpError(409, 'preview', 'Preview bots have no wallet. Bridge into a real bot.');
    }
    const profile = this.requireProfile(body.botId);
    const env = readEnvFile(this.envPath(profile.id));
    if (!env.SIGNER_ADDRESS) throw new HttpError(409, 'no_wallet', 'This bot has no wallet address yet.');
    if (!body.acknowledged || body.poolName !== profile.pair) {
      throw new HttpError(409, 'confirm', `Tick the box and type ${profile.pair} before moving funds.`);
    }
    const job = await this.bridge.prepare({
      botId: profile.id,
      direction: body.direction,
      amount: body.amount,
      stacksAddress: env.SIGNER_ADDRESS,
      reclaimPublicKey: body.reclaimPublicKey || '',
      bitcoinAddress: body.bitcoinAddress || '',
    });
    job.id = `bridge-${this.jobSeq}`;
    this.jobSeq += 1;
    job.pair = profile.pair;
    job.botId = profile.id;
    this.jobs.set(job.id, job);
    return job;
  }

  async notifyBridge(id: string, txid: string): Promise<BridgeJob> {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'not_found', 'No bridge transfer with that id.');
    if (!/^[0-9a-fA-F]{64}$/.test(txid.trim())) throw new HttpError(400, 'txid', 'Enter the 64-character transaction id.');
    const next = await this.bridge.notify(job, txid.trim());
    this.jobs.set(id, next);
    return next;
  }

  bridgeJob(id: string): BridgeJob {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'not_found', 'No bridge transfer with that id.');
    return job;
  }

  private async views(nowMs: number): Promise<BotView[]> {
    const records = [...(await this.realRecords()), this.preview.record('preview-sbtc'), this.preview.record('preview-stx')];
    const byAddress = new Map<string, string[]>();
    for (const record of records) {
      if (!record.address) continue;
      const list = byAddress.get(record.address) || [];
      list.push(record.id);
      byAddress.set(record.address, list);
    }
    for (const record of records) {
      if (!record.preview) continue;
      const last = [...record.history].reverse().find((tick) => lastTradeOf(tick) != null);
      record.insights = insightsOf(record.history.map(pointOf), last ? lastTradeOf(last) : null, nowMs);
    }
    return records.map((record) =>
      toView(record, Boolean(record.address && (byAddress.get(record.address) || []).length > 1), nowMs),
    );
  }

  private async realRecords(): Promise<BotRecord[]> {
    const out: BotRecord[] = [];
    for (const id of PROFILE_IDS) {
      const file = this.envPath(id);
      if (!existsSync(file)) continue;
      out.push(await this.realRecord(PROFILES[id], readEnv(readFileSync(file, 'utf8'))));
    }
    return out;
  }

  private async realRecord(profile: Profile, env: Record<string, string>): Promise<BotRecord> {
    const pid = this.runningPid(profile.id);
    const running = pid != null;
    const port = Number(env.METRICS_HTTP_PORT || profile.metricsPort);
    const file = this.historyFile(profile.id, env);
    file.sync();
    // The bot's HTTP history only matters before its first JSONL line lands.
    const history = file.recent.length ? file.recent : running ? (await this.host.readRemote(profile.id, port)).history : [];
    const lastTick = history.length ? history[history.length - 1] : null;
    const address = env.SIGNER_ADDRESS || null;
    const chain = address ? this.walletTokens.peek(address) : null;
    const poolId = env.POOL_ID || profile.poolId;
    const depth =
      env.BFF_API_VERSION === 'v1'
        ? null
        : this.depth.peek({
            poolId,
            address,
            baseDecimals: profile.baseDecimals,
            quoteDecimals: profile.quoteDecimals,
            apiBase: env.BFF_API_BASE_URL,
          });
    let bins = depth ? depth.bars : barsFromTick(valuedTick(history) || lastTick);
    if (depth && !depth.oursExact) {
      // Shares unreadable: mark the bins the bot last reported as ours, at full height.
      const owned = new Set(lastTick?.ownedBinIds || []);
      bins = bins.map((bar) => ({ ...bar, ours: owned.has(bar.id) ? bar.pool : 0 }));
    }
    const logs = tailLog(join(this.root, 'data', `bot.${profile.id}.log`));
    return {
      id: profile.id,
      profile: profile.id,
      preview: false,
      pair: profile.pair,
      poolId,
      baseSymbol: profile.baseSymbol,
      quoteSymbol: profile.quoteSymbol,
      running,
      // The kill switch itself, not the last check: after Resume that check still says paused for up to an interval.
      paused: this.isPaused(env),
      mode: env.EXECUTION_MODE === 'live' ? 'live' : 'dry_run',
      keySet: Boolean(env.SIGNER_KEY),
      address,
      env,
      lastTick,
      history,
      logs: logs.slice(0, 80),
      bins,
      binsHavePoolDepth: Boolean(depth),
      binsOursExact: depth ? depth.oursExact : true,
      poolContract: this.depth.contractOf(poolId),
      startError: running ? null : this.startErrors.get(profile.id) || null,
      cashOut: this.cashOuts.get(profile.id) || null,
      poolSwitch: this.poolSwitches.get(profile.id) || null,
      strayTokens: chain
        ? chain.tokens.filter((token) => token.contract !== profile.baseContract && token.contract !== profile.quoteContract)
        : [],
      liveWallet: chain
        ? {
            // The STX pool's base side is the STX wrapper, whose balance is native STX.
            base: profile.baseSymbol === 'STX' ? chain.stx : chain.tokens.find((token) => token.contract === profile.baseContract)?.amount || 0,
            quote: chain.tokens.find((token) => token.contract === profile.quoteContract)?.amount || 0,
            stx: chain.stx,
            asOf: new Date(chain.at).toISOString(),
          }
        : null,
      insights: insightsOf(file.points, file.lastTrade, Date.now()),
      priceScale: Math.pow(10, profile.baseDecimals - profile.quoteDecimals),
    };
  }

  private historyFile(profile: string, env: Record<string, string>): HistoryFile {
    const path = insideRoot(this.root, env.METRICS_LOG_FILE || `data/metrics.${profile}.jsonl`);
    let file = this.histories.get(path);
    if (!file) {
      file = new HistoryFile(path);
      this.histories.set(path, file);
    }
    return file;
  }

  private refuseDuringJob(profile: string): void {
    const job = this.cashOuts.get(profile);
    if (job && job.status === 'running') {
      throw new HttpError(409, 'cashing_out', 'Cash out is still running. Wait for it to finish.');
    }
    const move = this.poolSwitches.get(profile);
    if (move && move.status === 'running') {
      throw new HttpError(409, 'switching_pool', 'The pool change is still running. Wait for it to finish.');
    }
  }

  private isPaused(env: Record<string, string>): boolean {
    if (env.KILL_SWITCH === 'true') return true;
    if (!env.KILL_SWITCH_FILE) return false;
    return existsSync(insideRoot(this.root, env.KILL_SWITCH_FILE));
  }

  private verified = new Map<number, string>();

  private runningPid(profile: string): number | null {
    const pid = readPid(this.pidPath(profile));
    if (pid == null) return null;
    if (!this.host.alive(pid)) {
      this.verified.delete(pid);
      return null;
    }
    // A pid cannot be reused while its process lives, so one check per pid is enough.
    if (this.verified.get(pid) === profile) return pid;
    if (this.host.isBot && !this.host.isBot(pid, profile)) return null;
    this.verified.set(pid, profile);
    return pid;
  }

  /** Starts the bot. Returns an error sentence instead of throwing so a created bot is never lost. */
  private launch(profile: string): string {
    mkdirSync(join(this.root, 'data'), { recursive: true });
    try {
      const pid = this.host.spawn(profile);
      writeFileSync(this.pidPath(profile), `${pid}\n`);
      this.startErrors.delete(profile);
      return '';
    } catch (err) {
      const message = `The bot did not start: ${(err as Error).message}`;
      this.startErrors.set(profile, message);
      return message;
    }
  }

  /** Restarts a running bot so it reads its env file again. A stopped bot stays stopped. */
  private async restart(profile: string): Promise<string> {
    const pid = this.runningPid(profile);
    if (pid == null) return '';
    this.host.stop(pid);
    const started = Date.now();
    while (this.host.alive(pid) && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pidFile = this.pidPath(profile);
    if (readPid(pidFile) === pid) removeFile(pidFile);
    return this.launch(profile);
  }

  private envPath(profile: string): string {
    return join(this.root, `.env.${profile}`);
  }

  private pidPath(profile: string): string {
    const env = readEnvFile(this.envPath(profile));
    const rel = env.PID_FILE || `data/bot.${profile}.pid`;
    return insideRoot(this.root, rel);
  }

  private requireProfile(id: string): Profile {
    const profile = profileById(id);
    if (!profile) throw new HttpError(404, 'not_found', 'No bot with that id.');
    if (!existsSync(this.envPath(profile.id))) throw new HttpError(404, 'not_found', 'That bot has not been created.');
    return profile;
  }
}

export interface ManualBody {
  action: string;
  acknowledged: boolean;
  poolName: string;
  amount?: string;
  side?: string;
  xAmount?: string;
  yAmount?: string;
  pct?: number;
}

export interface BridgeBody {
  botId: string;
  direction: string;
  amount: string;
  acknowledged: boolean;
  poolName: string;
  reclaimPublicKey?: string;
  bitcoinAddress?: string;
}

const csvCell = (value: string | number | null | undefined): string => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Same columns as the page's own export, so the two files line up. */
export const decisionsCsvOf = (ticks: TickLike[]): string => {
  const header = ['time', 'kind', 'decision', 'summary', 'bot_reason', 'result', 'tx_ids', 'value_usd'];
  const rows = ticks.map((tick) => {
    const reason = humanReason(tick.reason, tick.decision);
    return [
      tick.t,
      reason.kind,
      tick.decision,
      reason.text,
      tick.reason || '',
      tick.executed ? 'sent' : tick.decision === 'rebalance' ? 'would_trade' : 'no_trade',
      (tick.txIds || []).join(' '),
      tick.portfolioValue == null ? '' : tick.portfolioValue.toFixed(2),
    ];
  });
  return `${[header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`;
};

const MANUAL_TIMEOUT_MS = 10 * 60_000;

// The bot's runners log a failure and exit 0, so success has to be read from the
// output. Known failures get a plain sentence; anything else shows the bot's words.
const MANUAL_FAILURES: Array<[RegExp, string]> = [
  [/no withdrawable positions/, 'There is nothing in the pool to withdraw.'],
  [/cannot cover tx fee/, 'The wallet does not have enough STX to pay the network fee.'],
  [/requires EXECUTION_MODE=live/, 'The bot is in dry run, so it will not send transactions.'],
  [/NODE_POSITION_NOT_REGISTERED|snapshot unusable|snapshot stale/, 'Bitflow could not confirm the position right now. Try again in a minute.'],
];

export const manualOutcome = (raw: string): { ok: boolean; message: string } => {
  const lines = raw.split('\n').map(parseLogLine).filter((line) => line.text);
  const failed = lines.find((line) => line.level === 'error' || line.level === 'fatal' || /ok=false|aborting/.test(line.text));
  if (failed) {
    const known = MANUAL_FAILURES.find(([pattern]) => pattern.test(failed.text));
    return { ok: false, message: known ? known[1] : failed.text.replace(/^\[\w+\]\s*/, '') };
  }
  const sent = [...lines].reverse().find((line) => /tx=0x[0-9a-f]+/i.test(line.text));
  if (sent) return { ok: true, message: sent.text.replace(/^\[\w+\]\s*/, '') };
  return lines.length ? { ok: true, message: lines[lines.length - 1].text } : { ok: false, message: 'The action did not report a result.' };
};

export const KEY_TAIL_CHARS = 4;
export const PAYOUT_TAIL_CHARS = 4;

/** The cash-out runner's own steps, without the token-metadata and preflight chatter around them. */
const cashOutLines = (raw: string): LogLine[] =>
  raw
    .split('\n')
    .map(parseLogLine)
    .filter((line) => line.text.startsWith('[cashout]'));

const manualArgs = (profile: Profile, body: ManualBody): string[] => {
  if (body.action === 'withdraw') {
    const pct = body.pct == null ? 100 : Number(body.pct);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new HttpError(400, 'pct', 'Withdraw percent is between 1 and 100.');
    return ['--withdraw-liquidity', '--pct', String(pct)];
  }
  if (body.action === 'swap') {
    const side = body.side === 'base' || body.side === 'quote' ? body.side : '';
    if (!side) throw new HttpError(400, 'side', 'Sell base or quote.');
    const decimals = side === 'base' ? profile.baseDecimals : profile.quoteDecimals;
    let micro = '';
    try {
      micro = decimalToMicro(body.amount || '', decimals);
    } catch (err) {
      throw new HttpError(400, 'amount', (err as Error).message);
    }
    return ['--swap', '--sell', side, '--amount', micro];
  }
  if (body.action === 'add') {
    let x = '';
    let y = '';
    try {
      x = decimalToMicro(body.xAmount || '', profile.baseDecimals);
      y = decimalToMicro(body.yAmount || '', profile.quoteDecimals);
    } catch (err) {
      throw new HttpError(400, 'amount', (err as Error).message);
    }
    return ['--add-liquidity', '--x', x, '--y', y];
  }
  throw new HttpError(400, 'action', 'Manual action is swap, add, or withdraw.');
};
