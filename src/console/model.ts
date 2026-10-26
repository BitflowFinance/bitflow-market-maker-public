import { Insights } from './history';
import { HeldToken } from './walletTokens';

export interface TickLike {
  t: string;
  tickId?: number;
  decision: string;
  reason?: string;
  activeBinId?: number;
  activeBinPrice?: number;
  walletBase?: number;
  walletQuote?: number;
  ownedBase?: number;
  ownedQuote?: number;
  portfolioValue?: number | null;
  pnlVsHodl?: number | null;
  executed?: boolean;
  planType?: string | null;
  planSteps?: number;
  feesPaidStx?: number;
  walletStx?: number | null;
  ownedBinIds?: number[];
  txIds?: string[];
  holdingsCarried?: boolean;
  holdingsAsOf?: string | null;
  signals?: Record<string, number>;
}

export interface BinBar {
  id: number;
  pool: number;
  ours: number;
  active: boolean;
}

export type Tone = 'good' | 'info' | 'warn' | 'serious' | 'unknown';

export interface NeedItem {
  id: string;
  botId: string;
  tone: Tone;
  what: string;
  detail: string;
}

export interface CheckItem {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

export interface SummaryRow {
  label: string;
  value: string;
}

export interface LimitRow {
  label: string;
  value: string;
  note: string;
}

export interface LogLine {
  t: string;
  level: string;
  text: string;
}

export interface CashOutJob {
  status: 'running' | 'done' | 'failed';
  to: string;
  startedAt: string;
  finishedAt: string | null;
  lines: LogLine[];
}

export interface PoolSwitchJob {
  status: 'running' | 'done' | 'failed';
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  lines: LogLine[];
}

export interface LiveWallet {
  base: number;
  quote: number;
  stx: number;
  asOf: string;
}

export interface BotState {
  tone: Tone;
  label: string;
  detail: string;
}

export type ReasonKind =
  | 'paused'
  | 'holding'
  | 'rebuild'
  | 'derisk'
  | 'defensive'
  | 'gas'
  | 'stuck'
  | 'data'
  | 'halt'
  | 'pool'
  | 'other';

export interface Reason {
  kind: ReasonKind;
  text: string;
}

export interface DecisionRow {
  t: string;
  decision: string;
  kind: ReasonKind;
  text: string;
  raw: string;
  sent: boolean;
  wouldSend: boolean;
  txIds: string[];
  value: number | null;
  planType: string | null;
  planSteps: number;
}

export interface MarketView {
  poolPrice: number;
  refPrice: number;
  refAgeMs: number | null;
  gapBps: number;
  haltBps: number;
}

export interface InventoryView {
  share: number;
  target: number;
  soft: number;
  hard: number;
}

export interface CurveView {
  width: number;
  sizeFraction: number;
  repoDrift: number;
}

export interface BotView {
  id: string;
  profile: string | null;
  name: string | null;
  preview: boolean;
  pair: string;
  poolId: string;
  baseSymbol: string;
  quoteSymbol: string;
  running: boolean;
  paused: boolean;
  mode: 'dry_run' | 'live';
  keySet: boolean;
  address: string | null;
  tickIntervalMs: number;
  lastCheckAt: string | null;
  holdingsAsOf: string | null;
  holdingsCarried: boolean;
  decision: string | null;
  reason: Reason | null;
  reasonRaw: string | null;
  wouldSend: boolean;
  state: BotState;
  price: number | null;
  walletBase: number | null;
  walletQuote: number | null;
  ownedBase: number | null;
  ownedQuote: number | null;
  portfolioValue: number | null;
  pnlVsHodl: number | null;
  inPoolValue: number | null;
  inventoryShare: number | null;
  summary: SummaryRow[];
  needs: NeedItem[];
  checklist: CheckItem[];
  limits: LimitRow[];
  bins: BinBar[];
  binsHavePoolDepth: boolean;
  history: Array<{ t: string; value: number }>;
  decisions: DecisionRow[];
  logs: LogLine[];
  settings: Record<string, string>;
  startError: string | null;
  walletStx: number | null;
  /** Rough count of transactions the STX can still pay for. Null on the STX pool, where STX is also inventory. */
  gasTxLeft: number | null;
  market: MarketView | null;
  inventory: InventoryView | null;
  curve: CurveView | null;
  insights: Insights | null;
  binsOursExact: boolean;
  poolContract: string | null;
  keySource: 'create' | 'import' | null;
  keyBackedUp: boolean;
  keyBackupAt: string | null;
  payoutAddress: string | null;
  payoutMemo: string | null;
  cashOut: CashOutJob | null;
  poolSwitch: PoolSwitchJob | null;
  /** Bins between the price and the nearer edge of this pool's range. */
  poolEdgeRoom: number | null;
  /** Tokens in the wallet that this bot's pool doesn't use. */
  strayTokens: HeldToken[];
  liveWallet: LiveWallet | null;
  keysSet: Record<string, boolean>;
  /** Failed data reads in a row, against the count that halts the bot. Null when the last read worked. */
  readFailures: { count: number; max: number } | null;
}

export interface BotRecord {
  id: string;
  profile: string | null;
  /** The name the user gave the bot, or null for the pair's name. */
  name?: string | null;
  preview: boolean;
  pair: string;
  poolId: string;
  baseSymbol: string;
  quoteSymbol: string;
  running: boolean;
  paused: boolean;
  mode: 'dry_run' | 'live';
  keySet: boolean;
  address: string | null;
  env: Record<string, string>;
  lastTick: TickLike | null;
  history: TickLike[];
  logs: LogLine[];
  bins: BinBar[];
  binsHavePoolDepth: boolean;
  startError?: string | null;
  cashOut?: CashOutJob | null;
  poolSwitch?: PoolSwitchJob | null;
  strayTokens?: HeldToken[];
  /** Wallet balances read straight from the chain, independent of the bot's checks. */
  liveWallet?: LiveWallet | null;
  insights?: Insights | null;
  /** 10^(base decimals - quote decimals): turns the tick's raw bin price into a human one. */
  priceScale?: number;
  binsOursExact?: boolean;
  poolContract?: string | null;
}

const lower = (value: string): string => value.toLowerCase();

/** Turn the bot's free-text reason into one plain sentence and a coarse kind. */
export const humanReason = (reason: string | undefined | null, decision: string | null): Reason => {
  if (!reason) {
    if (decision === 'no_data') return { kind: 'data', text: 'Couldn’t read data this check.' };
    return { kind: 'other', text: decision ? `Decision: ${decision}.` : 'No reason given.' };
  }
  const r = lower(reason);
  if (r.startsWith('kill_switch')) return { kind: 'paused', text: 'Paused.' };
  if (r.startsWith('pool_inactive')) return { kind: 'pool', text: 'The pool is paused on Bitflow. Waiting.' };
  if (r.startsWith('peg_unavailable')) return { kind: 'data', text: 'Couldn’t read the market price. Waiting.' };
  if (r.startsWith('snapshot_fetch_failed') && r.includes('wallet balance read failed')) {
    return { kind: 'data', text: 'Couldn’t read the wallet balance. Waiting.' };
  }
  if (r.startsWith('snapshot_fetch_failed')) return { kind: 'data', text: 'Couldn’t read the pool. Waiting.' };
  if (r.startsWith('stale_tip') || r.includes('tip_lag')) {
    return { kind: 'data', text: 'Pool data is out of date. Waiting.' };
  }
  if (r.startsWith('preflight_failed')) return { kind: 'stuck', text: 'Pre-send wallet check failed. Nothing sent.' };
  if (r.startsWith('pool_id_unset')) return { kind: 'other', text: 'No pool set.' };
  if (r.includes('divergence')) {
    const m = reason.match(/divergence\s+(\d+)bps\s*>\s*halt\s+(\d+)bps/);
    const detail = m ? ` (${m[1]} bps, limit ${m[2]})` : '';
    return { kind: 'halt', text: `Pool and market prices disagree${detail}. Halted.` };
  }
  if (r.includes('peg broken')) return { kind: 'halt', text: 'Stablecoin is off its peg. Halted.' };
  if (r.includes('reference feed stale')) {
    return { kind: 'halt', text: 'Market price is stale. Halted.' };
  }
  if (r.startsWith('broken_market') || r.startsWith('operational')) {
    return { kind: 'halt', text: 'Safety halt. Waiting to recover.' };
  }
  if (r.includes('nonce gap')) return { kind: 'stuck', text: 'Waiting on a missing transaction (nonce gap).' };
  if (r.includes('pending in the mempool')) return { kind: 'stuck', text: 'Waiting for a pending transaction.' };
  if (r.includes('top up stx') || r.includes('cannot cover') || r.includes('below min tx fee')) {
    return { kind: 'gas', text: 'Out of STX for fees. Add STX to the wallet.' };
  }
  if (r.startsWith('defensive')) return { kind: 'defensive', text: 'Holding defensively.' };
  if (r.startsWith('in range') || r === 'in_range') {
    return { kind: 'holding', text: 'In range. Earning fees.' };
  }
  if (r.includes('add disabled')) return { kind: 'holding', text: 'Wants to re-center, but adding is off.' };
  if (r.startsWith('reposition') || r === 'drift') {
    return { kind: 'rebuild', text: 'Price moved. Re-centering.' };
  }
  if (r.includes('de-risk') || r.includes('derisk')) {
    return { kind: 'derisk', text: 'Holding too much of the base token. Selling some.' };
  }
  return { kind: 'other', text: reason };
};

const NEED_KINDS: Partial<Record<ReasonKind, { tone: Tone; what: string }>> = {
  gas: { tone: 'warn', what: 'needs STX for fees' },
  stuck: { tone: 'warn', what: 'has a stuck transaction' },
  data: { tone: 'warn', what: 'can’t read data' },
  pool: { tone: 'warn', what: 'pool is paused' },
  halt: { tone: 'serious', what: 'is halted' },
};

const ANSI = /\u001b\[[0-9;]*m/g;
const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

export const parseLogLine = (raw: string): LogLine => {
  const line = raw.replace(ANSI, '').trim();
  if (line.startsWith('{')) {
    try {
      const parsed = JSON.parse(line) as { level?: number; time?: number; msg?: string };
      const t = typeof parsed.time === 'number' ? new Date(parsed.time).toTimeString().slice(0, 8) : '';
      return { t, level: LEVELS[parsed.level || 30] || 'info', text: parsed.msg || line };
    } catch {
      // Fall through to the plain-text shape.
    }
  }
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})(?:\.\d+)?\]\s+([A-Z]+)(?:\s+\(\d+\))?:\s?(.*)$/);
  if (m) return { t: m[1], level: m[2].toLowerCase(), text: m[3] };
  return { t: '', level: 'info', text: line };
};

const num = (value: string | undefined, fallback: string): string => {
  if (value === undefined || value === '') return fallback;
  return value;
};

const stxReserve = (env: Record<string, string>): string => {
  const micro = Number(env.STX_GAS_RESERVE_USTX || '5000000');
  if (!Number.isFinite(micro)) return 'unset';
  return `${micro / 1e6} STX`;
};

/** Optional provider keys. Like SIGNER_KEY they are written, never read back; the page only learns whether each is set. */
export const API_KEY_NAMES = ['STACKS_NODE_KEY', 'BFF_API_KEY', 'COINGECKO_API_KEY'];

export const publicSettings = (env: Record<string, string>): Record<string, string> => {
  const hidden = new Set(['SIGNER_KEY', ...API_KEY_NAMES]);
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (hidden.has(key)) continue;
    out[key] = env[key];
  }
  return out;
};

export const SETTING_KEYS = [
  'EXECUTION_MODE',
  'TICK_INTERVAL_MS',
  'CURVE_HALF_WIDTH_BINS',
  'CURVE_DECAY',
  'CURVE_SIZE_FRACTION',
  'CURVE_REPOSITION_DRIFT_BINS',
  'ENABLE_SWAP',
  'DIVERGENCE_HALT_BPS',
  'F_STAR',
  'F_SOFT',
  'F_HARD',
  'DERISK_MAX_FRACTION',
  'STX_GAS_RESERVE_USTX',
  'MAX_POSITION_USTX',
  'BREAKER_WITHDRAW_ALL',
  'MIN_TX_FEE_USTX',
  'MAX_TX_FEE_USTX',
];

const RANGES: Record<string, [number, number]> = {
  TICK_INTERVAL_MS: [10_000, 3_600_000],
  CURVE_HALF_WIDTH_BINS: [1, 100],
  CURVE_DECAY: [0.01, 1],
  CURVE_SIZE_FRACTION: [0.01, 1],
  CURVE_REPOSITION_DRIFT_BINS: [1, 100],
  DIVERGENCE_HALT_BPS: [0, 10_000],
  F_STAR: [0, 1],
  F_SOFT: [0, 1],
  F_HARD: [0, 1],
  DERISK_MAX_FRACTION: [0, 1],
  STX_GAS_RESERVE_USTX: [0, 1e15],
  MAX_POSITION_USTX: [0, 1e18],
  MIN_TX_FEE_USTX: [1, 1e9],
  MAX_TX_FEE_USTX: [1, 1e9],
};

const BOOLEAN_KEYS = ['ENABLE_SWAP', 'BREAKER_WITHDRAW_ALL'];

/** Empty string when valid; otherwise one sentence naming the bad setting. */
export const validateSettings = (updates: Record<string, string>, current: Record<string, string>): string => {
  for (const key of Object.keys(updates)) {
    const value = String(updates[key]).trim();
    if (BOOLEAN_KEYS.indexOf(key) >= 0) {
      if (value !== 'true' && value !== 'false') return `${key} must be true or false.`;
      continue;
    }
    const range = RANGES[key];
    if (!range) continue;
    if (!/^\d+(\.\d+)?$/.test(value)) return `${key} must be a number.`;
    const n = Number(value);
    if (n < range[0] || n > range[1]) return `${key} must be between ${range[0]} and ${range[1]}.`;
  }
  const merged = { ...current, ...updates };
  const star = Number(num(merged.F_STAR, '0.38'));
  const soft = Number(num(merged.F_SOFT, '0.52'));
  const hard = Number(num(merged.F_HARD, '0.67'));
  if (star > soft) return 'F_STAR must not be above F_SOFT.';
  if (soft > hard) return 'F_SOFT must not be above F_HARD.';
  const minFee = Number(num(merged.MIN_TX_FEE_USTX, '10000'));
  const maxFee = Number(num(merged.MAX_TX_FEE_USTX, '3000000'));
  if (minFee > maxFee) return 'MIN_TX_FEE_USTX must not be above MAX_TX_FEE_USTX.';
  return '';
};

// Ticks store the active bin price as quote-micro per base-micro. That equals the
// human price only when both tokens share decimals (STX/USDCx); sBTC has 8 to
// USDCx's 6, so its raw price reads 100x low until scaled.
const priceOf = (record: BotRecord): number | null => {
  const tick = record.lastTick;
  if (!tick || tick.activeBinPrice == null || !(tick.activeBinPrice > 0)) return null;
  return tick.activeBinPrice * (record.priceScale ?? 1);
};

const inPool = (record: BotRecord): number | null => {
  const tick = record.lastTick;
  const price = priceOf(record);
  if (!tick || price == null) return null;
  if (tick.ownedBase == null || tick.ownedQuote == null) return null;
  return tick.ownedQuote + tick.ownedBase * price;
};

const intervalOf = (env: Record<string, string>): number => {
  const n = Number(env.TICK_INTERVAL_MS || '120000');
  return Number.isFinite(n) && n > 0 ? n : 120_000;
};

const staleMs = (record: BotRecord, nowMs: number): number | null => {
  if (!record.lastTick) return null;
  const at = new Date(record.lastTick.t).getTime();
  if (!Number.isFinite(at)) return null;
  const age = nowMs - at;
  return age > intervalOf(record.env) * 3 ? age : null;
};

const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

export const stateOf = (record: BotRecord, nowMs: number): BotState => {
  if (record.preview) {
    if (!record.running) return { tone: 'unknown', label: 'Stopped', detail: 'Stopped.' };
    if (record.paused) return { tone: 'info', label: 'Paused', detail: 'Paused.' };
    return { tone: 'good', label: 'Running', detail: 'Running with simulated funds.' };
  }
  if (!record.running) {
    return {
      tone: 'serious',
      label: 'Stopped',
      detail: record.startError || 'Stopped. Liquidity stays in the pool.',
    };
  }
  if (record.paused) {
    return {
      tone: 'warn',
      label: 'Paused',
      detail: 'Paused. Watching, not trading.',
    };
  }
  const tick = record.lastTick;
  if (tick && tick.reason === 'kill_switch') {
    return { tone: 'info', label: 'Resuming', detail: 'Resumed. Trading again from the next check.' };
  }
  if (!tick) return { tone: 'unknown', label: 'Starting', detail: 'Waiting for the first check.' };
  const stale = staleMs(record, nowMs);
  if (stale != null) return { tone: 'warn', label: 'Quiet', detail: `No check for ${minutes(stale)}.` };
  const reason = humanReason(tick.reason, tick.decision);
  if (tick.decision === 'no_data') return { tone: 'serious', label: 'No data', detail: reason.text };
  if (tick.decision === 'frozen') return { tone: 'serious', label: 'Frozen', detail: reason.text };
  const need = NEED_KINDS[reason.kind];
  if (need) return { tone: need.tone, label: 'Holding', detail: reason.text };
  return { tone: 'good', label: 'Running', detail: reason.text };
};

export const needsOf = (record: BotRecord, nowMs: number): NeedItem[] => {
  if (record.preview) return [];
  const item = (suffix: string, tone: Tone, what: string, detail: string): NeedItem => ({
    id: `${record.id}:${suffix}`,
    botId: record.id,
    tone,
    what: `${record.name || record.pair} ${what}`,
    detail,
  });
  if (!record.running) {
    return [item('stopped', 'serious', 'is stopped', record.startError || 'Liquidity stays in the pool.')];
  }
  if (record.paused) return [];
  if (!record.lastTick) {
    return [item('nocheck', 'unknown', 'hasn’t checked in yet', 'No result yet.')];
  }
  const stale = staleMs(record, nowMs);
  if (stale != null) return [item('quiet', 'warn', `hasn’t checked in for ${minutes(stale)}`, 'Check the log.')];
  const reason = humanReason(record.lastTick.reason, record.lastTick.decision);
  if (record.lastTick.decision === 'no_data') return [item('data', 'serious', 'can’t read data', reason.text)];
  const need = NEED_KINDS[reason.kind];
  if (need) return [item(reason.kind, need.tone, need.what, reason.text)];
  const strays = record.strayTokens || [];
  if (strays.length) {
    return [
      item(
        'stray',
        'warn',
        'holds tokens it doesn’t trade',
        `${strays.map((token) => token.symbol).join(', ')} in the wallet. Cash out sends ${strays.some((token) => !token.known) ? 'Bitflow-listed tokens' : 'them'} to your payout address.`,
      ),
    ];
  }
  const room = edgeRoomOf(record);
  // Three curve widths leaves time to move before the curve no longer fits.
  if (room != null && room < curveWidthOf(record) * 3) {
    return [item('edge', 'warn', 'is near the edge of its pool', `The price is ${room} bins from the end of this pool’s range. Consider changing pools.`)];
  }
  const txLeft = gasTxLeftOf(record);
  if (txLeft != null && txLeft < GAS_WARN_TXS) {
    return [item('gas-low', 'warn', 'is low on STX for fees', `About ${txLeft} transactions left. Add STX to the wallet.`)];
  }
  if (record.lastTick.decision === 'frozen') return [item('frozen', 'serious', 'is frozen', reason.text)];
  return [];
};

export const checklistOf = (record: BotRecord, sharedAddress: boolean): CheckItem[] => {
  const tick = record.lastTick;
  const checked = tick != null && tick.decision !== 'no_data';
  // The chain's own balance beats the bot's, which is stale while it is paused or stopped.
  const live = record.liveWallet;
  const funded = live
    ? live.base > 0 || live.quote > 0 || (tick?.ownedQuote || 0) > 0 || (tick?.ownedBase || 0) > 0
    : tick != null && ((tick.walletQuote || 0) > 0 || (tick.walletBase || 0) > 0 || (tick.ownedQuote || 0) > 0);
  const backedUp = keyBackedUp(record.env);
  return [
    {
      id: 'real',
      ok: !record.preview,
      label: 'Real bot',
      detail: record.preview ? 'Previews can’t go live.' : '',
    },
    {
      id: 'key',
      ok: record.keySet,
      label: 'Wallet key saved',
      detail: record.keySet ? '' : 'Create or import a wallet.',
    },
    {
      id: 'backup',
      ok: record.keySet && backedUp,
      label: 'Key backed up',
      detail: !record.keySet ? 'Create or import a wallet.' : backedUp ? '' : 'Back up the key on the Wallet tab.',
    },
    {
      id: 'one-wallet',
      ok: Boolean(record.address) && !sharedAddress,
      label: 'Wallet not shared',
      detail: !record.address
        ? 'No wallet yet.'
        : sharedAddress
          ? 'Another bot uses this wallet. Give each bot its own.'
          : '',
    },
    {
      id: 'kill-file',
      ok: Boolean(record.env.KILL_SWITCH_FILE),
      label: 'Pause file set',
      detail: record.env.KILL_SWITCH_FILE
        ? ''
        : 'Set KILL_SWITCH_FILE so Pause works instantly.',
    },
    {
      id: 'checked',
      ok: checked,
      label: 'Has checked the pool',
      detail: checked ? '' : 'Start the bot and wait for a check.',
    },
    {
      id: 'funded',
      ok: funded,
      label: 'Wallet funded',
      detail: funded ? '' : tick ? 'The wallet is empty.' : 'Unknown until the bot checks the wallet.',
    },
    {
      id: 'dry-run',
      ok: record.mode === 'dry_run',
      label: 'Tried in dry run',
      detail:
        record.mode === 'dry_run' ? '' : 'Already live.',
    },
  ];
};

// An imported key already lives in the user's own wallet app, so only a key this
// app generated needs the backup step.
const keyBackedUp = (env: Record<string, string>): boolean =>
  env.KEY_SOURCE === 'import' || Boolean(env.KEY_BACKUP_AT);

export const liveBlockedBy = (checks: CheckItem[]): CheckItem[] =>
  checks.filter((item) => item.id !== 'dry-run' && !item.ok);

export const summaryOf = (record: BotRecord): SummaryRow[] => {
  const env = record.env;
  const swap = env.ENABLE_SWAP !== 'false';
  const width = num(env.CURVE_HALF_WIDTH_BINS, '6');
  const size = num(env.CURVE_SIZE_FRACTION, '0.45');
  const hard = num(env.F_HARD, '0.67');
  const every = Math.round(intervalOf(env) / 1000);
  return [
    {
      label: 'Running',
      value: !record.running ? 'No. The process is off.' : record.paused ? 'Yes, but paused.' : `Yes. Checks every ${every}s.`,
    },
    {
      label: 'Money',
      value: record.preview
        ? 'Simulated. No wallet.'
        : record.mode === 'live'
          ? 'Real. Transactions can be sent.'
          : 'Practice. Decisions are logged, nothing is sent.',
    },
    { label: 'Kill switch', value: record.paused ? 'On. No new trades.' : 'Off.' },
    { label: 'Auto-sell', value: swap ? `On, past ${Math.round(Number(hard) * 100)}% in the base token.` : 'Off.' },
    { label: 'Curve', value: `±${width} bins, ${Math.round(Number(size) * 100)}% of funds.` },
    { label: 'Gas set aside', value: stxReserve(env) },
  ];
};

export const limitsOf = (record: BotRecord): LimitRow[] => {
  const env = record.env;
  const maxPos = Number(env.MAX_POSITION_USTX || '0');
  const withdraw = env.BREAKER_WITHDRAW_ALL === 'true';
  const pct = (value: string) => `${Math.round(Number(value) * 100)}%`;
  return [
    {
      label: 'Inventory bands',
      value: `${pct(num(env.F_STAR, '0.38'))} · ${pct(num(env.F_SOFT, '0.52'))} · ${pct(num(env.F_HARD, '0.67'))}`,
      note: 'Target · soft · hard share of value in the base token.',
    },
    {
      label: 'Price gap halt',
      value: `${num(env.DIVERGENCE_HALT_BPS, '150')} bps`,
      note: '',
    },
    {
      label: 'Max position',
      value: maxPos > 0 ? `${maxPos / 1e6} STX` : 'Not set',
      note: '',
    },
    {
      label: 'Gas reserve',
      value: stxReserve(env),
      note: '',
    },
    {
      label: 'Halt after',
      value: `${num(env.MAX_CONSECUTIVE_API_ERRORS, '5')} failed reads`,
      note: withdraw ? 'Then withdraws (live only).' : 'Liquidity stays in the pool.',
    },
  ];
};

const decisionsOf = (history: TickLike[]): DecisionRow[] => {
  const out: DecisionRow[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < 60; i -= 1) {
    const tick = history[i];
    const reason = humanReason(tick.reason, tick.decision);
    out.push({
      t: tick.t,
      decision: tick.decision,
      kind: reason.kind,
      text: reason.text,
      raw: tick.reason || '',
      sent: Boolean(tick.executed),
      wouldSend: tick.decision === 'rebalance' && !tick.executed,
      txIds: tick.txIds || [],
      value: tick.portfolioValue ?? null,
      planType: tick.planType || null,
      planSteps: tick.planSteps || 0,
    });
  }
  return out;
};

// Fewer than this many fees left in the tank is worth a warning before trades start failing.
const GAS_WARN_TXS = 20;

const feeEstimateStx = (env: Record<string, string>): number =>
  Number(env.DEFAULT_TX_FEE_USTX || env.MIN_TX_FEE_USTX || '50000') / 1e6;

const gasTxLeftOf = (record: BotRecord): number | null => {
  const stx = record.lastTick?.walletStx;
  if (stx == null || record.baseSymbol === 'STX' || record.quoteSymbol === 'STX') return null;
  const fee = feeEstimateStx(record.env);
  return fee > 0 ? Math.floor(stx / fee) : null;
};

const marketOf = (record: BotRecord): MarketView | null => {
  const tick = record.lastTick;
  const s = tick?.signals;
  const poolPrice = priceOf(record);
  if (!tick || !s || !(s.refPrice > 0) || poolPrice == null) return null;
  return {
    poolPrice,
    refPrice: s.refPrice,
    refAgeMs: Number.isFinite(s.refAgeMs) ? s.refAgeMs : null,
    gapBps: Number.isFinite(s.dBps) ? s.dBps : Math.round((Math.abs(poolPrice - s.refPrice) / s.refPrice) * 10000),
    haltBps: Number(num(record.env.DIVERGENCE_HALT_BPS, '150')),
  };
};

// The bot halts after this many failed reads in a row; the trailing run of
// data-kind reasons in its history is the same count.
const readFailuresOf = (record: BotRecord): { count: number; max: number } | null => {
  let count = 0;
  for (let i = record.history.length - 1; i >= 0; i -= 1) {
    const tick = record.history[i];
    if (humanReason(tick.reason, tick.decision).kind !== 'data') break;
    count += 1;
  }
  return count ? { count, max: Number(num(record.env.MAX_CONSECUTIVE_API_ERRORS, '5')) } : null;
};

// Ticks carry unsigned bins (0..1000); the pool's range ends 500 bins either side of 500.
const edgeRoomOf = (record: BotRecord): number | null => {
  const active = record.lastTick?.activeBinId;
  if (active == null || active < 0) return null;
  return 500 - Math.abs(active - 500);
};

const curveWidthOf = (record: BotRecord): number => {
  const width = record.lastTick?.signals?.width;
  return Number.isFinite(width) ? (width as number) : Number(num(record.env.CURVE_HALF_WIDTH_BINS, '6'));
};

const curveOf = (record: BotRecord): CurveView | null => {
  const s = record.lastTick?.signals;
  if (!s || !Number.isFinite(s.width)) return null;
  return { width: s.width, sizeFraction: s.size, repoDrift: s.repoDrift };
};

const inventoryOf = (record: BotRecord, computed: number | null): InventoryView | null => {
  // The strategy's own f is what its bands act on; the page's sum is the fallback.
  const f = record.lastTick?.signals?.f;
  const share = Number.isFinite(f) ? (f as number) : computed;
  if (share == null) return null;
  return {
    share,
    target: Number(num(record.env.F_STAR, '0.38')),
    soft: Number(num(record.env.F_SOFT, '0.52')),
    hard: Number(num(record.env.F_HARD, '0.67')),
  };
};

/**
 * The newest check that actually read balances. A paused bot skips the read, and
 * a restarted one has nothing to carry forward, so its checks record zeros that
 * were never read; showing those would blank the overview and claim an empty wallet.
 */
export const valuedTick = (history: TickLike[]): TickLike | null => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const tick = history[i];
    // Ticks written before holdingsAsOf existed count when they carry a value.
    if (tick.holdingsAsOf != null || (tick.holdingsAsOf === undefined && tick.portfolioValue != null)) return tick;
  }
  return null;
};

export const toView = (record: BotRecord, sharedAddress: boolean, nowMs: number): BotView => {
  const latest = record.lastTick;
  const valued = valuedTick(record.history) || latest;
  // Status comes from the latest check; balances, price and value from the last one that read them.
  const shown: BotRecord = { ...record, lastTick: valued };
  // Failed reads carry balances forward but have no strategy signals, so the
  // market check, curve and inventory bands come from the last check that had them.
  const signalled = [...record.history].reverse().find((item) => item.signals && Object.keys(item.signals).length) || valued;
  const strategic: BotRecord = { ...record, lastTick: signalled };
  const tick = valued;
  const price = priceOf(shown);
  const value = tick ? (tick.portfolioValue ?? null) : null;
  const baseValue = tick && price != null ? ((tick.walletBase || 0) + (tick.ownedBase || 0)) * price : null;
  return {
    id: record.id,
    profile: record.profile,
    name: record.name || null,
    preview: record.preview,
    pair: record.pair,
    poolId: record.poolId,
    baseSymbol: record.baseSymbol,
    quoteSymbol: record.quoteSymbol,
    running: record.running,
    paused: record.paused,
    mode: record.mode,
    keySet: record.keySet,
    address: record.address,
    tickIntervalMs: intervalOf(record.env),
    lastCheckAt: latest ? latest.t : null,
    holdingsAsOf: tick ? tick.holdingsAsOf || tick.t : null,
    holdingsCarried: Boolean(tick && (tick !== latest || tick.holdingsCarried)),
    decision: latest ? latest.decision : null,
    reason: latest ? humanReason(latest.reason, latest.decision) : null,
    reasonRaw: latest ? latest.reason || null : null,
    wouldSend: Boolean(latest && latest.decision === 'rebalance' && !latest.executed),
    state: stateOf(record, nowMs),
    price,
    walletBase: tick && tick.walletBase != null ? tick.walletBase : null,
    walletQuote: tick && tick.walletQuote != null ? tick.walletQuote : null,
    ownedBase: tick && tick.ownedBase != null ? tick.ownedBase : null,
    ownedQuote: tick && tick.ownedQuote != null ? tick.ownedQuote : null,
    portfolioValue: value,
    pnlVsHodl: tick ? (tick.pnlVsHodl ?? null) : null,
    inPoolValue: inPool(shown),
    inventoryShare: value && baseValue != null && value > 0 ? baseValue / value : null,
    walletStx: tick && tick.walletStx != null ? tick.walletStx : null,
    gasTxLeft: gasTxLeftOf(shown),
    market: marketOf(strategic),
    inventory: inventoryOf(strategic, value && baseValue != null && value > 0 ? baseValue / value : null),
    curve: curveOf(strategic),
    insights: record.insights || null,
    binsOursExact: record.binsOursExact !== false,
    poolContract: record.poolContract || null,
    summary: summaryOf(record),
    needs: needsOf(record, nowMs),
    checklist: checklistOf(record, sharedAddress),
    limits: limitsOf(record),
    bins: record.bins,
    binsHavePoolDepth: record.binsHavePoolDepth,
    history: record.history
      .filter((item) => item.portfolioValue != null && Number.isFinite(item.portfolioValue))
      .map((item) => ({ t: item.t, value: item.portfolioValue as number })),
    decisions: decisionsOf(record.history),
    logs: record.logs,
    settings: publicSettings(record.env),
    startError: record.startError || null,
    keySource: record.env.KEY_SOURCE === 'create' || record.env.KEY_SOURCE === 'import' ? record.env.KEY_SOURCE : null,
    keyBackedUp: record.keySet && keyBackedUp(record.env),
    keyBackupAt: record.env.KEY_BACKUP_AT || null,
    payoutAddress: record.env.PAYOUT_ADDRESS || null,
    payoutMemo: record.env.PAYOUT_MEMO || null,
    cashOut: record.cashOut || null,
    poolSwitch: record.poolSwitch || null,
    poolEdgeRoom: edgeRoomOf(record),
    strayTokens: record.strayTokens || [],
    liveWallet: record.liveWallet || null,
    keysSet: Object.fromEntries(API_KEY_NAMES.map((name) => [name, Boolean(record.env[name])])),
    readFailures: readFailuresOf(record),
  };
};

export interface BookPart {
  botCount: number;
  label: string;
  value: number | null;
  valueComplete: boolean;
  inPool: number | null;
  vsHolding: number | null;
}

export interface BookView {
  real: BookPart;
  preview: BookPart;
}

const partOf = (bots: BotView[]): BookPart => {
  if (bots.length === 0) {
    return { botCount: 0, label: 'No bots running', value: null, valueComplete: false, inPool: null, vsHolding: null };
  }
  let value = 0;
  let valueMissing = false;
  let pool = 0;
  let poolKnown = false;
  let pnl = 0;
  let pnlKnown = false;
  for (const bot of bots) {
    if (bot.portfolioValue == null) valueMissing = true;
    else value += bot.portfolioValue;
    if (bot.inPoolValue != null) {
      pool += bot.inPoolValue;
      poolKnown = true;
    }
    if (bot.pnlVsHodl != null) {
      pnl += bot.pnlVsHodl;
      pnlKnown = true;
    }
  }
  const known = bots.some((bot) => bot.portfolioValue != null);
  return {
    botCount: bots.length,
    label: known ? (valueMissing ? 'Partial value' : 'Total value') : 'Value unavailable',
    value: known ? value : null,
    valueComplete: known && !valueMissing,
    inPool: poolKnown ? pool : null,
    vsHolding: pnlKnown ? pnl : null,
  };
};

export const bookOf = (bots: BotView[]): BookView => ({
  real: partOf(bots.filter((bot) => !bot.preview)),
  preview: partOf(bots.filter((bot) => bot.preview)),
});
