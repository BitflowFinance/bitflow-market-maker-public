// Rolling gain/loss monitor for a running pool. Reads the metrics JSONL and prints
// a compact dashboard: current value + PnL, the rolling-window (default 24h) bleed
// rate vs HODL (price-neutral) and nominal, a fees+edge vs LVR attribution of that
// PnL, activity (repositions / de-risks / executed txs), the inventory-fraction f
// distribution across its regimes, gas spent, and the reference-price move over the
// window. Use --watch to refresh in place.
//
// The attribution splits "vs hodl" into fees+edge (fee income + execution edge)
// minus LVR (inventory-drift cost vs holding) so you can see WHICH one dominates a
// given loss -- both computed from the recorded q/p/V series (no on-chain calls).
//
// Value is quote-denominated (e.g. USDCx ~ USD for the USDCx pools). "vs HODL"
// strips the base asset's reference-price move, so it's the true cost of running the
// bot; "nominal" is the raw portfolio change (includes that price move).
//
// Usage:
//   npm run watch                       # data/metrics.sbtc.jsonl, 24h window
//   npm run watch -- --pool stx         # data/metrics.<pool>.jsonl
//   npm run watch -- --hours 6          # different rolling window
//   npm run watch -- --watch            # refresh every 60s in place
//   npm run watch -- --daily            # per-day P&L, sliding 24h back from now
//   npm run watch -- --daily --calendar # per-day P&L, fixed UTC calendar days
//   npm run watch -- --daily --days 5   # limit the daily table to N days
//   npm run watch -- data/metrics.jsonl --hours 12 --watch --every 30
//
// Dependency-free (node builtins only) so it runs without a build step.

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);

const pool = flag('--pool');
const file =
  args.find((a, i) => !a.startsWith('--') && args[i - 1]?.startsWith('--') !== true) ||
  (pool ? `data/metrics.${pool}.jsonl` : 'data/metrics.sbtc.jsonl');
const hours = flag('--hours') ? Math.max(0.1, Number(flag('--hours'))) : 24;
const watch = has('--watch');
const everyMs = Math.max(5, Number(flag('--every') || 60)) * 1000;
const daily = has('--daily');
const days = Math.max(1, Number(flag('--days') || 7));
// --calendar: fixed UTC midnight-to-midnight days (stable across runs) instead of
// the default sliding 24h windows counted back from the latest tick.
const calendar = has('--calendar');

// f regime thresholds (defaults; only used for the distribution buckets).
const F_STAR = Number(flag('--fstar') || 0.38);
const F_SOFT = Number(flag('--fsoft') || 0.6);
const F_HARD = Number(flag('--fhard') || 0.7);

interface Row {
  t: string;
  tickId?: number;
  decision?: string;
  reason?: string;
  planType?: string | null;
  executed?: boolean;
  peg?: number | null;
  walletQuote?: number;
  walletBase?: number;
  ownedQuote?: number;
  ownedBase?: number;
  portfolioValue?: number | null;
  pnlVsHodl?: number | null;
  // Gas is always native STX, separate from pool inventory.
  feesPaidStx?: number;
  signals?: Record<string, number>;
}


const parse = (path: string): Row[] => {
  const raw = readFileSync(path, 'utf8');
  const rows: Row[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s) as Row);
    } catch {
      // skip malformed
    }
  }
  return rows;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const usd = (n: number): string => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const pad = (s: string, n: number): string => s.padEnd(n);

// Total base (q) and cash (c) holdings for a tick (wallet + deployed).
const qOf = (r: Row): number => (num(r.walletBase) ?? 0) + (num(r.ownedBase) ?? 0);
const cOf = (r: Row): number => (num(r.walletQuote) ?? 0) + (num(r.ownedQuote) ?? 0);
const pvOf = (r: Row): number | null => num(r.portfolioValue);
const pnlOf = (r: Row): number | null => num(r.pnlVsHodl);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// fees+edge vs LVR attribution over a set of rows, resampled to hourly medians
// (robust to the transient per-tick valuation spikes during reposition churn).
//   lvr     = sum (q0 - q_prev) * dp   -- inventory-drift cost vs holding q0
//   feeEdge = sum (dc + p * dq)        -- fee income + swap slippage/execution edge
// Identity: vs hodl = feeEdge - lvr (q0 = inception baseline).
const attribution = (
  rows: Row[],
  q0: number,
): {
  feeEdge: number;
  lvr: number;
  points: number;
  per: Array<{ h: string; feeEdge: number; lvr: number }>;
} => {
  const byHour = new Map<string, Row[]>();
  for (const r of rows) {
    if (num(r.peg) === null) continue;
    const h = r.t.slice(0, 13); // yyyy-mm-ddThh
    const b = byHour.get(h);
    if (b) b.push(r);
    else byHour.set(h, [r]);
  }
  const pts = Array.from(byHour.keys())
    .sort()
    .map((h) => {
      const b = byHour.get(h) as Row[];
      return {
        h,
        q: median(b.map(qOf)),
        c: median(b.map(cOf)),
        p: median(b.map((r) => num(r.peg) as number)),
      };
    });
  let lvr = 0;
  let feeEdge = 0;
  const per: Array<{ h: string; feeEdge: number; lvr: number }> = [];
  for (let i = 1; i < pts.length; i += 1) {
    const dp = pts[i].p - pts[i - 1].p;
    const l = (q0 - pts[i - 1].q) * dp;
    const fe = pts[i].c - pts[i - 1].c + pts[i].p * (pts[i].q - pts[i - 1].q);
    lvr += l;
    feeEdge += fe;
    per.push({ h: pts[i].h, feeEdge: fe, lvr: l });
  }
  return { feeEdge, lvr, points: pts.length, per };
};

// Inception baseline (starting inventory) the bot persists next to the metrics
// file (data/metrics.<profile>.jsonl -> data/metrics-baseline.<profile>.json).
// q0/c0 are the base/quote amounts the bot's pnlVsHodl is measured against, so
// using them makes the attribution reconcile exactly with pnl vs hodl.
const loadBaseline = (metricsFile: string): { q0: number; c0: number } | null => {
  const path = metricsFile.replace(
    /metrics(\.[^./]+)?\.jsonl$/,
    (_m, prof) => `metrics-baseline${prof || ''}.json`,
  );
  try {
    const b = JSON.parse(readFileSync(path, 'utf8'));
    const q0 = b.base;
    const c0 = b.quote;
    if (typeof q0 === 'number' && typeof c0 === 'number') return { q0, c0 };
  } catch {
    // no baseline
  }
  return null;
};

const render = (): void => {
  let rows: Row[];
  try {
    rows = parse(file);
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    process.exit(1);
  }
  const valued = rows.filter((r) => pvOf(r) !== null);
  if (valued.length === 0) {
    console.error(`no valued ticks in ${file}`);
    process.exit(1);
  }

  const last = valued[valued.length - 1];
  const nowMs = new Date(last.t).getTime();
  const cutoff = nowMs - hours * 3_600_000;
  const win = valued.filter((r) => new Date(r.t).getTime() >= cutoff);
  const wFirst = win[0];
  const spanH = (nowMs - new Date(wFirst.t).getTime()) / 3_600_000 || hours;

  const vNow = pvOf(last) as number;
  const vThen = pvOf(wFirst) as number;
  const nominal = vNow - vThen;

  const pNow = pnlOf(last);
  const pThen = pnlOf(wFirst);
  const vsHodl = pNow !== null && pThen !== null ? pNow - pThen : null;

  // fees+edge vs LVR attribution (hourly-median resampled; see attribution()).
  const bl = loadBaseline(file);
  const winPath = win.filter((r) => num(r.peg) !== null);
  const q0 = bl ? bl.q0 : winPath.length ? qOf(winPath[0]) : 0;
  const { feeEdge, lvr, points, per } = attribution(win, q0);
  const attribOk = points >= 3 && vsHodl !== null;
  // Residual between the resampled decomposition and the recorded vs-hodl delta
  // (median resampling error; a large value flags a mid-window capital change).
  const attribResidual = attribOk ? feeEdge - lvr - (vsHodl as number) : 0;

  // Activity in window (executed txs, split by kind via reason).
  const execRows = win.filter((r) => r.executed);
  const derisks = execRows.filter((r) => /de-?risk/i.test(r.reason || '')).length;
  const repos = execRows.filter(
    (r) => r.planType === 'reposition' && !/de-?risk/i.test(r.reason || ''),
  ).length;
  const frozen = win.filter((r) => r.decision === 'frozen').length;

  // Gas over window (feesPaidStx is per-tick).
  const gas = win.reduce((s, r) => s + (num(r.feesPaidStx) || 0), 0);

  // f distribution + regime time-share.
  const fs = win.map((r) => num(r.signals?.f)).filter((v): v is number => v !== null);
  const fStat = fs.length
    ? {
        min: Math.min(...fs),
        max: Math.max(...fs),
        mean: fs.reduce((a, b) => a + b, 0) / fs.length,
        last: fs[fs.length - 1],
      }
    : null;
  const bucket = (lo: number, hi: number): number =>
    fs.length ? (100 * fs.filter((f) => f >= lo && f < hi).length) / fs.length : 0;

  // Reference-price move over the window (base asset's external price).
  const rp = win.map((r) => num(r.signals?.refPrice)).filter((v): v is number => v !== null);
  const refThen = rp[0];
  const refNow = rp[rp.length - 1];
  const refPct = refThen ? ((refNow - refThen) / refThen) * 100 : null;
  // Adaptive precision so sub-dollar prices (e.g. STX ~$0.17) don't round to $0.
  const px = (v: number | undefined): string =>
    v === undefined ? '?' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4);

  const out: string[] = [];
  if (watch) out.push('\x1b[2J\x1b[H'); // clear screen
  out.push(`── pnl-watch  ${file}  @ ${last.t} ──`);
  out.push(`window: last ${spanH.toFixed(1)}h (${win.length} ticks)`);
  out.push('');
  out.push(`${pad('portfolio value', 22)} $${vNow.toFixed(2)}  (quote / ~USD)`);
  if (pNow !== null) out.push(`${pad('pnl vs hodl (all)', 22)} ${usd(pNow)}`);
  out.push('');
  out.push(`── rolling ${spanH.toFixed(0)}h ──`);
  out.push(`${pad('nominal change', 22)} ${usd(nominal)}   (${usd(nominal / spanH)}/h, ${usd((nominal / spanH) * 24)}/day)`);
  if (vsHodl !== null)
    out.push(`${pad('vs hodl (bot cost)', 22)} ${usd(vsHodl)}   (${usd(vsHodl / spanH)}/h, ${usd((vsHodl / spanH) * 24)}/day)`);
  if (refPct !== null)
    out.push(`${pad('ref price move', 22)} ${refPct >= 0 ? '+' : ''}${refPct.toFixed(2)}%  ($${px(refThen)} -> $${px(refNow)})`);
  out.push(`${pad('gas spent', 22)} ${gas.toFixed(4)} STX`);
  out.push('');
  if (attribOk) {
    out.push(`── attribution (${spanH.toFixed(0)}h, hourly)  [vs hodl = fees+edge − lvr] ──`);
    out.push(`${pad('fees + edge', 22)} ${usd(feeEdge)}   (+ = fee income & execution edge)`);
    out.push(`${pad('lvr', 22)} ${usd(-lvr)}   (− = inventory drift cost vs holding)`);
    out.push(`${pad('= vs hodl (est)', 22)} ${usd(feeEdge - lvr)}   (recorded ${usd(vsHodl as number)})`);
    if (!bl) out.push(`${pad('', 22)} (no baseline file; q0 approximated from window start)`);
    if (Math.abs(attribResidual) > Math.max(5, 0.1 * Math.abs(vsHodl as number)))
      out.push(`${pad('', 22)} warn: residual ${usd(attribResidual)} -- possible mid-window deposit/withdraw`);
    out.push('');
  } else if (vsHodl !== null) {
    out.push(`── attribution ──  (need >=3 hourly points; widen --hours)`);
    out.push('');
  }
  out.push(`── activity (${spanH.toFixed(0)}h) ──`);
  out.push(`${pad('repositions', 22)} ${repos}   (${(repos / spanH * 24).toFixed(1)}/day)`);
  out.push(`${pad('de-risk swaps', 22)} ${derisks}`);
  out.push(`${pad('executed txs', 22)} ${execRows.length}   frozen ticks: ${frozen}`);
  out.push('');

  // Cost of churn: is repositioning paying for itself? Classify each hourly point
  // by whether a reposition executed in that hour, then compare the vs-hodl rate
  // of reposition-hours against quiet-hours and show the gas each side burned.
  if (attribOk && repos > 0) {
    const reposByHour = new Map<string, number>();
    const gasByHour = new Map<string, number>();
    for (const r of win) {
      const h = r.t.slice(0, 13);
      if (r.executed && r.planType === 'reposition' && !/de-?risk/i.test(r.reason || ''))
        reposByHour.set(h, (reposByHour.get(h) || 0) + 1);
      gasByHour.set(h, (gasByHour.get(h) || 0) + (num(r.feesPaidStx) || 0));
    }
    const act = { h: 0, vs: 0, gas: 0 };
    const qui = { h: 0, vs: 0, gas: 0 };
    for (const p of per) {
      const bucket = (reposByHour.get(p.h) || 0) > 0 ? act : qui;
      bucket.h += 1;
      bucket.vs += p.feeEdge - p.lvr;
      bucket.gas += gasByHour.get(p.h) || 0;
    }
    const rate = (b: { h: number; vs: number }): string =>
      b.h ? `${usd(b.vs / b.h)}/h` : '—';
    out.push(`── cost of churn ──`);
    out.push(`${pad('gas / reposition', 22)} ${(gas / repos).toFixed(3)} STX   (${gas.toFixed(2)} STX total)`);
    out.push(`${pad('reposition-hours', 22)} ${act.h}h  ${rate(act)}   gas ${act.gas.toFixed(2)} STX`);
    out.push(`${pad('quiet-hours', 22)} ${qui.h}h  ${rate(qui)}   gas ${qui.gas.toFixed(2)} STX`);
    const verdict =
      act.h && qui.h
        ? act.vs / act.h >= qui.vs / qui.h
          ? 'repositioning earns its keep (active hrs >= quiet hrs)'
          : 'repositioning is a drag (active hrs < quiet hrs) — consider widening drift band'
        : 'not enough of both hour-types to compare';
    out.push(`${pad('verdict', 22)} ${verdict}`);
    out.push('');
  }
  if (fStat) {
    out.push(`── inventory f (base-asset value share) ──`);
    out.push(`${pad('min / mean / max', 22)} ${fStat.min.toFixed(2)} / ${fStat.mean.toFixed(2)} / ${fStat.max.toFixed(2)}   now ${fStat.last.toFixed(2)}`);
    out.push(
      `${pad('time in regime', 22)} ` +
        `<f* ${bucket(0, F_STAR).toFixed(0)}%  ` +
        `f*..soft ${bucket(F_STAR, F_SOFT).toFixed(0)}%  ` +
        `soft..hard ${bucket(F_SOFT, F_HARD).toFixed(0)}%  ` +
        `>=hard ${bucket(F_HARD, 1.01).toFixed(0)}%`,
    );
  }
  console.log(out.join('\n'));
};

// Non-overlapping per-day (24h) blocks, newest first. Un-overlaps the rolling
// windows so each row is an independent day; flags any block containing a
// deposit/withdraw (large attribution residual) since its numbers are unreliable.
const renderDaily = (): void => {
  let rows: Row[];
  try {
    rows = parse(file);
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    process.exit(1);
  }
  const valued = rows.filter((r) => pvOf(r) !== null);
  if (valued.length === 0) {
    console.error(`no valued ticks in ${file}`);
    process.exit(1);
  }
  const bl = loadBaseline(file);
  const lastRow = valued[valued.length - 1];
  const nowMs = new Date(lastRow.t).getTime();
  const tMs = (r: Row): number => new Date(r.t).getTime();
  const valNow = pvOf(lastRow);
  const pnlAll = pnlOf(lastRow);

  // Sliding mode counts 24h windows back from the latest tick, so block labels
  // (0-24h, ...) map to different calendar days each run. Calendar mode anchors to
  // UTC midnight so each dated row stays put across runs (only today updates).
  const utcMidnight = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const todayStart = utcMidnight(nowMs);
  const DAY_MS = 24 * 3_600_000;

  console.log(
    `── daily P&L (${calendar ? 'fixed UTC calendar days' : 'non-overlapping 24h blocks'})  ${file} ──`,
  );
  console.log(`now: ${lastRow.t}`);
  if (valNow !== null) console.log(`portfolio value: $${valNow.toFixed(2)}`);
  if (pnlAll !== null)
    console.log(`pnl vs hodl (ALL-TIME): ${usd(pnlAll)}   <- this is your total; the per-day rows below are just the recent slices`);
  console.log();
  console.log(
    `${pad(calendar ? 'day (UTC)' : 'block', 9)} ${'vs hodl'.padStart(9)} ${'nominal'.padStart(9)} ${'ref%'.padStart(7)} ` +
      `${'fees+edge'.padStart(10)} ${'lvr'.padStart(9)} ${'repos'.padStart(6)} ${'de-risk'.padStart(7)}  curve`,
  );
  let cumVsHodl = 0;
  for (let k = 0; k < days; k += 1) {
    // Calendar: [UTC midnight of the day k days ago, +24h) (today's row capped at
    // now). Sliding: a 24h window ending k*24h before the latest tick.
    const hi = calendar ? Math.min(nowMs, todayStart - (k - 1) * DAY_MS) : nowMs - k * DAY_MS;
    const lo = calendar ? todayStart - k * DAY_MS : nowMs - (k + 1) * DAY_MS;
    const blk = valued.filter((r) => tMs(r) > lo && tMs(r) <= hi);
    if (blk.length < 2) continue;
    const withPnl = blk.filter((r) => pnlOf(r) !== null);
    const vsHodl =
      withPnl.length >= 2
        ? (pnlOf(withPnl[withPnl.length - 1]) as number) - (pnlOf(withPnl[0]) as number)
        : null;
    const nominal = (pvOf(blk[blk.length - 1]) as number) - (pvOf(blk[0]) as number);
    const rp = blk.map((r) => num(r.signals?.refPrice)).filter((v): v is number => v !== null);
    const btcPct = rp.length >= 2 && rp[0] ? ((rp[rp.length - 1] - rp[0]) / rp[0]) * 100 : null;
    const q0 = bl ? bl.q0 : qOf(blk[0]);
    const { feeEdge, lvr } = attribution(blk, q0);
    const repos = blk.filter(
      (r) => r.executed && r.planType === 'reposition' && !/de-?risk/i.test(r.reason || ''),
    ).length;
    const derisks = blk.filter((r) => r.executed && /de-?risk/i.test(r.reason || '')).length;
    const widths = blk.map((r) => num(r.signals?.width)).filter((v): v is number => v !== null);
    const curve = widths.length
      ? `±${Math.min(...widths)}${Math.max(...widths) !== Math.min(...widths) ? `→${Math.max(...widths)}` : ''}`
      : '?';
    // Deposit/withdraw guard: decomposition drifts far from recorded vs-hodl.
    const deposit =
      vsHodl !== null && Math.abs(feeEdge - lvr - vsHodl) > Math.max(20, 0.25 * Math.abs(vsHodl));
    const label = calendar ? new Date(lo).toISOString().slice(5, 10) : `${k * 24}-${(k + 1) * 24}h`;
    if (deposit) {
      console.log(`${pad(label, 9)} ${pad('  — capital change in this block (numbers unreliable) —', 9)}`);
      continue;
    }
    if (vsHodl !== null) cumVsHodl += vsHodl;
    console.log(
      `${pad(label, 9)} ${(vsHodl !== null ? usd(vsHodl) : '-').padStart(9)} ${usd(nominal).padStart(9)} ` +
        `${(btcPct !== null ? `${btcPct >= 0 ? '+' : ''}${btcPct.toFixed(2)}` : '-').padStart(7)} ` +
        `${usd(feeEdge).padStart(10)} ${usd(-lvr).padStart(9)} ${String(repos).padStart(6)} ${String(derisks).padStart(7)}  ${curve}`,
    );
  }
  console.log();
  console.log(`sum vs hodl, clean blocks shown (RECENT flow only): ${usd(cumVsHodl)}`);
  if (pnlAll !== null)
    console.log(
      `NOTE: this is not your total. ALL-TIME vs hodl is ${usd(pnlAll)}; the difference ` +
        `(${usd(pnlAll - cumVsHodl)}) sits in the flagged/older blocks (churn night + pre-baseline).`,
    );
  console.log(`(vs hodl = fees+edge − lvr; nominal includes the reference-price move. Use vs hodl to judge the strategy.)`);
};

if (daily) {
  renderDaily();
} else {
  render();
  if (watch) {
    setInterval(render, everyMs);
  }
}
