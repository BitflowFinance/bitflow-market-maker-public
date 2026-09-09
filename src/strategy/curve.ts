import { CONFIG } from '../config';
import { PlanStep, RebalancePlan } from '../plan';
import {
  bidFractionFromF,
  curveWeights,
  volHalfWidthBins,
  volRepositionDriftBins,
  volSizeFraction,
} from './curveShape';
import {
  Decision,
  Strategy,
  StrategyDecision,
  StrategyInput,
  StrategyLog,
  TargetBin,
  computeImbalanceBps,
} from './strategy';

// Market-follower curve strategy (sBTC/USDCx and similar major/cash pairs).
// Phase-1 MVP: center a shaped multi-bin curve on the live active bin, hold while
// it stays in range (earning fees + passively rebalancing as we're filled), and
// rebuild the curve when the active bin drifts. The external CoinGecko price is
// used ONLY for safety (divergence + feed staleness) and inventory awareness,
// never as a price we quote on.
//
// Continuous knobs on every shaped add: M2 vol scaling (width widens + size
// shrinks as realized vol rises above SIGMA_REF); M4/M6 cash skew (bidFraction
// pulls bids to 0 as f rises to F_SOFT, and leans into extra bids >1 as f falls
// below F_STAR to re-accumulate V) -- both passive/costless. M5 (hard cap)
// actively sells V->C toward F_SOFT when f breaches F_HARD and markets are
// healthy (past the halt + defensive gates). The de-risk is throttled to
// DERISK_MAX_FRACTION of V per tick (small, low-impact swaps -- f walks to F_SOFT
// over several ticks) and prefers selling free wallet base so the deployed curve
// is left in place; only when wallet base is short does it withdraw, and then the
// redeploy is decoupled to the next tick (the swap moves the active bin, so a
// same-plan re-add would abort on the active-bin tolerance). Shaped adds also
// respect the MAX_POSITION notional cap (applied in prepareShapedAddLiquidity).
export const curve: Strategy = {
  name: 'curve-market-follower',
  decide(input: StrategyInput): StrategyDecision {
    const {
      poolId,
      activeBinId,
      activeBinPrice,
      ownedBinIds,
      binBase,
      binQuote,
      walletBase,
      walletQuote,
      ownedBase,
      ownedQuote,
      reading,
    } = input;
    const logs: StrategyLog[] = [];

    const holdNoData = (reason: string, msg: string): StrategyDecision => {
      logs.push({ level: 'warn', msg });
      return {
        decision: 'no_data',
        planType: null,
        target: null,
        binOffset: null,
        reason,
        skewRebalance: false,
        meaningfulIdle: false,
        activeBinImbalanceBps: 0,
        ourSkewBps: 0,
        ourBinShareBps: 0,
        pegDriftBps: 0,
        band: null,
        logs,
      };
    };

    const ref = reading.reference;
    if (!ref || !(ref.price > 0)) return holdNoData('no_reference_price', 'no external reference price; holding');
    if (!(activeBinPrice > 0)) return holdNoData('no_active_bin_price', 'no active bin price; holding');

    // quote-micro per base-micro, matching the orientation of activeBinPrice (the
    // on-chain bin price already encodes the x/y decimal ratio).
    const decimalFactor = Math.pow(10, CONFIG.QUOTE_DECIMALS - CONFIG.BASE_DECIMALS);
    const priceMicro = ref.price * decimalFactor;

    const baseTot = walletBase + ownedBase;
    const quoteTot = walletQuote + ownedQuote;
    const activeBinImbalanceBps = computeImbalanceBps(binQuote, binBase, priceMicro);
    const ourSkewBps = computeImbalanceBps(quoteTot, baseTot, priceMicro);

    const vValue = Number(baseTot) * priceMicro;
    const cValue = Number(quoteTot);
    const f = vValue + cValue > 0 ? vValue / (vValue + cValue) : 0;
    // Cash deployment multiplier: M4 pulls bids to 0 as f rises to the soft cap;
    // M6 leans into extra bids (>1) as f falls below f*. Applied to every shaped
    // add so de-risking / re-accumulation is passive (no market-buys of V).
    const bidFraction = bidFractionFromF(f, CONFIG.F_STAR, CONFIG.F_SOFT, CONFIG.CURVE_BID_LEAN_MAX);
    // M2 vol scaling: widen + shrink size as realized vol rises above SIGMA_REF
    // (baseline at SIGMA_REF). Both fall back to the base config when sigma is 0
    // (cold feed) or scaling is disabled. Used for every shaped add this tick.
    const sigma = reading.reference?.volatility ?? 0;
    const halfWidth = volHalfWidthBins(
      CONFIG.CURVE_HALF_WIDTH_BINS,
      CONFIG.CURVE_MAX_HALF_WIDTH_BINS,
      sigma,
      CONFIG.SIGMA_REF,
    );
    const sizeFraction = volSizeFraction(
      CONFIG.CURVE_SIZE_FRACTION,
      CONFIG.CURVE_MIN_SIZE_FRACTION,
      sigma,
      CONFIG.SIGMA_REF,
    );
    // M2b (opt-in): widen the reposition drift tolerance as vol rises so we don't
    // churn repositions during spikes. Equals CURVE_REPOSITION_DRIFT_BINS (no
    // change) unless CURVE_MAX_REPOSITION_DRIFT_BINS is set higher.
    const repositionDrift = volRepositionDriftBins(
      CONFIG.CURVE_REPOSITION_DRIFT_BINS,
      CONFIG.CURVE_MAX_REPOSITION_DRIFT_BINS,
      sigma,
      CONFIG.SIGMA_REF,
    );
    const driftGateRelaxing = repositionDrift > CONFIG.CURVE_REPOSITION_DRIFT_BINS;
    const dBps = Math.round((Math.abs(activeBinPrice - priceMicro) / priceMicro) * 10000);
    const pegDriftBps = dBps;
    const target: TargetBin = { binId: activeBinId, price: activeBinPrice, driftFromPegBps: dBps };

    const mk = (over: Partial<StrategyDecision> & { decision: Decision }): StrategyDecision => ({
      planType: null,
      target,
      binOffset: 0,
      skewRebalance: false,
      meaningfulIdle: false,
      activeBinImbalanceBps,
      ourSkewBps,
      ourBinShareBps: 0,
      pegDriftBps,
      band: null,
      logs,
      signals: {
        f: Number(f.toFixed(4)),
        bidFraction: Number(bidFraction.toFixed(4)),
        width: halfWidth,
        size: Number(sizeFraction.toFixed(4)),
        repoDrift: repositionDrift,
        sigma: Number(sigma.toFixed(6)),
        dBps,
        refPrice: ref.price,
        refAgeMs: ref.ageMs,
      },
      ...over,
    });

    logs.push({
      level: 'info',
      msg:
        `ref price=${ref.price.toFixed(2)} age_ms=${ref.ageMs} vol=${(ref.volatility ?? 0).toFixed(5)} ` +
        `f=${f.toFixed(3)} (f*=${CONFIG.F_STAR} soft=${CONFIG.F_SOFT} hard=${CONFIG.F_HARD}) bid_frac=${bidFraction.toFixed(2)} ` +
        `width=${halfWidth} size=${sizeFraction.toFixed(2)} ` +
        `active_bin=${activeBinId} active_price=${activeBinPrice.toFixed(6)} ref_price_micro=${priceMicro.toFixed(6)} ` +
        `d_bps=${dBps} active_imbalance_bps=${activeBinImbalanceBps} our_skew_bps=${ourSkewBps}`,
    });

    // --- Safety gates (first match wins) ---
    // Broken market: hold inventory as-is, withdraw, no blind swap.
    if (reading.peg?.broken) {
      const reason = `peg broken deviation=${reading.peg.deviationBps}bps`;
      logs.push({ level: 'warn', msg: `HALT broken_market ${reason}` });
      return mk({ decision: 'frozen', reason, halt: { kind: 'broken_market', reason } });
    }
    if (dBps > CONFIG.DIVERGENCE_HALT_BPS) {
      const reason = `pool/external divergence ${dBps}bps > halt ${CONFIG.DIVERGENCE_HALT_BPS}bps`;
      logs.push({ level: 'warn', msg: `HALT broken_market ${reason}` });
      return mk({ decision: 'frozen', reason, halt: { kind: 'broken_market', reason } });
    }
    // Operational: feed too stale to trust -> withdraw, stop quoting.
    if (ref.ageMs > CONFIG.REFERENCE_FEED_HALT_MS) {
      const reason = `reference feed stale ${ref.ageMs}ms > halt ${CONFIG.REFERENCE_FEED_HALT_MS}ms`;
      logs.push({ level: 'warn', msg: `HALT operational ${reason}` });
      return mk({ decision: 'frozen', reason, halt: { kind: 'operational', reason } });
    }

    // --- Defensive (degrade, don't halt): hold existing liquidity, no reposition ---
    const feedStale = ref.ageMs > CONFIG.REFERENCE_FEED_MAX_AGE_MS;
    const diverging = dBps > CONFIG.DIVERGENCE_WARN_BPS;
    if (feedStale || diverging) {
      const parts = [
        feedStale ? `feed_stale ${ref.ageMs}ms` : '',
        diverging ? `divergence ${dBps}bps` : '',
      ].filter(Boolean);
      const reason = `defensive (${parts.join(', ')}); hold, no reposition`;
      logs.push({ level: 'warn', msg: `DECISION=hold ${reason}` });
      return mk({ decision: 'hold', reason });
    }

    // --- M5: hard-cap de-risk swap (V -> C) ---
    // Markets are healthy here: the broken-market / stale-feed halts and the
    // defensive tier all returned above. When our V-value fraction f breaches the
    // hard cap we sell base->quote to bring f back to f_soft. Targeting f_soft
    // (well below the f_hard trigger) leaves post-swap f far under the trigger --
    // that gap IS the spec's re-arm hysteresis, so no extra cross-tick state is
    // needed. Between the caps, M4 bid-pull (bidFraction, applied on repositions)
    // is the passive de-risk; the swap only backstops it.
    if (f >= CONFIG.F_SOFT && f < CONFIG.F_HARD) {
      logs.push({
        level: 'info',
        msg: `inventory f=${f.toFixed(3)} >= f_soft=${CONFIG.F_SOFT}; bids pulled (bid_frac=${bidFraction.toFixed(2)}); passive de-risk via asks`,
      });
    } else if (f < CONFIG.F_STAR && bidFraction > 1) {
      logs.push({
        level: 'info',
        msg: `inventory f=${f.toFixed(3)} < f*=${CONFIG.F_STAR}; cash-heavy, leaning bids (bid_frac=${bidFraction.toFixed(2)}) to re-accumulate V passively (M6)`,
      });
    }
    if (f >= CONFIG.F_HARD) {
      // base to sell to reach f_soft: s = baseTot*(1 - f_soft) - f_soft*C/priceMicro
      // (approx; ignores fee/slippage -- the swap's min-received + post-condition
      // bound the actual execution).
      const sExact =
        Number(baseTot) * (1 - CONFIG.F_SOFT) - (CONFIG.F_SOFT * cValue) / priceMicro;
      let sell = sExact > 0 ? BigInt(Math.floor(sExact)) : BigInt(0);
      // Throttle: sell at most DERISK_MAX_FRACTION of V this tick so the swap barely
      // moves a thin pool (low impact, no min-received abort, no overshoot past
      // f_soft). f converges to f_soft over several ticks instead of one giant swap.
      if (CONFIG.DERISK_MAX_FRACTION > 0) {
        const chunk = BigInt(Math.floor(Number(baseTot) * CONFIG.DERISK_MAX_FRACTION));
        if (chunk > BigInt(0) && sell > chunk) sell = chunk;
      }
      // Prefer selling free wallet base only: leaves the deployed curve in place
      // (keeps earning, and avoids both the withdraw+re-add churn and the post-swap
      // "active bin moved" add abort). Only tap deployed base when wallet can't cover.
      const sellFromWalletOnly = sell <= walletBase;
      const sellable = walletBase + (CONFIG.ENABLE_WITHDRAW_LIQUIDITY ? ownedBase : BigInt(0));
      if (sell > sellable) sell = sellable;
      const cap = BigInt(CONFIG.MAX_SWAP_INPUT_USTX);
      if (cap > BigInt(0) && sell > cap) sell = cap;
      const dust = baseTot / BigInt(100); // skip < ~1% of V; not worth the fee

      const needWithdraw = !sellFromWalletOnly && ownedBinIds.length > 0;
      const canDerisk =
        CONFIG.ENABLE_SWAP &&
        (!needWithdraw || (CONFIG.ENABLE_WITHDRAW_LIQUIDITY && CONFIG.ENABLE_ADD_LIQUIDITY));

      if (!canDerisk) {
        logs.push({
          level: 'warn',
          msg: `inventory f=${f.toFixed(3)} >= f_hard=${CONFIG.F_HARD} but de-risk not runnable (needs ENABLE_SWAP${needWithdraw ? ' + ENABLE_WITHDRAW_LIQUIDITY + ENABLE_ADD_LIQUIDITY' : ''}); holding V exposure -- monitor`,
        });
      } else if (sell > BigInt(0) && sell > dust) {
        // Decouple the redeploy from the swap. Selling wallet-only leaves the curve
        // untouched (nothing to redeploy). When we must withdraw to source base, the
        // swap moves the active bin, so we do NOT re-add in the same plan -- the next
        // tick re-reads the moved active bin and redeploys via the reposition path.
        const steps: PlanStep[] = [];
        if (needWithdraw && CONFIG.ENABLE_WITHDRAW_LIQUIDITY) {
          steps.push({
            kind: 'withdraw_liquidity',
            binIds: ownedBinIds,
            rationale: `free deployed ${CONFIG.BASE_ASSET_NAME} to de-risk (wallet base insufficient; f=${f.toFixed(3)} >= f_hard=${CONFIG.F_HARD})`,
            estimated: false,
          });
        }
        steps.push({
          kind: 'swap',
          sell: 'base',
          amountIn: sell,
          crossedBins: CONFIG.SWAP_MAX_STEPS,
          rationale: `de-risk V->C: sell ${CONFIG.BASE_ASSET_NAME} to walk f ${f.toFixed(3)} -> f_soft ${CONFIG.F_SOFT} (<=${(CONFIG.DERISK_MAX_FRACTION * 100).toFixed(0)}% of V/tick; hard cap ${CONFIG.F_HARD})`,
          estimated: true,
        });
        const notes: string[] = [];
        if (needWithdraw) {
          notes.push(
            `withdrew position to source base; curve redeploys next tick on the post-swap active bin`,
          );
        }
        const reason = needWithdraw
          ? `de-risk: f=${f.toFixed(3)} >= f_hard=${CONFIG.F_HARD}; withdraw + sell ${sell} ${CONFIG.BASE_ASSET_NAME} (base-micro), redeploy next tick`
          : `de-risk: f=${f.toFixed(3)} >= f_hard=${CONFIG.F_HARD}; sell ${sell} ${CONFIG.BASE_ASSET_NAME} (base-micro) from wallet toward f_soft=${CONFIG.F_SOFT}`;
        logs.push({ level: 'warn', msg: `DECISION=rebalance type=derisk ${reason}` });
        const plan: RebalancePlan = {
          poolId,
          type: 'reposition',
          reason,
          targetBinId: activeBinId,
          steps,
          notes,
          inventoryBlocked: false,
          inventoryRebalanceOnly: false,
        };
        return mk({ decision: 'rebalance', planType: 'reposition', reason, plan });
      } else {
        logs.push({
          level: 'warn',
          msg: `inventory f=${f.toFixed(3)} >= f_hard=${CONFIG.F_HARD} but de-risk size ${sell} base-micro is dust/zero (sellable=${sellable}); holding`,
        });
      }
    }

    // --- Reposition (follow-bin) decision ---
    let reposition = ownedBinIds.length === 0;
    let why = 'initial deploy (no liquidity)';
    if (ownedBinIds.length > 0) {
      const lo = Math.min(...ownedBinIds);
      const hi = Math.max(...ownedBinIds);
      const center = (lo + hi) / 2;
      const halfRange = Math.max(1, (hi - lo) / 2);
      const drift = Math.abs(activeBinId - center);
      const trigger = Math.max(repositionDrift, halfRange * 0.5);
      // When the vol gate is relaxing (high vol), tolerate the active bin leaving
      // our range and only recenter once drift exceeds the widened trigger -- this
      // is the churn cooldown. When the gate is off, keep the strict out-of-range
      // trip (unchanged behavior). A sustained trend still eventually forces a
      // reposition since repositionDrift is capped at CURVE_MAX_REPOSITION_DRIFT_BINS.
      if (!driftGateRelaxing && (activeBinId < lo || activeBinId > hi)) {
        reposition = true;
        why = `active bin ${activeBinId} left deployed range [${lo}..${hi}]`;
      } else if (drift > trigger) {
        reposition = true;
        why =
          `active bin ${activeBinId} drifted ${drift.toFixed(1)} bins from center ${center} (> ${trigger.toFixed(1)}` +
          `${driftGateRelaxing ? `, vol-relaxed from ${CONFIG.CURVE_REPOSITION_DRIFT_BINS} at sigma=${sigma.toFixed(5)}` : ''})`;
      }
    }

    if (!reposition) {
      logs.push({ level: 'info', msg: `DECISION=hold deployed and active bin in range (f=${f.toFixed(3)})` });
      return mk({ decision: 'hold', reason: `in range; holding shaped position (f=${f.toFixed(3)})` });
    }

    // Build the plan: vacate current bins (if any) + redeploy the curve on the
    // live active bin. Only attach the plan when we can actually add -- otherwise
    // hold (never vacate without redeploying).
    if (!CONFIG.ENABLE_ADD_LIQUIDITY) {
      logs.push({ level: 'warn', msg: `reposition wanted (${why}) but ENABLE_ADD_LIQUIDITY=false; holding` });
      return mk({ decision: 'hold', reason: `reposition wanted but add disabled; holding` });
    }

    const legs = curveWeights(halfWidth, CONFIG.CURVE_DECAY);
    const steps: PlanStep[] = [];
    const notes: string[] = [];
    if (ownedBinIds.length > 0) {
      if (CONFIG.ENABLE_WITHDRAW_LIQUIDITY) {
        steps.push({
          kind: 'withdraw_liquidity',
          binIds: ownedBinIds,
          rationale: `vacate current bins before recentering the curve on active bin ${activeBinId}`,
          estimated: false,
        });
      } else {
        notes.push(
          `withdraw disabled (ENABLE_WITHDRAW_LIQUIDITY=false): adding curve on top of existing bins [${ownedBinIds.join(',')}]`,
        );
      }
    }
    steps.push({
      kind: 'add_shaped_liquidity',
      offsets: legs.map((l) => l.offset),
      weights: legs.map((l) => l.weight),
      sizeFraction,
      bidFraction,
      rationale: `deploy ${legs.length}-bin curve (half_width=${halfWidth} decay=${CONFIG.CURVE_DECAY} size=${sizeFraction.toFixed(2)} bid_frac=${bidFraction.toFixed(2)}) centered on active bin ${activeBinId}`,
      estimated: true,
    });

    const reason = `reposition: ${why}; rebuild curve on active bin ${activeBinId}`;
    logs.push({ level: 'info', msg: `DECISION=rebalance type=reposition ${reason}` });

    const plan: RebalancePlan = {
      poolId,
      type: 'reposition',
      reason,
      targetBinId: activeBinId,
      steps,
      notes,
      inventoryBlocked: false,
      inventoryRebalanceOnly: false,
    };

    return mk({ decision: 'rebalance', planType: 'reposition', reason, plan });
  },
};
