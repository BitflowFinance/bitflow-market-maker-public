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

export interface BinBar {
  id: number;
  pool: number;
  ours: number;
  active: boolean;
  price?: number;
}

export interface LogLine {
  t: string;
  level: string;
  text: string;
}

export type ReasonKind = 'paused' | 'holding' | 'rebuild' | 'derisk' | 'defensive' | 'gas' | 'stuck' | 'data' | 'halt' | 'pool' | 'other';

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

export interface Insights {
  since: string | null;
  inRange24h: number | null;
  trades24h: number;
  wouldTrades24h: number;
  tradesAll: number;
  gasStx24h: number;
  gasStxAll: number;
  lastTrade: { t: string; txIds: string[]; planType: string | null; sent: boolean } | null;
}

export interface MarketView {
  poolPrice: number;
  refPrice: number;
  refAgeMs: number | null;
  gapBps: number;
  haltBps: number;
}

export type HistoryRange = '1d' | '7d' | 'all';

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
  reason: { kind: ReasonKind; text: string } | null;
  reasonRaw: string | null;
  wouldSend: boolean;
  state: { tone: Tone; label: string; detail: string };
  price: number | null;
  walletBase: number | null;
  walletQuote: number | null;
  ownedBase: number | null;
  ownedQuote: number | null;
  portfolioValue: number | null;
  pnlVsHodl: number | null;
  inPoolValue: number | null;
  inventoryShare: number | null;
  summary: Array<{ label: string; value: string }>;
  needs: NeedItem[];
  checklist: CheckItem[];
  limits: Array<{ label: string; value: string; note: string }>;
  bins: BinBar[];
  binsHavePoolDepth: boolean;
  history: Array<{ t: string; value: number }>;
  decisions: DecisionRow[];
  logs: LogLine[];
  settings: Record<string, string>;
  startError: string | null;
  walletStx: number | null;
  gasTxLeft: number | null;
  market: MarketView | null;
  inventory: { share: number; target: number; soft: number; hard: number } | null;
  curve: { width: number; sizeFraction: number; repoDrift: number } | null;
  insights: Insights | null;
  binsOursExact: boolean;
  poolContract: string | null;
  keySource: 'create' | 'import' | 'phrase' | 'app-phrase' | null;
  walletAccount: number | null;
  keyBackedUp: boolean;
  keyBackupAt: string | null;
  payoutAddress: string | null;
  payoutMemo: string | null;
  cashOut: CashOutJob | null;
  poolSwitch: PoolSwitchJob | null;
  poolEdgeRoom: number | null;
  strayTokens: Array<{ contract: string; symbol: string; amount: number; known: boolean }>;
  /** Wallet balances read from the chain every few seconds, even while the bot is paused or stopped. */
  liveWallet: { base: number; quote: number; stx: number; asOf: string } | null;
  keysSet: Record<string, boolean>;
  readFailures: { count: number; max: number } | null;
}

export interface Strategy {
  kind: 'bitflow-mm-strategy';
  version: 1;
  pair: string;
  poolId: string;
  name: string;
  settings: Record<string, string>;
}

export interface PoolOption {
  poolId: string;
  name: string;
  binStepBps: number;
  feeBps: number | null;
  rangeLow: number | null;
  rangeHigh: number | null;
  price: number | null;
  activeBin: number;
  edgeRoom: number;
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

export interface PoolSwitchJob {
  status: 'running' | 'done' | 'failed';
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  lines: LogLine[];
}

export interface CashOutJob {
  status: 'running' | 'done' | 'failed';
  to: string;
  startedAt: string;
  finishedAt: string | null;
  lines: LogLine[];
}

export type KeyBackup =
  | { kind: 'key'; address: string; key: string; pair: string; file: string }
  | { kind: 'phrase'; address: string; phrase: string; account: number; pair: string; file: string };

export interface WalletInfo {
  hasPhrase: boolean;
  backedUp: boolean;
  nextAccount: number;
  /** Why a new app wallet cannot be made right now (a missing or broken .mm-wallet). */
  problem: string | null;
}

export interface PhraseAccount {
  account: number;
  address: string;
  /** Whether the address has sent a transaction or holds funds; null when it could not be told. */
  used: boolean | null;
  /** The id of the bot already on this account, if any. */
  bot: string | null;
}

export interface BookPart {
  botCount: number;
  label: string;
  value: number | null;
  valueComplete: boolean;
  inPool: number | null;
  vsHolding: number | null;
}

export interface Fleet {
  book: { real: BookPart; preview: BookPart };
  bots: BotView[];
  needs: NeedItem[];
  canCreate: boolean;
}

export interface ProfileInfo {
  id: string;
  pair: string;
  poolId: string;
  baseSymbol: string;
  quoteSymbol: string;
  halfWidth: number;
  taken: boolean;
  suggest: { base: string; quote: string; gas: string; note: string };
}

export interface BridgeTransfer {
  id: string;
  kind: 'deposit' | 'withdraw';
  status: 'sending' | 'sent' | 'processing' | 'done' | 'failed';
  amountSats: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  btcTxid: string | null;
  stacksTxid: string | null;
  btcAddress?: string;
  maxFeeSats?: number;
}

export interface BridgeView {
  botId: string;
  /** Demo mode: made-up balances and transfers. */
  demo: boolean;
  stacksAddress: string;
  tradesSbtc: boolean;
  deposit: { address: string; minSats: number | null; feeSats: number | null; maxFeeSats: number; lockBlocks: number } | null;
  withdraw: { minSats: number; maxSats: number | null; feeSats: number | null; costSats: number | null; heldSats: number | null; blocked: string | null };
  stx: number | null;
  transfers: BridgeTransfer[];
}

/**
 * A bot's page path, from its pair rather than its env-file id: sbtc-usdcx,
 * sbtc-usdcx-2 for a second bot of the pair, simulation-sbtc-usdcx. The id
 * stays the key everywhere else (env file, metrics, API).
 */
export const botSlug = (bot: { id: string; pair: string; preview: boolean }): string => {
  const pair = bot.pair.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const n = bot.preview ? null : bot.id.match(/-(\d+)$/);
  return `${bot.preview ? 'simulation-' : ''}${pair}${n ? `-${n[1]}` : ''}`;
};

export const botPath = (bot: { id: string; pair: string; preview: boolean }): string => `/bots/${botSlug(bot)}`;

/** The bot a page path names; bare ids from older links still resolve. */
export const botFromPath = <T extends { id: string; pair: string; preview: boolean }>(bots: T[], param: string): T | undefined =>
  bots.find((bot) => botSlug(bot) === param) || bots.find((bot) => bot.id === param);

export const mempoolTx = (txid: string): string => `https://mempool.space/tx/${txid}`;
export const mempoolAddress = (address: string): string => `https://mempool.space/address/${address}`;

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Offline. Is `npm run ui` still running?');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error || 'error', data.message || `Request failed (${res.status}).`);
  return data as T;
};

export const explorerTx = (txid: string): string =>
  `https://explorer.hiro.so/txid/${txid.startsWith('0x') ? txid : `0x${txid}`}?chain=mainnet`;

export const explorerContract = (principal: string): string => `https://explorer.hiro.so/txid/${principal}?chain=mainnet`;

export const explorerAddress = (address: string): string => `https://explorer.hiro.so/address/${address}?chain=mainnet`;
