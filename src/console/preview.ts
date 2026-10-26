import { PROFILES } from './profiles';
import { BinBar, BotRecord, LogLine, TickLike } from './model';

type Profile = (typeof PROFILES)[keyof typeof PROFILES];

interface PreviewState {
  profile: Profile;
  running: boolean;
  paused: boolean;
  tick: number;
  price: number;
  center: number;
  holdings: { walletBase: number; walletQuote: number; ownedBase: number; ownedQuote: number };
  start: number | null;
  lastTick: TickLike | null;
  history: TickLike[];
  logs: LogLine[];
  asOf: string | null;
}

const BIN_STEP: Record<string, number> = { sbtc: 0.001, stx: 0.002 };

const seed = (profile: Profile): Pick<PreviewState, 'price' | 'holdings'> =>
  profile.id === 'stx'
    ? { price: 0.62, holdings: { walletBase: 260, walletQuote: 120, ownedBase: 160, ownedQuote: 140 } }
    : { price: 98_500, holdings: { walletBase: 0.0021, walletQuote: 260, ownedBase: 0.0029, ownedQuote: 240 } };

/** Deterministic small moves so the preview looks alive without looking random. */
const drift = (tick: number, salt: number): number => {
  const a = Math.sin(tick * 0.37 + salt) * 0.0011;
  const b = Math.sin(tick * 0.11 + salt * 2) * 0.0016;
  return a + b;
};

const clock = (iso: string): string => new Date(iso).toTimeString().slice(0, 8);

export class PreviewBook {
  private bots = new Map<string, PreviewState>();

  constructor(profiles: Profile[], nowMs: number) {
    for (const profile of profiles) {
      const start = seed(profile);
      const state: PreviewState = {
        profile,
        running: true,
        paused: false,
        tick: 0,
        price: start.price,
        center: 0,
        holdings: { ...start.holdings },
        start: null,
        lastTick: null,
        history: [],
        logs: [],
        asOf: null,
      };
      this.bots.set(profile.id, state);
      // Backfill a short history so charts are not empty on first open.
      for (let i = 30; i >= 1; i -= 1) this.step(state, nowMs - i * 4000);
    }
  }

  advance(nowMs: number, intervalMs: number): void {
    for (const state of this.bots.values()) {
      if (!state.running || !state.lastTick) continue;
      const last = new Date(state.lastTick.t).getTime();
      if (nowMs - last < intervalMs) continue;
      this.step(state, nowMs);
    }
  }

  pause(id: string, nowMs: number): void {
    const state = this.require(id);
    state.paused = true;
    state.running = true;
    this.step(state, nowMs);
  }

  resume(id: string, nowMs: number): void {
    const state = this.require(id);
    state.paused = false;
    state.running = true;
    this.step(state, nowMs);
  }

  start(id: string, nowMs: number): void {
    const state = this.require(id);
    state.running = true;
    this.log(state, new Date(nowMs).toISOString(), 'info', 'Started. The preview checks again every few seconds.');
    this.step(state, nowMs);
  }

  stop(id: string): void {
    const state = this.require(id);
    state.running = false;
    this.log(state, new Date().toISOString(), 'info', 'Stopped. Fake funds stay where they were.');
  }

  record(id: string): BotRecord {
    const state = this.require(id);
    const profile = state.profile;
    const env: Record<string, string> = {
      EXECUTION_MODE: 'dry_run',
      TICK_INTERVAL_MS: '4000',
      CURVE_HALF_WIDTH_BINS: String(profile.halfWidth),
      CURVE_SIZE_FRACTION: profile.sizeFraction,
      ENABLE_SWAP: 'true',
      F_STAR: '0.38',
      F_SOFT: '0.52',
      F_HARD: '0.67',
      DIVERGENCE_HALT_BPS: profile.id === 'stx' ? '250' : '150',
      STX_GAS_RESERVE_USTX: '5000000',
      MAX_POSITION_USTX: '0',
      MAX_CONSECUTIVE_API_ERRORS: '5',
      BREAKER_WITHDRAW_ALL: 'false',
      KILL_SWITCH_FILE: '',
    };
    return {
      id: `preview-${profile.id}`,
      profile: null,
      preview: true,
      pair: profile.pair,
      poolId: profile.poolId,
      baseSymbol: profile.baseSymbol,
      quoteSymbol: profile.quoteSymbol,
      running: state.running,
      paused: state.paused,
      mode: 'dry_run',
      keySet: false,
      address: null,
      env,
      lastTick: state.lastTick,
      history: state.history.slice(),
      logs: state.logs.slice(),
      bins: this.bars(state),
      binsHavePoolDepth: true,
    };
  }

  private bars(state: PreviewState): BinBar[] {
    const active = this.activeBin(state);
    const half = state.profile.halfWidth;
    const bars: BinBar[] = [];
    for (let id = active - half - 6; id <= active + half + 6; id += 1) {
      const fromActive = Math.abs(id - active);
      const fromCenter = Math.abs(id - state.center);
      bars.push({
        id,
        // Quote-token value per bin, so the chart's tooltip reads as dollars like a real pool's.
        pool: (4 + 10 * Math.pow(0.82, fromActive) + ((id * 7) % 5) * 0.4) * 100,
        ours: fromCenter <= half ? 120 * Math.pow(0.6, fromCenter) : 0,
        active: id === active,
      });
    }
    return bars;
  }

  private activeBin(state: PreviewState): number {
    const start = seed(state.profile).price;
    return Math.round(Math.log(state.price / start) / Math.log(1 + BIN_STEP[state.profile.id]));
  }

  private require(id: string): PreviewState {
    const state = this.bots.get(id.replace(/^preview-/, ''));
    if (!state) throw new Error('No preview bot with that id.');
    return state;
  }

  private log(state: PreviewState, iso: string, level: string, text: string): void {
    state.logs.unshift({ t: clock(iso), level, text });
    state.logs = state.logs.slice(0, 80);
  }

  private step(state: PreviewState, nowMs: number): void {
    const profile = state.profile;
    state.tick += 1;
    const stamp = new Date(nowMs).toISOString();
    const held = state.holdings;
    const previous = state.lastTick;

    if (state.paused && previous) {
      const frozen: TickLike = {
        ...previous,
        t: stamp,
        tickId: state.tick,
        decision: 'frozen',
        reason: 'kill_switch',
        executed: false,
        planType: null,
        txIds: [],
        holdingsCarried: true,
        holdingsAsOf: state.asOf,
      };
      state.lastTick = frozen;
      state.history.push(frozen);
      this.log(state, stamp, 'warn', '[mm] kill switch on; skipping tick');
      this.trim(state);
      return;
    }

    state.price = state.price * (1 + drift(state.tick, profile.id === 'stx' ? 3 : 1));
    // Fees accrue slowly on the pool side so the preview shows what earning looks like.
    held.ownedQuote += profile.id === 'stx' ? 0.01 : 0.02;
    const active = this.activeBin(state);
    const driftBins = Math.abs(active - state.center);
    const value = held.walletQuote + held.ownedQuote + (held.walletBase + held.ownedBase) * state.price;
    if (state.start == null) state.start = value;
    const f = ((held.walletBase + held.ownedBase) * state.price) / value;

    let decision = 'hold';
    let planType: string | null = null;
    let reason = `in range; holding shaped position (f=${f.toFixed(3)})`;
    if (driftBins > profile.halfWidth / 2) {
      decision = 'rebalance';
      planType = 'reposition';
      reason = `reposition: active bin drifted ${driftBins} bins; rebuild curve on active bin ${active}`;
      state.center = active;
    }

    const owned: number[] = [];
    for (let id = state.center - profile.halfWidth; id <= state.center + profile.halfWidth; id += 1) owned.push(id);
    const hodl = (seed(profile).holdings.walletBase + seed(profile).holdings.ownedBase) * state.price;
    const salt = profile.id === 'stx' ? 3 : 1;
    // A small wandering gap between pool and market so the price check has something to show.
    const gapBps = Math.round(Math.abs(Math.sin(state.tick * 0.21 + salt)) * 40);
    const tick: TickLike = {
      t: stamp,
      tickId: state.tick,
      decision,
      reason,
      activeBinId: active,
      activeBinPrice: state.price,
      walletBase: held.walletBase,
      walletQuote: held.walletQuote,
      ownedBase: held.ownedBase,
      ownedQuote: held.ownedQuote,
      portfolioValue: value,
      pnlVsHodl: value - (seed(profile).holdings.walletQuote + seed(profile).holdings.ownedQuote + hodl),
      executed: false,
      planType,
      planSteps: planType ? 3 : 0,
      feesPaidStx: 0,
      walletStx: profile.baseSymbol === 'STX' ? held.walletBase : 6.4,
      signals: {
        f: Number(f.toFixed(4)),
        width: profile.halfWidth,
        size: Number(profile.sizeFraction),
        repoDrift: Math.ceil(profile.halfWidth / 2),
        sigma: 0.002,
        dBps: gapBps,
        refPrice: state.price * (1 + (Math.sin(state.tick * 0.17) >= 0 ? gapBps : -gapBps) / 10_000),
        refAgeMs: 15_000 + ((state.tick * 3700) % 40_000),
      },
      ownedBinIds: owned,
      txIds: [],
      holdingsCarried: false,
      holdingsAsOf: stamp,
    };
    state.lastTick = tick;
    state.asOf = stamp;
    state.history.push(tick);
    this.log(
      state,
      stamp,
      'info',
      decision === 'rebalance'
        ? `[mm] dry_run would send plan=reposition steps=3 (${reason})`
        : `[mm] hold reason="${reason}"`,
    );
    this.trim(state);
  }

  private trim(state: PreviewState): void {
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
  }
}
