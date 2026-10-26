export interface PoolProfile {
  id: string;
  pair: string;
  poolId: string;
  /**
   * Short ids older env files carry, each mapped to the pool it always named. An
   * old file keeps its pool (it may hold liquidity there) even when the default moves.
   */
  legacyPoolIds: Record<string, string>;
  strategy: string;
  /** Token contracts, used to find every pool of this pair. */
  baseContract: string;
  quoteContract: string;
  coingeckoId: string;
  /** Bin size the curve settings are tuned for. */
  binStepBps: number;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  metricsPort: number;
  halfWidth: number;
  sizeFraction: string;
  /** One line on what this pair is, shown when picking a pair. */
  blurb: string;
  suggest: { base: string; quote: string; gas: string; note: string };
}

export const PROFILES: Record<string, PoolProfile> = {
  sbtc: {
    id: 'sbtc',
    pair: 'sBTC / USDCx',
    poolId: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10',
    legacyPoolIds: { dlmm_1: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10' },
    strategy: 'sbtc-usdcx-curve',
    baseContract: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',
    quoteContract: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
    coingeckoId: 'bitcoin',
    binStepBps: 10,
    baseSymbol: 'sBTC',
    quoteSymbol: 'USDCx',
    baseDecimals: 8,
    quoteDecimals: 6,
    metricsPort: 8081,
    halfWidth: 6,
    blurb: 'Bitcoin against dollars. Earns trading fees as sBTC moves; STX in the wallet pays the network fees.',
    sizeFraction: '0.45',
    suggest: {
      base: '0.005',
      quote: '500',
      gas: '6 STX',
      note: 'Leave the STX undeployed so the bot can pay fees. These amounts let it place a curve on both sides. They are not a promise about profit.',
    },
  },
  stx: {
    id: 'stx',
    pair: 'STX / USDCx',
    poolId: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10',
    legacyPoolIds: {
      dlmm_3: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10',
      dlmm_14: 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-2-bps-10',
    },
    strategy: 'stx-usdcx-curve',
    baseContract: 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2',
    quoteContract: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
    coingeckoId: 'blockstack',
    binStepBps: 10,
    baseSymbol: 'STX',
    quoteSymbol: 'USDCx',
    baseDecimals: 6,
    quoteDecimals: 6,
    metricsPort: 8082,
    halfWidth: 13,
    blurb: 'STX against dollars. Earns trading fees as STX moves; STX is also the fee token, so no extra token is needed.',
    sizeFraction: '0.35',
    suggest: {
      base: '250',
      quote: '250',
      gas: 'The bot keeps 5 STX aside for fees.',
      note: 'On this pool STX is both the inventory and the gas. Start with more STX than the gas reserve. These amounts are not a promise about profit.',
    },
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);

export const profileById = (id: string): PoolProfile | null => PROFILES[id] || null;
