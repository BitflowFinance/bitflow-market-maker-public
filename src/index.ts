import { Server } from 'http';
import { startMetricsServer } from './api';
import { fetchTokens } from './bitflow';
import { CONFIG, hydrateTokenMetadata } from './config';
import { broadcastLiquidity, prepareAddLiquidity, prepareWithdrawLiquidity } from './liquidity';
import { logError, logInfo, logWarn } from './logger';
import { initMetrics, recordTick } from './metrics';
import { runTick } from './mm';
import { SwapSide, prepareSwap } from './swap';
import {
  assertSignerKeyMatchesAddress,
  preflight,
  signAndBroadcast,
  submitWithConfirmation,
} from './wallet';

let running = false;

const getArg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const parseMicro = (raw: string | undefined, label: string): bigint => {
  if (raw === undefined) throw new Error(`${label} is required`);
  const value = BigInt(raw);
  if (value <= BigInt(0)) throw new Error(`${label} must be greater than 0`);
  return value;
};

// Manual liquidity runner for testing add/withdraw against the router in
// isolation. Amounts are micro-units. Add defaults to the active bin; withdraw
// defaults to all owned positions at 100%.
const runManualLiquidity = async (kind: 'add' | 'withdraw'): Promise<void> => {
  if (CONFIG.EXECUTION_MODE !== 'live') {
    logWarn('[index] manual liquidity requires EXECUTION_MODE=live; aborting');
    return;
  }

  const pf = await preflight();
  const ctx = { address: pf.address, nonce: pf.nonce, fee: pf.fee };
  const binArg = getArg('--bin');
  const binId = binArg !== undefined ? Number(binArg) : undefined;

  let prepared;
  try {
    if (kind === 'add') {
      prepared = await prepareAddLiquidity({
        poolId: CONFIG.POOL_ID,
        signer: pf.address,
        binId,
        xAmount: parseMicro(getArg('--x'), '--x (token X / base amount)'),
        yAmount: parseMicro(getArg('--y'), '--y (token Y / quote amount)'),
      });
    } else {
      const pctArg = getArg('--pct');
      prepared = await prepareWithdrawLiquidity({
        poolId: CONFIG.POOL_ID,
        signer: pf.address,
        binIds: binId !== undefined ? [binId] : undefined,
        percentage: pctArg !== undefined ? Number(pctArg) : undefined,
      });
    }
  } catch (err) {
    logError(`[index] ${kind} liquidity prepare failed error="${(err as Error).message}"`);
    return;
  }

  logInfo(`[index] ${kind}_liquidity ${prepared.summary} nonce=${ctx.nonce}`);

  try {
    const res = await submitWithConfirmation(
      (fee) => broadcastLiquidity(prepared.call, { ...ctx, fee }),
      ctx.fee,
      `${kind}_liquidity nonce=${ctx.nonce}`,
    );
    logInfo(
      `[index] ${kind}_liquidity tx=${res.txId} ok=${res.ok} status="${res.status}" fee=${res.fee} rbf_bumps=${res.bumps}`,
    );
  } catch (err) {
    logError(`[index] ${kind} liquidity failed error="${(err as Error).message}"`);
  }
};

// Manual swap runner for walking the active bin in isolation. Amount is in
// micro-units of the sold token.
const runManualSwap = async (): Promise<void> => {
  if (CONFIG.EXECUTION_MODE !== 'live') {
    logWarn('[index] manual swap requires EXECUTION_MODE=live; aborting');
    return;
  }
  const sellArg = (getArg('--sell') || '').toLowerCase();
  const sell: SwapSide | null = sellArg === 'base' || sellArg === 'quote' ? sellArg : null;
  if (!sell) {
    logError('[index] --swap requires --sell base|quote');
    return;
  }

  let amountIn: bigint;
  try {
    amountIn = parseMicro(getArg('--amount'), '--amount');
  } catch (err) {
    logError(`[index] ${(err as Error).message}`);
    return;
  }
  const maxStepsArg = getArg('--max-steps');
  const minArg = getArg('--min');

  const pf = await preflight();
  const ctx = { address: pf.address, nonce: pf.nonce, fee: pf.fee };

  let prepared;
  try {
    prepared = await prepareSwap({
      poolId: CONFIG.POOL_ID,
      signer: pf.address,
      sell,
      amountIn,
      maxSteps: maxStepsArg !== undefined ? Number(maxStepsArg) : undefined,
      minReceived: minArg !== undefined ? BigInt(minArg) : undefined,
    });
  } catch (err) {
    logError(`[index] swap prepare failed error="${(err as Error).message}"`);
    return;
  }

  logInfo(`[index] swap ${prepared.summary} nonce=${ctx.nonce}`);

  try {
    const res = await submitWithConfirmation(
      (fee) => signAndBroadcast(prepared.call, { ...ctx, fee }),
      ctx.fee,
      `swap nonce=${ctx.nonce}`,
    );
    logInfo(
      `[index] swap tx=${res.txId} ok=${res.ok} status="${res.status}" fee=${res.fee} rbf_bumps=${res.bumps}`,
    );
  } catch (err) {
    logError(`[index] swap failed error="${(err as Error).message}"`);
  }
};

// Resolve SIP-010 asset names + decimals from the BFF token registry so they
// don't have to be hardcoded per pool. Env values (when pinned) win but are
// cross-checked; a mismatch (usually a typo) is logged. On BFF failure we keep
// env/defaults -- the tick's own API-error + divergence guards catch a bad state.
const hydrateTokens = async (): Promise<void> => {
  try {
    const { tokens } = await fetchTokens();
    const { summary, warnings } = hydrateTokenMetadata(tokens);
    logInfo(`[index] token_meta resolved ${summary}`);
    warnings.forEach((w) => logWarn(`[index] token_meta ${w}`));
  } catch (err) {
    logWarn(
      `[index] token_meta resolve failed error="${(err as Error).message}"; using env/defaults ` +
        `(base=${CONFIG.BASE_ASSET_NAME}/${CONFIG.BASE_DECIMALS}d quote=${CONFIG.QUOTE_ASSET_NAME}/${CONFIG.QUOTE_DECIMALS}d)`,
    );
  }
};

const safeTick = async (): Promise<void> => {
  if (running) {
    logInfo('[index] previous tick still running, skipping');
    return;
  }
  running = true;
  try {
    const result = await runTick();
    recordTick(result);
  } catch (err) {
    logError(`[index] tick failed error="${(err as Error).message}"`);
  } finally {
    running = false;
  }
};

const main = async (): Promise<void> => {
  const once = process.argv.includes('--once');

  logInfo(
    `[index] starting environment="${CONFIG.ENVIRONMENT_TYPE}" mode="${CONFIG.EXECUTION_MODE}" pool="${CONFIG.POOL_ID || 'unset'}" strategy="${CONFIG.POOL_STRATEGY}" profile="${CONFIG.POOL_PROFILE || 'default'}" env_file="${CONFIG.ENV_FILE}" signer="${CONFIG.SIGNER_ADDRESS || 'unset'}"`,
  );

  // Fail loud and early if the signing key doesn't match the configured address.
  if (CONFIG.EXECUTION_MODE === 'live') {
    assertSignerKeyMatchesAddress();
    logInfo('[index] signer key/address check passed');
  }

  // Resolve token asset names + decimals from the BFF before any action.
  await hydrateTokens();

  if (process.argv.includes('--add-liquidity')) {
    await runManualLiquidity('add');
    return;
  }
  if (process.argv.includes('--withdraw-liquidity')) {
    await runManualLiquidity('withdraw');
    return;
  }
  if (process.argv.includes('--swap')) {
    await runManualSwap();
    return;
  }

  initMetrics();

  if (once) {
    await safeTick();
    return;
  }

  const metricsServer: Server | null = startMetricsServer();

  let interval: NodeJS.Timeout | null = null;
  let parentWatch: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`[index] received ${signal}, stopping`);
    if (interval) clearInterval(interval);
    if (parentWatch) clearInterval(parentWatch);
    if (metricsServer) {
      // Drop lingering keep-alive connections so the port frees immediately
      // instead of the close() waiting on them.
      metricsServer.closeAllConnections?.();
      metricsServer.close();
    }
    // Belt-and-suspenders: if something still keeps the loop alive, force the
    // exit shortly after rather than hanging the port.
    setTimeout(() => process.exit(0), 1000).unref();
    process.exit(0);
  };
  // Register before the first (blocking) tick so Ctrl+C during startup is handled.
  // SIGHUP covers the terminal/parent closing; SIGINT/SIGTERM cover Ctrl+C and kill.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  // Ctrl+Z (SIGTSTP) would otherwise SUSPEND the bot -- leaving the metrics port
  // bound (blocking a restart with EADDRINUSE) and freezing the loop mid-tick
  // with a possibly-unconfirmed tx and a reserved nonce. Convert it to a clean
  // shutdown; suspending a live market maker is never what you want.
  process.on('SIGTSTP', () => {
    logWarn('[index] SIGTSTP (Ctrl+Z) -> shutting down cleanly instead of suspending (use Ctrl+C)');
    shutdown('SIGTSTP');
  });

  // Parent-death watchdog. npm/tsx don't reliably forward signals to the child,
  // so closing the terminal or `kill <parent-pid>` can orphan us with the metrics
  // port still bound (the annoying "find the pid and kill it" case). When our
  // parent exits we're reparented (ppid changes, e.g. to launchd/init pid 1), so
  // poll ppid and self-terminate the moment it changes.
  const initialPpid = process.ppid;
  parentWatch = setInterval(() => {
    if (process.ppid !== initialPpid) {
      shutdown(`parent-exit (ppid ${initialPpid}->${process.ppid})`);
    }
  }, 2000);
  parentWatch.unref();

  logInfo(`[index] scheduling ticks every ${CONFIG.TICK_INTERVAL_MS}ms`);
  await safeTick();
  interval = setInterval(() => {
    void safeTick();
  }, CONFIG.TICK_INTERVAL_MS);
};

main().catch((err) => {
  logError(`[index] fatal error="${(err as Error).message}"`);
  process.exit(1);
});