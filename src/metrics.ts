import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config';
import { logWarn } from './logger';
import { Decision, RuntimeState, TickResult, getRuntimeState } from './mm';

const MICRO = 1_000_000; // native STX (gas/fees) is always 6-decimals
const microToNum = (v: bigint | undefined): number => (v === undefined ? 0 : Number(v) / MICRO);

// Holdings are stored in whole display units. Base and quote can carry DIFFERENT
// decimals (e.g. sBTC 8 / USDCx 6), so each side must be scaled by its own token's
// decimals -- a single hardcoded 1e6 mis-scales an 8-decimal base by 100x.
const toWhole = (v: bigint | undefined, decimals: number): number =>
  v === undefined ? 0 : Number(v) / Math.pow(10, decimals);

// Serializable, whole-token view of a single tick. Fields are neutral base/quote
// (base = quoted asset, quote = numeraire; e.g. sBTC/USDCx or STX/USDCx). bigints
// are converted to numbers here so snapshots are safe to JSON.stringify.
export interface TickSnapshot {
  t: string;
  tickId: number;
  pool: string;
  decision: Decision;
  reason?: string;
  reasonTag: string;
  activeBinId: number;
  targetBinId: number | null;
  binOffset: number | null;
  peg: number | null;
  activeBinPrice: number;
  imbalanceBps: number;
  walletQuote: number;
  walletBase: number;
  ownedQuote: number;
  ownedBase: number;
  portfolioValue: number | null;
  pnlVsHodl: number | null;
  // Gas is always native STX (6-decimals), independent of the pool's tokens.
  feesPaidStx: number;
  executed: boolean;
  planType: string | null;
  planSteps: number;
  durationSeconds: number;
  // Strategy-emitted numeric signals (curve: f, bidFraction, width, size, sigma,
  // dBps, refPrice, refAgeMs). Absent for strategies that don't emit them.
  signals?: Record<string, number>;
}

// PnL baseline = starting inventory (quote cash + base tokens) at the peg then.
interface Baseline {
  quote: number;
  base: number;
  peg: number;
  capturedAt: string;
}

const startedAt = new Date().toISOString();
let ticksRecorded = 0;
const byDecision: Record<string, number> = {};
const byHoldReason: Record<string, number> = {};
const byPlanType: Record<string, number> = {};
let executedPlans = 0;
let executedSteps = 0;
let feesPaidUstxTotal = BigInt(0);
let lastTick: TickSnapshot | null = null;
const history: TickSnapshot[] = [];
let baseline: Baseline | null = null;
let jsonlDisabled = false;

// Collapse the freeform hold/freeze reason into a low-cardinality tag so holds
// can be counted by cause without exploding the counter map.
export const classifyReason = (decision: Decision, reason?: string): string => {
  if (decision === 'rebalance') return 'rebalance';
  if (!reason) return decision;
  const r = reason.toLowerCase();
  if (r.startsWith('kill_switch')) return 'kill_switch';
  if (r.startsWith('pool_inactive')) return 'pool_inactive';
  if (r.startsWith('peg_unavailable')) return 'peg_unavailable';
  if (r.startsWith('snapshot_fetch_failed')) return 'snapshot_failed';
  if (r.startsWith('pool_id_unset')) return 'pool_id_unset';
  if (r.includes('active_bin_empty') || r.includes('no reserves')) return 'active_bin_empty';
  if (r.includes('nonce gap')) return 'nonce_gap';
  if (r.includes('pending in the mempool')) return 'pending_tx';
  if (r.includes('gas reserve') || r.includes('cover')) return 'low_gas';
  if (r.includes('parking off-active') || r.includes('unreachable without swap')) return 'off_active';
  if (r.includes('avoid churn') || r.includes('already balanced')) return 'churn';
  return 'other';
};

const loadBaseline = (): void => {
  if (!CONFIG.METRICS_BASELINE_FILE || !existsSync(CONFIG.METRICS_BASELINE_FILE)) return;
  try {
    const raw = readFileSync(CONFIG.METRICS_BASELINE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Baseline>;
    const quote = parsed.quote;
    const base = parsed.base;
    if (typeof quote === 'number' && typeof base === 'number' && typeof parsed.peg === 'number') {
      baseline = { quote, base, peg: parsed.peg, capturedAt: parsed.capturedAt ?? '' };
    }
  } catch (err) {
    logWarn(`[metrics] baseline_load_failed error="${(err as Error).message}"`);
  }
};

// Best-effort: ensure a file's parent directory exists before writing to it.
const ensureDir = (filePath: string): void => {
  const dir = dirname(filePath);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const saveBaseline = (): void => {
  if (!CONFIG.METRICS_BASELINE_FILE || !baseline) return;
  try {
    ensureDir(CONFIG.METRICS_BASELINE_FILE);
    writeFileSync(CONFIG.METRICS_BASELINE_FILE, JSON.stringify(baseline));
  } catch (err) {
    logWarn(`[metrics] baseline_save_failed error="${(err as Error).message}"`);
  }
};

const appendJsonl = (snapshot: TickSnapshot): void => {
  if (!CONFIG.METRICS_LOG_FILE || jsonlDisabled) return;
  try {
    ensureDir(CONFIG.METRICS_LOG_FILE);
    appendFileSync(CONFIG.METRICS_LOG_FILE, `${JSON.stringify(snapshot)}\n`);
  } catch (err) {
    jsonlDisabled = true;
    logWarn(
      `[metrics] jsonl_append_failed (disabling further writes) error="${(err as Error).message}"`,
    );
  }
};

// Initialize the store: load any persisted PnL baseline. Safe to call once at
// startup; a no-op if metrics are disabled.
export const initMetrics = (): void => {
  if (!CONFIG.METRICS_ENABLED) return;
  if (CONFIG.METRICS_RESET_BASELINE) {
    // Drop any persisted baseline so PnL re-captures on the first valued tick
    // (use after adding/removing capital so deposits aren't booked as PnL).
    if (CONFIG.METRICS_BASELINE_FILE && existsSync(CONFIG.METRICS_BASELINE_FILE)) {
      try {
        rmSync(CONFIG.METRICS_BASELINE_FILE);
      } catch (err) {
        logWarn(`[metrics] baseline_reset_failed error="${(err as Error).message}"`);
      }
    }
    logWarn('[metrics] baseline reset requested -- PnL re-baselines on first valued tick');
    return;
  }
  loadBaseline();
};

const inc = (map: Record<string, number>, key: string): void => {
  map[key] = (map[key] || 0) + 1;
};

// Total portfolio value in the quote numeraire (free wallet + deployed), valued
// at the current peg. null when holdings or peg are missing (degenerate tick).
const portfolioValue = (s: {
  walletQuote: number;
  walletBase: number;
  ownedQuote: number;
  ownedBase: number;
  peg: number | null;
}): number | null => {
  if (s.peg === null || s.peg <= 0) return null;
  return s.walletQuote + s.ownedQuote + (s.walletBase + s.ownedBase) * s.peg;
};

export const recordTick = (result: TickResult): void => {
  if (!CONFIG.METRICS_ENABLED) return;

  const walletQuote = toWhole(result.walletQuote, CONFIG.QUOTE_DECIMALS);
  const walletBase = toWhole(result.walletBase, CONFIG.BASE_DECIMALS);
  const ownedQuote = toWhole(result.ownedQuote, CONFIG.QUOTE_DECIMALS);
  const ownedBase = toWhole(result.ownedBase, CONFIG.BASE_DECIMALS);
  // Store peg as whole quote per whole base (e.g. USDCx per sBTC). quotePerBase is
  // carried as quote-micro/base-micro (a 10^(quote-base) factor); undo it so peg is
  // human-scaled and value = cash + base*peg is correct for unequal decimals. For
  // equal-decimal pairs the factor is 1.
  const peg =
    result.quotePerBase === null
      ? null
      : result.quotePerBase * Math.pow(10, CONFIG.BASE_DECIMALS - CONFIG.QUOTE_DECIMALS);
  const hasHoldings = result.walletQuote !== undefined;

  const value = hasHoldings
    ? portfolioValue({ walletQuote, walletBase, ownedQuote, ownedBase, peg })
    : null;

  // Capture the PnL baseline on the first tick with a real, valued portfolio.
  if (!baseline && value !== null && peg !== null && walletQuote + walletBase + ownedQuote + ownedBase > 0) {
    baseline = {
      quote: walletQuote + ownedQuote,
      base: walletBase + ownedBase,
      peg,
      capturedAt: new Date().toISOString(),
    };
    saveBaseline();
  }

  // HODL benchmark: value of the starting inventory at the current peg.
  const pnlVsHodl =
    baseline && value !== null && peg !== null
      ? value - (baseline.quote + baseline.base * peg)
      : null;

  const reasonTag = classifyReason(result.decision, result.reason);
  const snapshot: TickSnapshot = {
    t: new Date().toISOString(),
    tickId: result.tickId,
    pool: result.poolId,
    decision: result.decision,
    reason: result.reason,
    reasonTag,
    activeBinId: result.activeBinId,
    targetBinId: result.targetBinId,
    binOffset: result.binOffset,
    peg,
    activeBinPrice: result.activeBinPrice,
    imbalanceBps: result.imbalanceBps,
    walletQuote,
    walletBase,
    ownedQuote,
    ownedBase,
    portfolioValue: value,
    pnlVsHodl,
    feesPaidStx: microToNum(result.feesPaidUstx),
    executed: result.executed,
    planType: result.plan ? result.plan.type : null,
    planSteps: result.plan ? result.plan.steps.length : 0,
    durationSeconds: result.durationSeconds,
    signals: result.signals,
  };

  ticksRecorded += 1;
  inc(byDecision, result.decision);
  if (result.decision === 'hold' || result.decision === 'frozen' || result.decision === 'no_data') {
    inc(byHoldReason, reasonTag);
  }
  if (result.executed && result.plan) {
    executedPlans += 1;
    executedSteps += result.plan.steps.length;
    inc(byPlanType, result.plan.type);
  }
  feesPaidUstxTotal += result.feesPaidUstx ?? BigInt(0);

  lastTick = snapshot;
  history.push(snapshot);
  while (history.length > CONFIG.METRICS_HISTORY_SIZE) history.shift();

  appendJsonl(snapshot);
};

const uptimeSeconds = (): number => Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);

export const getHealth = (): Record<string, unknown> => {
  const runtime: RuntimeState = getRuntimeState();
  return {
    status: runtime.killSwitch || runtime.breakerTripped ? 'frozen' : 'ok',
    mode: CONFIG.EXECUTION_MODE,
    pool: CONFIG.POOL_ID,
    startedAt,
    uptimeSeconds: uptimeSeconds(),
    ticksRecorded,
    lastTickAt: lastTick ? lastTick.t : null,
    lastDecision: lastTick ? lastTick.decision : null,
    runtime,
  };
};

export const getStatus = (): Record<string, unknown> => ({
  startedAt,
  uptimeSeconds: uptimeSeconds(),
  runtime: getRuntimeState(),
  lastTick,
});

export const getMetrics = (): Record<string, unknown> => ({
  startedAt,
  uptimeSeconds: uptimeSeconds(),
  ticksRecorded,
  byDecision,
  byHoldReason,
  byPlanType,
  executedPlans,
  executedSteps,
  feesPaidStx: Number(feesPaidUstxTotal) / MICRO,
  baseline,
  portfolioValue: lastTick ? lastTick.portfolioValue : null,
  pnlVsHodl: lastTick ? lastTick.pnlVsHodl : null,
  peg: lastTick ? lastTick.peg : null,
  lastTickAt: lastTick ? lastTick.t : null,
});

export const getHistory = (n: number): TickSnapshot[] => {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : history.length;
  return history.slice(-count);
};
