import { describe, expect, it } from 'vitest';
import { createCoingeckoFeed, realizedVolatility, ReferenceQuote } from '../src/feeds/coingeckoFeed';

describe('realizedVolatility', () => {
  it('is 0 with too few samples', () => {
    expect(realizedVolatility([])).toBe(0);
    expect(realizedVolatility([100])).toBe(0);
    expect(realizedVolatility([100, 101])).toBe(0);
  });

  it('is 0 for a flat series and positive for a moving one', () => {
    expect(realizedVolatility([100, 100, 100, 100])).toBe(0);
    expect(realizedVolatility([100, 110, 100, 120, 90])).toBeGreaterThan(0);
  });
});

// Deterministic clock + fetcher so the feed is exercised without network.
const makeFeed = (
  quotes: ReferenceQuote[],
  opts?: { refreshMs?: number; failAfter?: number; pegBreakBps?: number },
) => {
  let clock = 0;
  let i = 0;
  let calls = 0;
  const feed = createCoingeckoFeed({
    referenceId: 'bitcoin',
    pegId: 'sbtc',
    refreshMs: opts?.refreshMs ?? 60000,
    volSamples: 20,
    pegBreakBps: opts?.pegBreakBps ?? 100,
    now: () => clock,
    fetchQuote: async () => {
      calls += 1;
      if (opts?.failAfter !== undefined && calls > opts.failAfter) {
        throw new Error('rate limited');
      }
      const q = quotes[Math.min(i, quotes.length - 1)];
      i += 1;
      return q;
    },
  });
  return {
    feed,
    advance: (ms: number) => {
      clock += ms;
    },
    calls: () => calls,
  };
};

describe('coingeckoFeed caching + reading', () => {
  it('reuses the cached price between refreshes (no extra fetches)', async () => {
    const h = makeFeed([{ reference: 60000 }], { refreshMs: 60000 });
    const a = await h.feed.read();
    expect(a.reference?.price).toBe(60000);
    expect(a.reference?.ageMs).toBe(0);
    expect(a.conversion.kind).toBe('swap_only');

    h.advance(10000);
    const b = await h.feed.read();
    expect(h.calls()).toBe(1); // still within the refresh window -> reused
    expect(b.reference?.ageMs).toBe(10000);
  });

  it('refetches once the refresh interval elapses', async () => {
    const h = makeFeed([{ reference: 60000 }, { reference: 61000 }], { refreshMs: 60000 });
    await h.feed.read();
    h.advance(60000);
    const b = await h.feed.read();
    expect(h.calls()).toBe(2);
    expect(b.reference?.price).toBe(61000);
    expect(b.reference?.ageMs).toBe(0);
  });

  it('degrades to the stale cached price when a refresh fails', async () => {
    const h = makeFeed([{ reference: 60000 }], { refreshMs: 60000, failAfter: 1 });
    await h.feed.read();
    h.advance(60000);
    const b = await h.feed.read();
    expect(b.reference?.price).toBe(60000);
    expect(b.reference?.ageMs).toBe(60000); // stale, surfaced via ageMs
  });

  it('rejects on a cold cache when the first fetch fails', async () => {
    const h = makeFeed([{ reference: 60000 }], { failAfter: 0 });
    await expect(h.feed.read()).rejects.toThrow(/coingecko reference unavailable/);
  });

  it('flags a broken peg past the band and clears it inside', async () => {
    const broken = makeFeed([{ reference: 60000, peg: 59000 }], { pegBreakBps: 100 });
    const r1 = await broken.feed.read();
    expect(r1.peg?.broken).toBe(true);
    expect(r1.peg?.deviationBps).toBe(167);

    const ok = makeFeed([{ reference: 60000, peg: 60030 }], { pegBreakBps: 100 });
    const r2 = await ok.feed.read();
    expect(r2.peg?.broken).toBe(false);
    expect(r2.peg?.deviationBps).toBe(5);
  });

  it('omits peg when the feed returns no peg price', async () => {
    const h = makeFeed([{ reference: 60000 }]);
    const r = await h.feed.read();
    expect(r.peg).toBeUndefined();
  });
});
