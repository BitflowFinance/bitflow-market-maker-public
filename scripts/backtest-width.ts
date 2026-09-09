// Back-test curve width against the RECORDED active-bin path (metrics JSONL).
// For each candidate half-width W it replays the reposition rule (recenter when the
// active bin leaves [center-W, center+W]) and counts repositions -- the concrete,
// measured churn driver (each reposition realizes adverse selection + costs fees).
// LVR is shown as a ~1/width scaling relative to the current width (standard
// concentrated-LP result: narrower range = higher liquidity density = more adverse
// flow), so the two columns together bound the win from widening.
//
// Usage:
//   npm run backtest                         # data/metrics.sbtc.jsonl, last 72h + full
//   npm run backtest -- --pool stx           # data/metrics.<pool>.jsonl
//   npm run backtest -- --hours 24           # rolling window only
//   npm run backtest -- data/metrics.jsonl --widths 3,4,6,8,10
//
// Dependency-free (node builtins only) so it runs without a build step.

import { readFileSync } from 'fs';

const BIN_STEP_BPS = 10; // sBTC/USDCx pool bin step (10 bps per bin).

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pool = flag('--pool');
const file =
  args.find((a, i) => !a.startsWith('--') && args[i - 1]?.startsWith('--') !== true) ||
  (pool ? `data/metrics.${pool}.jsonl` : 'data/metrics.sbtc.jsonl');
const hoursArg = flag('--hours') ? Number(flag('--hours')) : undefined;
const widths = (flag('--widths') || '3,4,5,6,8,10,12').split(',').map((s) => Math.max(1, Math.floor(Number(s))));

interface Row {
  t: string;
  activeBinId?: number;
  signals?: Record<string, number>;
}

const parse = (path: string): Row[] => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`cannot read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  const rows: Row[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as Row;
      if (typeof r.activeBinId === 'number' && Number.isFinite(r.activeBinId)) rows.push(r);
    } catch {
      // skip malformed
    }
  }
  return rows;
};

// Replay the reposition rule for half-width W over a bin path; return reposition count.
const repositions = (rows: Row[], w: number): number => {
  if (rows.length === 0) return 0;
  let center = rows[0].activeBinId as number;
  let reps = 0;
  for (const r of rows) {
    const b = r.activeBinId as number;
    if (Math.abs(b - center) > w) {
      reps += 1;
      center = b;
    }
  }
  return reps;
};

const spanHours = (rows: Row[]): number =>
  rows.length < 2
    ? 0
    : (new Date(rows[rows.length - 1].t).getTime() - new Date(rows[0].t).getTime()) / 3_600_000;

const currentWidth = Math.min(...widths);

const report = (rows: Row[], label: string): void => {
  const h = spanHours(rows);
  const base = repositions(rows, currentWidth) || 1;
  console.log(`\n== ${label}: ${rows.length} ticks over ${h.toFixed(1)}h ==`);
  console.log(
    `${'W(±bins)'.padStart(9)} ${'range'.padStart(7)} | ${'reps'.padStart(6)} ${'reps/day'.padStart(9)} | ${'vs cur'.padStart(7)} | ${'LVR~1/W'.padStart(8)}`,
  );
  for (const w of widths) {
    const reps = repositions(rows, w);
    const perDay = h > 0 ? (reps / h) * 24 : 0;
    const rangePct = ((2 * w + 1) * BIN_STEP_BPS) / 100;
    const vsCur = base > 0 ? `${(((reps - base) / base) * 100).toFixed(0)}%` : '-';
    const lvr = `${(currentWidth / w).toFixed(2)}x`;
    const cur = w === currentWidth ? '  <- current' : '';
    console.log(
      `${String(w).padStart(9)} ${(`±${rangePct.toFixed(1)}%`).padStart(7)} | ${String(reps).padStart(6)} ${perDay.toFixed(1).padStart(9)} | ${vsCur.padStart(7)} | ${lvr.padStart(8)}${cur}`,
    );
  }
};

const rows = parse(file);
if (rows.length === 0) {
  console.error(`no bin rows in ${file}`);
  process.exit(1);
}
console.log(`file: ${file}   bin-path ticks: ${rows.length}`);

if (hoursArg && hoursArg > 0) {
  const cutoff = new Date(rows[rows.length - 1].t).getTime() - hoursArg * 3_600_000;
  report(rows.filter((r) => new Date(r.t).getTime() >= cutoff), `rolling ${hoursArg}h`);
} else {
  const cutoff = new Date(rows[rows.length - 1].t).getTime() - 72 * 3_600_000;
  report(rows.filter((r) => new Date(r.t).getTime() >= cutoff), 'rolling 72h');
  report(rows, 'full history');
}
console.log();
