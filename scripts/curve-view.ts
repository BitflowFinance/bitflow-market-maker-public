// Live curve-shape viewer. Fetches the pool's bins and OUR positions on-chain and
// renders, per bin around the active bin, our deployed liquidity next to the pool's
// -- so you can eyeball that we're deployed as a proper curve (heaviest at the
// active bin, decaying outward) and see how thin our slice is vs the whole pool.
//
// Both bars are normalized to their OWN series max (ours to our biggest bin, pool
// to the pool's biggest bin) so each shape is legible regardless of the ~100x
// magnitude gap; the $ label and "our%" (our share of that bin) give the real
// scale. Value is quote-denominated (USDCx ~ USD for sBTC/USDCx): value = x*price
// + y in the Y token, matching deployedPositionValue.
//
// Usage:
//   npm run curve                      # one snapshot of the configured pool
//   npm run curve -- --watch           # refresh in place (default every 30s)
//   npm run curve -- --watch --every 15
//   npm run curve -- --pad 3           # show N context bins beyond our range
//
// Picks the pool from the same env resolution as the bot, so run it with the pool
// profile:  npm run curve -- --pool sbtc   (or set ENV_FILE / --env).

import { CONFIG, hydrateTokenMetadata } from '../src/config';
import {
  PoolBin,
  fetchPoolBins,
  fetchQuotesPool,
  fetchTokens,
  fetchUserBins,
  userBinLiquidity,
} from '../src/bitflow';

const PRICE_SCALE = 1e8;

const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(name);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const watch = has('--watch');
const everyMs = Math.max(5, Number(flag('--every') || 30)) * 1000;
const pad = Math.max(0, Number(flag('--pad') || 2));
// --ours (alias --mine): show only OUR curve with a wide bar (drop the pool
// column) so the shape is easy to read. --width overrides the bar width.
const oursOnly = has('--ours') || has('--mine');
const barW = Math.max(10, Number(flag('--width') || (oursOnly ? 44 : 14)));

const toBig = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0');
  } catch {
    return BigInt(0);
  }
};

const fmtUsd = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
};

// Token-amount formatter: adapts precision to magnitude (few decimals for large
// balances, more for tiny ones like sBTC) so both base and quote read cleanly.
const fmtTok = (v: number): string => {
  if (!(v > 0)) return '·';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(6);
};

const EIGHTHS = '▏▎▍▌▋▊▉█';
// Fractional block bar (eighths) normalized to `max` over `width` cells.
const bar = (value: number, max: number, width: number, fill = '█'): string => {
  if (!(max > 0) || !(value > 0)) return ' '.repeat(width);
  const cells = Math.min(width, (value / max) * width);
  const whole = Math.floor(cells);
  const frac = cells - whole;
  let s = fill.repeat(whole);
  if (whole < width && frac > 0) {
    s += fill === '█' ? EIGHTHS[Math.min(7, Math.max(0, Math.round(frac * 8) - 1))] : fill;
  }
  return s.padEnd(width);
};

interface BinView {
  binId: number;
  offset: number;
  priceWhole: number;
  ourValueUsd: number;
  ourBase: number;
  ourQuote: number;
  poolValueUsd: number;
  sharePct: number;
  active: boolean;
}

const render = async (): Promise<void> => {
  const poolId = CONFIG.POOL_ID;
  const signer = CONFIG.SIGNER_ADDRESS;
  if (!poolId) throw new Error('POOL_ID unset (run with --pool <name> or set ENV_FILE)');

  // Hydrate token decimals/names from the BFF (as the bot does at startup) so the
  // price column and $ conversion are correct for non-6-decimal tokens like sBTC.
  try {
    hydrateTokenMetadata((await fetchTokens()).tokens);
  } catch {
    /* keep config defaults if the token registry is unreachable */
  }

  const [quotes, binsRes, userBins] = await Promise.all([
    fetchQuotesPool(poolId),
    fetchPoolBins(poolId),
    signer ? fetchUserBins(poolId, signer) : Promise.resolve([]),
  ]);

  const activeBin = Number(quotes.active_bin);
  const baseIsX = quotes.token_x === CONFIG.BASE_TOKEN_CONTRACT;
  // whole USDCx per whole sBTC = (Y-micro/X-micro) * 10^(baseDec - quoteDec).
  const priceFactor = Math.pow(10, CONFIG.BASE_DECIMALS - CONFIG.QUOTE_DECIMALS);
  const quoteUnit = Math.pow(10, CONFIG.QUOTE_DECIMALS); // micro-Y -> whole Y (~USD)
  const baseUnit = Math.pow(10, CONFIG.BASE_DECIMALS); // micro base -> whole base

  const poolById = new Map<number, PoolBin>();
  for (const pb of binsRes.bins || []) poolById.set(Number(pb.bin_id), pb);

  // Our share per bin -> our value (in Y-micro) via frac * bin reserves, plus the
  // split into whole base/quote tokens so you can see WHICH asset each bin holds
  // (bins above active are pure base = asks; below are pure quote = bids).
  const ourValueByBin = new Map<number, number>();
  const ourShareByBin = new Map<number, number>();
  const ourBaseByBin = new Map<number, number>();
  const ourQuoteByBin = new Map<number, number>();
  let ourTotalUsd = 0;
  let ourTotalBase = 0;
  let ourTotalQuote = 0;
  const ownedBinIds: number[] = [];
  for (const ub of userBins) {
    const binId = Number(ub.bin_id);
    const pb = poolById.get(binId);
    if (!pb) continue;
    const total = Number(toBig(pb.liquidity));
    const shares = Number(userBinLiquidity(ub));
    if (total <= 0 || shares <= 0) continue;
    const frac = shares / total;
    const price = Number(pb.price) / PRICE_SCALE; // Y-micro per X-micro
    const rx = Number(toBig(pb.reserve_x));
    const ry = Number(toBig(pb.reserve_y));
    const ourMicroY = frac * (rx * price + ry);
    const ourBase = (frac * (baseIsX ? rx : ry)) / baseUnit;
    const ourQuote = (frac * (baseIsX ? ry : rx)) / quoteUnit;
    ourValueByBin.set(binId, ourMicroY / quoteUnit);
    ourShareByBin.set(binId, frac * 100);
    ourBaseByBin.set(binId, ourBase);
    ourQuoteByBin.set(binId, ourQuote);
    ourTotalUsd += ourMicroY / quoteUnit;
    ourTotalBase += ourBase;
    ourTotalQuote += ourQuote;
    ownedBinIds.push(binId);
  }

  // Window: our deployed range +/- pad, else active +/- 10.
  let lo: number;
  let hi: number;
  if (ownedBinIds.length > 0) {
    lo = Math.min(...ownedBinIds) - pad;
    hi = Math.max(...ownedBinIds) + pad;
  } else {
    lo = activeBin - 10;
    hi = activeBin + 10;
  }

  let poolTvlUsd = 0;
  for (const pb of binsRes.bins || []) {
    const price = Number(pb.price) / PRICE_SCALE;
    poolTvlUsd += (Number(toBig(pb.reserve_x)) * price + Number(toBig(pb.reserve_y))) / quoteUnit;
  }

  const rows: BinView[] = [];
  for (let binId = hi; binId >= lo; binId -= 1) {
    const pb = poolById.get(binId);
    const price = pb ? (Number(pb.price) / PRICE_SCALE) * priceFactor : 0;
    const poolUsd = pb
      ? (Number(toBig(pb.reserve_x)) * (Number(pb.price) / PRICE_SCALE) + Number(toBig(pb.reserve_y))) /
        quoteUnit
      : 0;
    rows.push({
      binId,
      offset: binId - activeBin,
      priceWhole: price,
      ourValueUsd: ourValueByBin.get(binId) || 0,
      ourBase: ourBaseByBin.get(binId) || 0,
      ourQuote: ourQuoteByBin.get(binId) || 0,
      poolValueUsd: poolUsd,
      sharePct: ourShareByBin.get(binId) || 0,
      active: binId === activeBin,
    });
  }

  const ourMax = Math.max(0, ...rows.map((r) => r.ourValueUsd));
  const poolMax = Math.max(0, ...rows.map((r) => r.poolValueUsd));
  const pair = `${CONFIG.BASE_ASSET_NAME}/${CONFIG.QUOTE_ASSET_NAME}`;
  const baseSym = (CONFIG.BASE_ASSET_NAME || 'base').replace(/-token$/, '');
  const quoteSym = (CONFIG.QUOTE_ASSET_NAME || 'quote').replace(/-token$/, '');
  const AMT_W = Math.max(9, baseSym.length, quoteSym.length);

  const out: string[] = [];
  out.push(
    `── curve shape · ${poolId} · ${pair} ──────────────────────────────────`,
  );
  out.push(
    `active bin ${activeBin} · price ${activeBin && rows.find((r) => r.active) ? rows.find((r) => r.active)!.priceWhole.toFixed(2) : '?'} · ` +
      `our bins ${ownedBinIds.length} · our value ${fmtUsd(ourTotalUsd)} ` +
      `(${fmtTok(ourTotalBase)} ${baseSym} + ${fmtTok(ourTotalQuote)} ${quoteSym}) · pool TVL ${fmtUsd(poolTvlUsd)}`,
  );
  out.push('');
  const binCol = (r: BinView): string =>
    ` ${String(r.binId).padStart(4)} ${String(r.offset >= 0 ? '+' + r.offset : r.offset).padStart(3)} ${r.active ? '◄A' : '  '} ${r.priceWhole.toFixed(1).padStart(10)}`;
  const oursLbl = (r: BinView): string => (r.ourValueUsd > 0 ? fmtUsd(r.ourValueUsd) : '·').padStart(9);
  const shareLbl = (r: BinView): string => (r.sharePct > 0 ? r.sharePct.toFixed(2) + '%' : '·');
  // Per-bin base/quote amounts: shows which asset a bin holds (asks are pure base
  // above the active bin, bids pure quote below; the active bin holds both).
  const baseCol = (r: BinView): string => fmtTok(r.ourBase).padStart(AMT_W);
  const quoteCol = (r: BinView): string => fmtTok(r.ourQuote).padStart(AMT_W);
  const assetHdr = `${baseSym.padStart(AMT_W)} ${quoteSym.padStart(AMT_W)}`;

  if (oursOnly) {
    // Our curve only: wide bar normalized to OUR max, no pool column.
    out.push(` bin    Δ    price       our value  ${assetHdr}  ${'our liquidity (shape)'.padEnd(barW)} our%`);
    for (const r of rows) {
      out.push(
        `${binCol(r)}  ${oursLbl(r)}  ${baseCol(r)} ${quoteCol(r)}  ${bar(r.ourValueUsd, ourMax, barW, '█')} ${shareLbl(r)}`,
      );
    }
    out.push('');
    out.push(
      `bar normalized to our max ${fmtUsd(ourMax)}; our% = our share of that bin. ` +
        `asks (${baseSym}) sit above ◄A, bids (${quoteSym}) below.`,
    );
  } else {
    out.push(` bin    Δ    price       our value  ${assetHdr}  ${'ours'.padEnd(barW)} ${'pool'.padEnd(barW)} our%`);
    for (const r of rows) {
      out.push(
        `${binCol(r)}  ${oursLbl(r)}  ${baseCol(r)} ${quoteCol(r)}  ` +
          `${bar(r.ourValueUsd, ourMax, barW, '█')} ${bar(r.poolValueUsd, poolMax, barW, '░')} ${shareLbl(r)}`,
      );
    }
    out.push('');
    out.push(
      `bars normalized per series (ours max ${fmtUsd(ourMax)}, pool max ${fmtUsd(poolMax)}); ` +
        `our% = our share of that bin. █ ours · ░ pool. asks (${baseSym}) above ◄A, bids (${quoteSym}) below. ` +
        `add --ours for our curve only`,
    );
  }
  if (ownedBinIds.length === 0) {
    out.push('NOTE: no deployed positions found (showing pool only around the active bin).');
  }

  if (watch) process.stdout.write('\x1b[2J\x1b[H');
  console.log(out.join('\n'));
  if (watch) console.log(`\n(refreshing every ${everyMs / 1000}s — ctrl-c to stop) ${new Date().toISOString()}`);
};

const main = async (): Promise<void> => {
  await render();
  if (watch) {
    setInterval(() => {
      render().catch((err) => console.error(`[curve-view] ${(err as Error).message}`));
    }, everyMs);
  }
};

main().catch((err) => {
  console.error(`[curve-view] ${(err as Error).message}`);
  process.exit(1);
});
