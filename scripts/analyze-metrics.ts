// Summarize a metrics JSONL file (data/metrics.<profile>.jsonl) into a quick
// validation report: decision/hold tallies, strategy signal ranges (curve: f,
// bidFraction, width, size, sigma, dBps, ...), divergence + staleness buckets,
// PnL, and the notable ticks (freezes, M2 vol extremes, divergence peaks).
//
// Usage:
//   npm run analyze                       # defaults to data/metrics.sbtc.jsonl
//   npm run analyze -- --pool stx         # data/metrics.<pool>.jsonl
//   npm run analyze -- data/metrics.jsonl # explicit file
//   npx tsx scripts/analyze-metrics.ts <file> [--top N]
//
// Dependency-free (node builtins only) so it runs without a build step.

import { readFileSync } from 'fs';

interface Row {
  t: string;
  tickId: number;
  pool?: string;
  decision: string;
  reason?: string;
  reasonTag?: string;
  planType?: string | null;
  activeBinId?: number;
  portfolioValue?: number | null;
  pnlVsHodl?: number | null;
  // Gas is always native STX, separate from pool inventory.
  feesPaidStx?: number;
  executed?: boolean;
  signals?: Record<string, number>;
  [k: string]: unknown;
}

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const top = topIdx >= 0 ? Math.max(1, Number(args[topIdx + 1]) || 3) : 3;
const poolIdx = args.indexOf('--pool');
const pool = poolIdx >= 0 ? args[poolIdx + 1] : undefined;
const file =
  args.find(
    (a, i) =>
      !a.startsWith('--') && !(topIdx >= 0 && i === topIdx + 1) && !(poolIdx >= 0 && i === poolIdx + 1),
  ) ||
  (pool ? `data/metrics.${pool}.jsonl` : 'data/metrics.sbtc.jsonl');

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
      rows.push(JSON.parse(s) as Row);
    } catch {
      // skip malformed line
    }
  }
  return rows;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n: number, d = 6): number => Number(n.toFixed(d));
const pct = (n: number, total: number): string => `${((100 * n) / total).toFixed(1)}%`;

const tally = (rows: Row[], key: keyof Row): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r[key] ?? 'null');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};

const fmtTally = (t: Record<string, number>, total: number): string =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v} (${pct(v, total)})`)
    .join('  ');

// Collect a numeric column from signals (or top-level fallback).
const col = (rows: Row[], key: string): number[] => {
  const out: number[] = [];
  for (const r of rows) {
    const v = num(r.signals?.[key]) ?? num(r[key]);
    if (v !== null) out.push(v);
  }
  return out;
};

const stat = (c: number[]): { min: number; max: number; mean: number; last: number } | null => {
  if (c.length === 0) return null;
  const sum = c.reduce((a, b) => a + b, 0);
  return { min: Math.min(...c), max: Math.max(...c), mean: sum / c.length, last: c[c.length - 1] };
};

const rows = parse(file);
if (rows.length === 0) {
  console.error(`no rows in ${file}`);
  process.exit(1);
}

const total = rows.length;
const first = rows[0];
const last = rows[total - 1];
const hours = (new Date(last.t).getTime() - new Date(first.t).getTime()) / 3_600_000;

const line = (s = ''): void => console.log(s);
const header = (s: string): void => {
  line();
  line(`== ${s} ==`);
};

line(`file: ${file}`);
line(`pool: ${first.pool ?? '?'}   ticks: ${total}`);
line(`window: ${first.t} -> ${last.t}  (${hours.toFixed(1)}h)`);

header('decisions');
line(`decision:  ${fmtTally(tally(rows, 'decision'), total)}`);
line(`reasonTag: ${fmtTally(tally(rows, 'reasonTag'), total)}`);
line(`planType:  ${fmtTally(tally(rows, 'planType'), total)}`);
line(`executed:  ${rows.filter((r) => r.executed).length}   frozen: ${rows.filter((r) => r.decision === 'frozen').length}`);

// Signal ranges: union of every signal key seen, plus refAgeMs handled below.
const signalKeys = Array.from(new Set(rows.flatMap((r) => Object.keys(r.signals ?? {}))));
if (signalKeys.length > 0) {
  header('strategy signals (min / mean / max / last)');
  for (const k of signalKeys) {
    const s = stat(col(rows, k));
    if (s) line(`${k.padEnd(12)} ${round(s.min)}  /  ${round(s.mean)}  /  ${round(s.max)}  /  ${round(s.last)}`);
  }
}

const dBps = col(rows, 'dBps');
if (dBps.length > 0) {
  header('divergence (dBps)');
  const ge = (n: number): number => dBps.filter((x) => x >= n).length;
  line(`>=40: ${ge(40)} (${pct(ge(40), dBps.length)})   >=80 warn: ${ge(80)}   >=150 halt: ${ge(150)}   peak: ${Math.max(...dBps)}`);
}

const age = col(rows, 'refAgeMs');
if (age.length > 0) {
  header('feed staleness (refAgeMs)');
  line(`max: ${Math.max(...age)}ms   mean: ${Math.round(age.reduce((a, b) => a + b, 0) / age.length)}ms`);
}

const bins = rows.map((r) => r.activeBinId).filter((b): b is number => typeof b === 'number' && b >= 0);
if (bins.length > 0) {
  header('active bin');
  line(`range: ${Math.min(...bins)} -> ${Math.max(...bins)}   distinct: ${new Set(bins).size}   last: ${bins[bins.length - 1]}`);
}

const pnl = num(last.pnlVsHodl);
const val = num(last.portfolioValue);
// feesPaidStx is per-tick, so total gas is the sum across ticks.
const feesTotal = col(rows, 'feesPaidStx').reduce((a, b) => a + b, 0);
if (pnl !== null || val !== null || feesTotal > 0) {
  header('portfolio (quote-denominated)');
  if (val !== null) line(`value:        ${round(val, 6)}`);
  if (pnl !== null) line(`pnl vs hodl:  ${round(pnl, 6)}`);
  line(`fees paid:    ${round(feesTotal, 6)} total (gas, STX)`);
}

// Notable ticks.
const show = (r: Row, tag: string): void => {
  const s = r.signals ?? {};
  line(
    `[${tag}] tick=${r.tickId} t=${r.t} dec=${r.decision} bin=${r.activeBinId} ` +
      `sigma=${s.sigma ?? '-'} width=${s.width ?? '-'} size=${s.size ?? '-'} dBps=${s.dBps ?? '-'} ` +
      `${r.reason ? `reason="${r.reason.slice(0, 60)}"` : ''}`,
  );
};

const frozen = rows.filter((r) => r.decision === 'frozen');
if (frozen.length > 0) {
  header(`frozen ticks (${frozen.length})`);
  frozen.slice(0, top).forEach((r) => show(r, 'freeze'));
}

const bySig = (key: string, desc: boolean): Row[] =>
  rows
    .filter((r) => num(r.signals?.[key]) !== null)
    .sort((a, b) => (desc ? -1 : 1) * ((a.signals![key] as number) - (b.signals![key] as number)));

if (signalKeys.includes('width')) {
  header(`top ${top} width (M2 widen)`);
  bySig('width', true).slice(0, top).forEach((r) => show(r, 'wide'));
}
if (signalKeys.includes('size')) {
  header(`min ${top} size (M2 shrink)`);
  bySig('size', false).slice(0, top).forEach((r) => show(r, 'small'));
}
if (signalKeys.includes('dBps')) {
  header(`top ${top} dBps (divergence)`);
  bySig('dBps', true).slice(0, top).forEach((r) => show(r, 'div'));
}

line();
