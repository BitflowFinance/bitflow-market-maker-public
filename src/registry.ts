import { coingeckoFeed } from './feeds/coingeckoFeed';
import { PriceFeed } from './feeds/priceFeed';
import { Strategy } from './strategy/strategy';
import { curve } from './strategy/curve';

// A pool's pluggable behavior: the price feed (reference + conversion) paired
// with the strategy (decision logic). One process runs one pool, selecting its
// pair by name via CONFIG.POOL_STRATEGY.
export interface PoolPlugins {
  feed: PriceFeed;
  strategy: Strategy;
}

const CURVE: PoolPlugins = { feed: coingeckoFeed, strategy: curve };

const REGISTRY: Record<string, PoolPlugins> = {
  // Geometric multi-bin curve, peaked at the active bin. Used by both
  // competition pairs (sBTC/USDCx and STX/USDCx).
  curve: CURVE,
  'sbtc-usdcx-curve': CURVE,
  'stx-usdcx-curve': CURVE,
};

export const knownPlugins = (): string[] => Object.keys(REGISTRY);

export const resolvePlugins = (name: string): PoolPlugins => {
  const plugins = REGISTRY[name];
  if (!plugins) {
    throw new Error(
      `unknown POOL_STRATEGY "${name}" (known: ${knownPlugins().join(', ') || 'none'})`,
    );
  }
  return plugins;
};
