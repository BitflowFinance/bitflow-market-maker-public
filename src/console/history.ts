import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { TickLike } from './model';

const RECENT = 200;
// Halving past this keeps memory flat for a bot that has run for months.
const MAX_POINTS = 4000;
const SERIES_POINTS = 300;
const DAY_MS = 86_400_000;

/** One check, or several merged ones once the series has been halved. */
export interface Point {
  t: number;
  value: number | null;
  /** Share of merged checks where the price sat inside our bins; null when nothing was deployed. */
  inRange: number | null;
  /** How many checks this point stands for. */
  n: number;
  trades: number;
  wouldTrades: number;
  gasStx: number;
}

export interface Insights {
  since: string | null;
  inRange24h: number | null;
  trades24h: number;
  wouldTrades24h: number;
  tradesAll: number;
  gasStx24h: number;
  gasStxAll: number;
  lastTrade: { t: string; txIds: string[]; planType: string | null; sent: boolean } | null;
}

export type Range = '1d' | '7d' | 'all';

const inRangeOf = (tick: TickLike): number | null => {
  const owned = tick.ownedBinIds || [];
  if (!owned.length || tick.activeBinId == null || tick.activeBinId < 0) return null;
  return tick.activeBinId >= Math.min(...owned) && tick.activeBinId <= Math.max(...owned) ? 1 : 0;
};

export const pointOf = (tick: TickLike): Point => ({
  t: new Date(tick.t).getTime(),
  value: tick.portfolioValue != null && Number.isFinite(tick.portfolioValue) ? tick.portfolioValue : null,
  inRange: inRangeOf(tick),
  n: 1,
  trades: tick.executed ? 1 : 0,
  wouldTrades: tick.decision === 'rebalance' && !tick.executed ? 1 : 0,
  gasStx: tick.feesPaidStx || 0,
});

const merge = (a: Point, b: Point): Point => {
  const ranged = [a, b].filter((p) => p.inRange != null);
  const weight = ranged.reduce((sum, p) => sum + p.n, 0);
  return {
    t: b.t,
    value: b.value ?? a.value,
    inRange: weight ? ranged.reduce((sum, p) => sum + (p.inRange as number) * p.n, 0) / weight : null,
    n: a.n + b.n,
    trades: a.trades + b.trades,
    wouldTrades: a.wouldTrades + b.wouldTrades,
    gasStx: a.gasStx + b.gasStx,
  };
};

const halve = (points: Point[]): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += 2) out.push(i + 1 < points.length ? merge(points[i], points[i + 1]) : points[i]);
  return out;
};

/** Pure: the numbers the overview shows, from a series and the latest trade. */
export const insightsOf = (points: Point[], lastTrade: Insights['lastTrade'], nowMs: number): Insights => {
  const dayAgo = nowMs - DAY_MS;
  let ranged = 0;
  let inside = 0;
  const out: Insights = {
    since: points.length ? new Date(points[0].t).toISOString() : null,
    inRange24h: null,
    trades24h: 0,
    wouldTrades24h: 0,
    tradesAll: 0,
    gasStx24h: 0,
    gasStxAll: 0,
    lastTrade,
  };
  for (const p of points) {
    out.tradesAll += p.trades;
    out.gasStxAll += p.gasStx;
    if (p.t < dayAgo) continue;
    out.trades24h += p.trades;
    out.wouldTrades24h += p.wouldTrades;
    out.gasStx24h += p.gasStx;
    if (p.inRange != null) {
      ranged += p.n;
      inside += p.inRange * p.n;
    }
  }
  out.inRange24h = ranged ? inside / ranged : null;
  return out;
};

/** Pure: value points for a chart range, thinned to a drawable count. */
export const seriesOf = (points: Point[], range: Range, nowMs: number): Array<{ t: string; value: number }> => {
  const since = range === '1d' ? nowMs - DAY_MS : range === '7d' ? nowMs - 7 * DAY_MS : -Infinity;
  const valued = points.filter((p) => p.t >= since && p.value != null);
  const step = Math.max(1, Math.ceil(valued.length / SERIES_POINTS));
  const out: Array<{ t: string; value: number }> = [];
  for (let i = step - 1; i < valued.length; i += step) out.push({ t: new Date(valued[i].t).toISOString(), value: valued[i].value as number });
  const last = valued[valued.length - 1];
  if (last && (!out.length || out[out.length - 1].t !== new Date(last.t).toISOString())) {
    out.push({ t: new Date(last.t).toISOString(), value: last.value as number });
  }
  return out;
};

export const lastTradeOf = (tick: TickLike): Insights['lastTrade'] =>
  tick.executed || tick.decision === 'rebalance'
    ? { t: tick.t, txIds: tick.txIds || [], planType: tick.planType || null, sent: Boolean(tick.executed) }
    : null;

/**
 * Follows a bot's metrics JSONL. Each sync reads only the bytes appended since
 * the last one, so a long history costs one full read and then a little per poll.
 */
export class HistoryFile {
  recent: TickLike[] = [];
  points: Point[] = [];
  lastTrade: Insights['lastTrade'] = null;
  private offset = 0;
  private carry = '';

  constructor(private file: string) {}

  sync(): void {
    if (!existsSync(this.file)) {
      this.reset();
      return;
    }
    const size = statSync(this.file).size;
    if (size < this.offset) this.reset();
    if (size === this.offset) return;
    const fd = openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset = size;
      const lines = (this.carry + buffer.toString('utf8')).split('\n');
      // The last piece is a partial line until the bot finishes writing it.
      this.carry = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.ingest(JSON.parse(line) as TickLike);
        } catch {
          // A torn or foreign line is skipped.
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  private ingest(tick: TickLike): void {
    this.recent.push(tick);
    if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
    this.points.push(pointOf(tick));
    if (this.points.length > MAX_POINTS) this.points = halve(this.points);
    this.lastTrade = lastTradeOf(tick) || this.lastTrade;
  }

  private reset(): void {
    this.recent = [];
    this.points = [];
    this.lastTrade = null;
    this.offset = 0;
    this.carry = '';
  }
}
