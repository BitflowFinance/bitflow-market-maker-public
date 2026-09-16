import path from 'path';
import { config as dotenvConfig } from 'dotenv';

// One process per pool, each with its own wallet/env file. The env file is
// chosen BEFORE dotenv loads, so the selector must come from the real process
// environment (CLI flag or pre-set var), never from inside the .env itself.
// Precedence: --env/ENV_FILE (explicit path) > --pool/POOL_PROFILE
// (maps to `.env.<name>`) > `.env` (default, single-pool/back-compat).
// The flag is `--env`, not `--env-file`: Node >=20.6 has its own built-in
// --env-file option and claims the argument before we ever parse argv, killing
// the process with "node: <path>: not found".
const readArg = (name: string): string | undefined => {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return undefined;
};

const POOL_PROFILE = readArg('--pool') || process.env.POOL_PROFILE || '';
const resolveEnvFile = (): string => {
  const explicit = readArg('--env') || process.env.ENV_FILE;
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
  }
  const file = POOL_PROFILE ? `.env.${POOL_PROFILE}` : '.env';
  return path.join(process.cwd(), file);
};

const ENV_FILE = resolveEnvFile();
dotenvConfig({ path: ENV_FILE });

export type ExecutionMode = 'dry_run' | 'live';
export type PostConditionModeName = 'allow' | 'deny';

export interface AppConfig {
  ENVIRONMENT_TYPE: string;
  EXECUTION_MODE: ExecutionMode;
  TICK_INTERVAL_MS: number;

  // Which pool profile this process runs (e.g. "sbtc" -> loaded `.env.sbtc`).
  // Empty for the default single-pool `.env`. ENV_FILE is the resolved path.
  POOL_PROFILE: string;
  ENV_FILE: string;
  POOL_ID: string;
  // Selects the feed+strategy pair from the registry (src/registry.ts).
  POOL_STRATEGY: string;
  SIGNER_ADDRESS: string;
  SIGNER_KEY: string;

  BFF_API_BASE_URL: string;
  BFF_API_KEY: string;
  // 'v2' (default) or 'v1'. The two generations must not be mixed: v2 reports bin
  // ids in a signed domain and serves inventory from a different endpoint, so the
  // adapter in bitflow.ts normalizes a whole generation at once. v1 is kept as an
  // escape hatch while v2 beds in.
  BFF_API_VERSION: string;
  // Max blocks the v2 engine's state may trail the chain tip before we hold the
  // tick. 0 = only trade on a fully caught-up view (Bitflow's own guidance).
  BFF_MAX_TIP_LAG: number;

  STACKS_NODE_URL: string;
  STACKS_NODE_KEY: string;
  STACKS_NETWORK_VERSION: string;

  // Pool orientation (neutral). base = the quoted/volatile side; quote = the
  // numeraire (price = quote per base). Set both in the pair env file.
  BASE_TOKEN_CONTRACT: string;
  QUOTE_TOKEN_CONTRACT: string;
  // SIP-010 asset names + decimals. NOT set via env -- resolved from the BFF
  // token registry at startup (hydrateTokenMetadata). Values below are only
  // pre-hydration fallbacks (sBTC 8d / USDCx 6d).
  BASE_ASSET_NAME: string;
  QUOTE_ASSET_NAME: string;
  BASE_DECIMALS: number;
  QUOTE_DECIMALS: number;
  // Native-STX SIP-010 wrapper. Transfers of this contract move native STX, so
  // liquidity/swap builders use STX post-conditions. Also identifies the gas
  // asset when it coincides with a pool side (STX/USDCx).
  STX_TOKEN_CONTRACT: string;

  SWAP_ROUTER_CONTRACT: string;
  SWAP_MAX_STEPS: number;
  SWAP_SLIPPAGE_BPS: number;
  SWAP_POST_CONDITION_MODE: PostConditionModeName;
  MAX_SWAP_INPUT_USTX: number;

  LIQUIDITY_ROUTER_CONTRACT: string;
  POOL_LP_ASSET_NAME: string;
  POOL_NFT_ASSET_NAME: string;
  NFT_PC_BIN_ID_BUFFER: number;
  LIQUIDITY_SLIPPAGE_BPS: number;
  ACTIVE_BIN_MAX_DEVIATION: number;
  TX_DEADLINE_SECONDS: number;
  LIQUIDITY_POST_CONDITION_MODE: PostConditionModeName;

  // Curve / market-follower. Shaped multi-bin deployment centered on the active
  // bin: CURVE_HALF_WIDTH_BINS on each side, geometric weight decay outward
  // (active bin heaviest), CURVE_SIZE_FRACTION of inventory deployed.
  CURVE_HALF_WIDTH_BINS: number;
  CURVE_DECAY: number;
  CURVE_SIZE_FRACTION: number;
  CURVE_REPOSITION_DRIFT_BINS: number;
  CURVE_MAX_REPOSITION_DRIFT_BINS: number;
  SIGMA_REF: number;
  CURVE_MAX_HALF_WIDTH_BINS: number;
  CURVE_MIN_SIZE_FRACTION: number;
  CURVE_BID_LEAN_MAX: number;
  DIVERGENCE_WARN_BPS: number;
  DIVERGENCE_HALT_BPS: number;
  REFERENCE_FEED_HALT_MS: number;
  F_STAR: number;
  F_SOFT: number;
  F_HARD: number;
  DERISK_MAX_FRACTION: number;

  KILL_SWITCH: boolean;
  KILL_SWITCH_FILE: string;
  MAX_POSITION_USTX: number;

  MAX_CONSECUTIVE_API_ERRORS: number;
  BREAKER_WITHDRAW_ALL: boolean;

  ENABLE_SWAP: boolean;
  ENABLE_ADD_LIQUIDITY: boolean;
  ENABLE_WITHDRAW_LIQUIDITY: boolean;

  MIN_TX_FEE_USTX: number;
  MAX_TX_FEE_USTX: number;
  DEFAULT_TX_FEE_USTX: number;
  FEE_MEMPOOL_PERCENTILE: string;
  FEE_OUTLIER_MULTIPLE: number;
  STX_GAS_RESERVE_USTX: number;
  TX_CONFIRMATION_TIMEOUT_MS: number;
  TX_POLL_INTERVAL_MS: number;
  TX_FEE_BUMP_MULTIPLIER: number;
  TX_MAX_FEE_BUMPS: number;

  STACKS_CALL_TIMEOUT_MS: number;
  STACKS_CALL_MAX_RETRIES: number;

  COINGECKO_API_KEY: string;
  COINGECKO_BASE_URL: string;
  COINGECKO_VS_CURRENCY: string;
  COINGECKO_REFERENCE_ID: string;
  COINGECKO_PEG_ID: string;
  REFERENCE_FEED_REFRESH_MS: number;
  REFERENCE_FEED_TIMEOUT_MS: number;
  REFERENCE_FEED_MAX_AGE_MS: number;
  REFERENCE_VOL_SAMPLES: number;
  PEG_BREAK_BPS: number;

  METRICS_ENABLED: boolean;
  METRICS_HTTP_ENABLED: boolean;
  METRICS_HTTP_HOST: string;
  METRICS_HTTP_PORT: number;
  METRICS_HISTORY_SIZE: number;
  METRICS_LOG_FILE: string;
  METRICS_BASELINE_FILE: string;
  METRICS_RESET_BASELINE: boolean;

  LOG_LEVEL: string;
}

export const CONFIG: AppConfig = {
  ENVIRONMENT_TYPE: process.env.ENVIRONMENT_TYPE || 'dev',
  EXECUTION_MODE: process.env.EXECUTION_MODE === 'live' ? 'live' : 'dry_run',
  TICK_INTERVAL_MS: Math.max(1000, Number(process.env.TICK_INTERVAL_MS || 30000)),

  POOL_PROFILE,
  ENV_FILE,
  POOL_ID: process.env.POOL_ID || '',
  POOL_STRATEGY: process.env.POOL_STRATEGY || 'curve',
  SIGNER_ADDRESS: process.env.SIGNER_ADDRESS || '',
  SIGNER_KEY: process.env.SIGNER_KEY || '',

  BFF_API_BASE_URL: process.env.BFF_API_BASE_URL || 'https://bff.bitflowapis.finance/api',
  BFF_API_KEY: process.env.BFF_API_KEY || '',
  BFF_API_VERSION: process.env.BFF_API_VERSION === 'v1' ? 'v1' : 'v2',
  BFF_MAX_TIP_LAG: Math.max(0, Number(process.env.BFF_MAX_TIP_LAG || 0)),

  STACKS_NODE_URL: process.env.STACKS_NODE_URL || '',
  STACKS_NODE_KEY: process.env.STACKS_NODE_KEY || '',
  STACKS_NETWORK_VERSION: process.env.STACKS_NETWORK_VERSION || 'mainnet',

  BASE_TOKEN_CONTRACT:
    process.env.BASE_TOKEN_CONTRACT || 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',
  QUOTE_TOKEN_CONTRACT:
    process.env.QUOTE_TOKEN_CONTRACT || 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
  BASE_ASSET_NAME: 'sbtc-token',
  QUOTE_ASSET_NAME: 'usdcx-token',
  BASE_DECIMALS: 8,
  QUOTE_DECIMALS: 6,
  STX_TOKEN_CONTRACT:
    process.env.STX_TOKEN_CONTRACT || 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2',

  SWAP_ROUTER_CONTRACT:
    process.env.SWAP_ROUTER_CONTRACT ||
    'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2',
  SWAP_MAX_STEPS: Math.min(319, Math.max(1, Number(process.env.SWAP_MAX_STEPS || 50))),
  SWAP_SLIPPAGE_BPS: Math.max(0, Number(process.env.SWAP_SLIPPAGE_BPS || 100)),
  SWAP_POST_CONDITION_MODE: process.env.SWAP_POST_CONDITION_MODE === 'allow' ? 'allow' : 'deny',
  MAX_SWAP_INPUT_USTX: Math.max(0, Number(process.env.MAX_SWAP_INPUT_USTX || 0)),

  LIQUIDITY_ROUTER_CONTRACT:
    process.env.LIQUIDITY_ROUTER_CONTRACT ||
    'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-2',
  POOL_LP_ASSET_NAME: process.env.POOL_LP_ASSET_NAME || 'pool-token',
  POOL_NFT_ASSET_NAME: process.env.POOL_NFT_ASSET_NAME || 'pool-token-id',
  NFT_PC_BIN_ID_BUFFER: Math.max(0, Number(process.env.NFT_PC_BIN_ID_BUFFER || 0)),
  LIQUIDITY_SLIPPAGE_BPS: Math.max(0, Number(process.env.LIQUIDITY_SLIPPAGE_BPS || 100)),
  ACTIVE_BIN_MAX_DEVIATION: Math.max(0, Number(process.env.ACTIVE_BIN_MAX_DEVIATION || 1)),
  TX_DEADLINE_SECONDS: Math.max(1, Number(process.env.TX_DEADLINE_SECONDS || 120)),
  LIQUIDITY_POST_CONDITION_MODE:
    process.env.LIQUIDITY_POST_CONDITION_MODE === 'allow' ? 'allow' : 'deny',

  CURVE_HALF_WIDTH_BINS: Math.max(1, Number(process.env.CURVE_HALF_WIDTH_BINS || 5)),
  CURVE_DECAY: Math.min(1, Math.max(0.01, Number(process.env.CURVE_DECAY || 0.6))),
  CURVE_SIZE_FRACTION: Math.min(1, Math.max(0.01, Number(process.env.CURVE_SIZE_FRACTION || 0.6))),
  CURVE_REPOSITION_DRIFT_BINS: Math.max(1, Number(process.env.CURVE_REPOSITION_DRIFT_BINS || 3)),
  CURVE_MAX_REPOSITION_DRIFT_BINS: Math.max(
    Math.max(1, Number(process.env.CURVE_REPOSITION_DRIFT_BINS || 3)),
    Number(process.env.CURVE_MAX_REPOSITION_DRIFT_BINS || 0),
  ),
  SIGMA_REF: Math.max(0, Number(process.env.SIGMA_REF || 0.001)),
  CURVE_MAX_HALF_WIDTH_BINS: Math.max(1, Number(process.env.CURVE_MAX_HALF_WIDTH_BINS || 15)),
  CURVE_MIN_SIZE_FRACTION: Math.min(
    1,
    Math.max(0.01, Number(process.env.CURVE_MIN_SIZE_FRACTION || 0.2)),
  ),
  CURVE_BID_LEAN_MAX: Math.max(1, Number(process.env.CURVE_BID_LEAN_MAX || 1.5)),
  DIVERGENCE_WARN_BPS: Math.max(0, Number(process.env.DIVERGENCE_WARN_BPS || 80)),
  DIVERGENCE_HALT_BPS: Math.max(0, Number(process.env.DIVERGENCE_HALT_BPS || 150)),
  REFERENCE_FEED_HALT_MS: Math.max(1000, Number(process.env.REFERENCE_FEED_HALT_MS || 300000)),
  F_STAR: Math.min(1, Math.max(0, Number(process.env.F_STAR || 0.38))),
  F_SOFT: Math.min(1, Math.max(0, Number(process.env.F_SOFT || 0.44))),
  F_HARD: Math.min(1, Math.max(0, Number(process.env.F_HARD || 0.5))),
  DERISK_MAX_FRACTION: Math.min(1, Math.max(0, Number(process.env.DERISK_MAX_FRACTION || 0.4))),

  KILL_SWITCH: process.env.KILL_SWITCH === 'true',
  KILL_SWITCH_FILE: process.env.KILL_SWITCH_FILE || '',
  MAX_POSITION_USTX: Math.max(0, Number(process.env.MAX_POSITION_USTX || 0)),

  MAX_CONSECUTIVE_API_ERRORS: Math.max(0, Number(process.env.MAX_CONSECUTIVE_API_ERRORS || 5)),
  BREAKER_WITHDRAW_ALL: process.env.BREAKER_WITHDRAW_ALL === 'true',

  ENABLE_SWAP: process.env.ENABLE_SWAP !== 'false',
  ENABLE_ADD_LIQUIDITY: process.env.ENABLE_ADD_LIQUIDITY !== 'false',
  ENABLE_WITHDRAW_LIQUIDITY: process.env.ENABLE_WITHDRAW_LIQUIDITY !== 'false',

  MIN_TX_FEE_USTX: Math.max(1, Number(process.env.MIN_TX_FEE_USTX || 10000)),
  MAX_TX_FEE_USTX: Math.max(1, Number(process.env.MAX_TX_FEE_USTX || 3000000)),
  DEFAULT_TX_FEE_USTX: Math.max(1, Number(process.env.DEFAULT_TX_FEE_USTX || 60000)),
  FEE_MEMPOOL_PERCENTILE: ['p25', 'p50', 'p75', 'p95'].includes(
    process.env.FEE_MEMPOOL_PERCENTILE || '',
  )
    ? String(process.env.FEE_MEMPOOL_PERCENTILE)
    : 'p50',
  FEE_OUTLIER_MULTIPLE: Math.max(0, Number(process.env.FEE_OUTLIER_MULTIPLE || 4)),
  STX_GAS_RESERVE_USTX: Math.max(0, Number(process.env.STX_GAS_RESERVE_USTX || 5000000)),
  TX_CONFIRMATION_TIMEOUT_MS: Math.max(1000, Number(process.env.TX_CONFIRMATION_TIMEOUT_MS || 120000)),
  TX_POLL_INTERVAL_MS: Math.max(1000, Number(process.env.TX_POLL_INTERVAL_MS || 5000)),
  TX_FEE_BUMP_MULTIPLIER: Math.max(1.1, Number(process.env.TX_FEE_BUMP_MULTIPLIER || 1.5)),
  TX_MAX_FEE_BUMPS: Math.max(0, Number(process.env.TX_MAX_FEE_BUMPS || 3)),

  STACKS_CALL_TIMEOUT_MS: Number(process.env.STACKS_CALL_TIMEOUT_MS || 30000),
  STACKS_CALL_MAX_RETRIES: Number(process.env.STACKS_CALL_MAX_RETRIES || 3),

  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || '',
  COINGECKO_BASE_URL:
    process.env.COINGECKO_BASE_URL ||
    (process.env.COINGECKO_API_KEY
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3'),
  COINGECKO_VS_CURRENCY: process.env.COINGECKO_VS_CURRENCY || 'usd',
  COINGECKO_REFERENCE_ID: process.env.COINGECKO_REFERENCE_ID || '',
  COINGECKO_PEG_ID: process.env.COINGECKO_PEG_ID || '',
  REFERENCE_FEED_REFRESH_MS: Math.max(
    1000,
    Number(process.env.REFERENCE_FEED_REFRESH_MS || (process.env.COINGECKO_API_KEY ? 30000 : 60000)),
  ),
  REFERENCE_FEED_TIMEOUT_MS: Math.max(1000, Number(process.env.REFERENCE_FEED_TIMEOUT_MS || 10000)),
  REFERENCE_FEED_MAX_AGE_MS: Math.max(1000, Number(process.env.REFERENCE_FEED_MAX_AGE_MS || 90000)),
  REFERENCE_VOL_SAMPLES: Math.max(2, Number(process.env.REFERENCE_VOL_SAMPLES || 20)),
  PEG_BREAK_BPS: Math.max(0, Number(process.env.PEG_BREAK_BPS || 100)),

  METRICS_ENABLED: process.env.METRICS_ENABLED !== 'false',
  METRICS_HTTP_ENABLED: process.env.METRICS_HTTP_ENABLED !== 'false',
  METRICS_HTTP_HOST: process.env.METRICS_HTTP_HOST || '127.0.0.1',
  METRICS_HTTP_PORT: Math.max(0, Number(process.env.METRICS_HTTP_PORT || 8080)),
  METRICS_HISTORY_SIZE: Math.max(1, Number(process.env.METRICS_HISTORY_SIZE || 200)),
  METRICS_LOG_FILE:
    process.env.METRICS_LOG_FILE ||
    (POOL_PROFILE ? `data/metrics.${POOL_PROFILE}.jsonl` : 'data/metrics.jsonl'),
  METRICS_BASELINE_FILE:
    process.env.METRICS_BASELINE_FILE ||
    (POOL_PROFILE ? `data/metrics-baseline.${POOL_PROFILE}.json` : 'data/metrics-baseline.json'),
  METRICS_RESET_BASELINE: process.env.METRICS_RESET_BASELINE === 'true',

  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

export interface BffTokenMeta {
  contract_address: string;
  asset_name: string;
  decimals: number;
  symbol?: string;
}

const tokenLabel = (t: BffTokenMeta, fallback: string): string => {
  if (t.asset_name && t.asset_name !== 'unknown') return t.asset_name;
  if (t.symbol) return t.symbol.toLowerCase();
  return fallback;
};

export const hydrateTokenMetadata = (
  tokens: BffTokenMeta[],
): { summary: string; warnings: string[] } => {
  const byContract = new Map(tokens.map((t) => [t.contract_address, t]));
  const warnings: string[] = [];

  const base = byContract.get(CONFIG.BASE_TOKEN_CONTRACT);
  if (base) {
    CONFIG.BASE_ASSET_NAME = tokenLabel(base, CONFIG.BASE_ASSET_NAME);
    if (Number.isFinite(base.decimals)) CONFIG.BASE_DECIMALS = base.decimals;
  } else {
    warnings.push(
      `base token ${CONFIG.BASE_TOKEN_CONTRACT} not in BFF tokens; keeping ${CONFIG.BASE_ASSET_NAME}/${CONFIG.BASE_DECIMALS}d`,
    );
  }

  const quote = byContract.get(CONFIG.QUOTE_TOKEN_CONTRACT);
  if (quote) {
    CONFIG.QUOTE_ASSET_NAME = tokenLabel(quote, CONFIG.QUOTE_ASSET_NAME);
    if (Number.isFinite(quote.decimals)) CONFIG.QUOTE_DECIMALS = quote.decimals;
  } else {
    warnings.push(
      `quote token ${CONFIG.QUOTE_TOKEN_CONTRACT} not in BFF tokens; keeping ${CONFIG.QUOTE_ASSET_NAME}/${CONFIG.QUOTE_DECIMALS}d`,
    );
  }

  return {
    summary: `base=${CONFIG.BASE_ASSET_NAME}/${CONFIG.BASE_DECIMALS}d quote=${CONFIG.QUOTE_ASSET_NAME}/${CONFIG.QUOTE_DECIMALS}d`,
    warnings,
  };
};
