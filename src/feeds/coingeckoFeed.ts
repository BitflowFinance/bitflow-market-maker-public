import { CONFIG } from '../config';
import { swapOnly } from '../conversion';
import { MarketReading, PegStatus, PriceFeed } from './priceFeed';

// External reference price for a market-follower pool (sBTC/USDCx or STX/USDCx),
// sourced from CoinGecko. This is NOT the price the bot quotes on -- it's
// context for volatility + safety only. The price is cached and reused between
// refreshes so we never poll faster than the feed's own cadence (and never
// hammer the free tier into a rate-limit).

export interface ReferenceQuote {
  // V/USD reference (in the bin ladder's quote-per-base orientation, e.g. USD per
  // BTC for sBTC/USDCx).
  reference: number;
  // Optional market price of the wrapped asset itself (same units) for a
  // V-vs-underlying peg check; absent when not monitored.
  peg?: number;
}

// Realized volatility = sample standard deviation of consecutive log returns over
// the window. Unitless (per sample interval); the strategy scales it against its
// own sigma_ref. Returns 0 until there are enough samples to be meaningful.
export const realizedVolatility = (prices: number[]): number => {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev > 0 && cur > 0) returns.push(Math.log(cur / prev));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
};

export interface CoingeckoFeedOptions {
  referenceId: string;
  pegId?: string;
  refreshMs: number;
  volSamples: number;
  pegBreakBps: number;
  // Injectable for tests; default to wall clock / real HTTP.
  now?: () => number;
  fetchQuote?: () => Promise<ReferenceQuote>;
}

const httpFetchQuote = async (referenceId: string, pegId?: string): Promise<ReferenceQuote> => {
  if (!referenceId) throw new Error('COINGECKO_REFERENCE_ID not set');
  const vs = CONFIG.COINGECKO_VS_CURRENCY;
  const ids = pegId ? `${referenceId},${pegId}` : referenceId;
  const url = `${CONFIG.COINGECKO_BASE_URL}/simple/price?ids=${encodeURIComponent(
    ids,
  )}&vs_currencies=${encodeURIComponent(vs)}`;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (CONFIG.COINGECKO_API_KEY) {
    const headerName = CONFIG.COINGECKO_BASE_URL.includes('pro-api')
      ? 'x-cg-pro-api-key'
      : 'x-cg-demo-api-key';
    headers[headerName] = CONFIG.COINGECKO_API_KEY;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.REFERENCE_FEED_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`coingecko ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as Record<string, Record<string, number>>;
  const reference = json?.[referenceId]?.[vs];
  if (typeof reference !== 'number' || !(reference > 0)) {
    throw new Error(`coingecko returned no ${vs} price for "${referenceId}"`);
  }
  const pegPrice = pegId ? json?.[pegId]?.[vs] : undefined;
  return { reference, peg: typeof pegPrice === 'number' ? pegPrice : undefined };
};

export const createCoingeckoFeed = (opts: CoingeckoFeedOptions): PriceFeed => {
  const now = opts.now ?? ((): number => Date.now());
  const fetchQuote = opts.fetchQuote ?? ((): Promise<ReferenceQuote> => httpFetchQuote(opts.referenceId, opts.pegId));

  let cache: { quote: ReferenceQuote; at: number } | null = null;
  const samples: number[] = [];

  return {
    name: 'coingecko',
    async read(): Promise<MarketReading> {
      const t = now();
      // Refresh only when the cached quote is older than the floor; otherwise
      // reuse it. This both honors the feed's natural cadence and protects the
      // free tier (no key) from rate limits.
      if (!cache || t - cache.at >= opts.refreshMs) {
        try {
          const quote = await fetchQuote();
          cache = { quote, at: t };
          samples.push(quote.reference);
          if (samples.length > opts.volSamples) samples.shift();
        } catch (err) {
          // Degrade, don't freeze: keep serving the last good price (its growing
          // ageMs lets the strategy go defensive / halt). Only a cold cache with
          // no price at all is fatal.
          if (!cache) {
            throw new Error(`coingecko reference unavailable: ${(err as Error).message}`);
          }
        }
      }

      const ageMs = t - cache.at;
      const reference = {
        price: cache.quote.reference,
        ageMs,
        volatility: realizedVolatility(samples),
      };

      let peg: PegStatus | undefined;
      if (cache.quote.peg !== undefined && cache.quote.reference > 0) {
        const deviationBps = Math.round(
          (Math.abs(cache.quote.peg - cache.quote.reference) / cache.quote.reference) * 10000,
        );
        peg = { deviationBps, broken: deviationBps > opts.pegBreakBps };
      }

      return { reference, peg, conversion: swapOnly };
    },
  };
};

// Default instance wired from config; used by market-follower pools via the
// registry. Reads nothing until the first read() (so importing it is cheap).
export const coingeckoFeed: PriceFeed = createCoingeckoFeed({
  referenceId: CONFIG.COINGECKO_REFERENCE_ID,
  pegId: CONFIG.COINGECKO_PEG_ID || undefined,
  refreshMs: CONFIG.REFERENCE_FEED_REFRESH_MS,
  volSamples: CONFIG.REFERENCE_VOL_SAMPLES,
  pegBreakBps: CONFIG.PEG_BREAK_BPS,
});
