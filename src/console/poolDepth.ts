import { BinBar } from './model';

// The bot's own Bitflow reader lives in ../bitflow, but importing it pulls in
// config.ts, which loads a .env file into this process; spawned bots inherit
// process.env and dotenv never overrides, so those values would shadow each
// bot's own .env.<pool>. This reader is self-contained for that reason.

const DEFAULT_BASE = 'https://bff.bitflowapis.finance/api';
// v2 ladder ids are signed around this centre; the bot and its ticks use 0..1000.
const BIN_CENTER = 500;
const PRICE_SCALE = 1e8;
const FRESH_MS = 15_000;
const WINDOW = 12;
const MAX_BARS = 60;

export interface DepthRequest {
  /** Contract id, or a legacy short alias that is looked up once. */
  poolId: string;
  address: string | null;
  baseDecimals: number;
  quoteDecimals: number;
  apiBase?: string;
}

export interface Depth {
  bars: BinBar[];
  /** False when your per-bin share could not be read; owned bins then fill the whole bar. */
  oursExact: boolean;
  poolContract: string;
  readAt: number;
}

export interface PoolDepthReader {
  /** Last good depth (or null), refreshing in the background when it is older than a few seconds. */
  peek(req: DepthRequest): Depth | null;
  /** The pool's contract principal once known, for explorer links. */
  contractOf(poolId: string): string | null;
}

export const noPoolDepth: PoolDepthReader = { peek: () => null, contractOf: () => null };

interface LadderBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface CurrentBin {
  binIdUnsigned: number;
  userShares: string;
  binShares: string;
}

const num = (value: string | number | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
};

/** Pure: ladder + your shares -> bars around the active bin, valued in the quote token. */
export const barsFromLadder = (
  ladder: LadderBin[],
  activeSigned: number,
  shares: CurrentBin[] | null,
  baseDecimals: number,
  quoteDecimals: number,
): BinBar[] => {
  const active = activeSigned + BIN_CENTER;
  const owned = new Map<number, number>();
  for (const bin of shares || []) {
    const total = num(bin.binShares);
    owned.set(Number(bin.binIdUnsigned), total > 0 ? Math.min(1, num(bin.userShares) / total) : 1);
  }
  const ownedIds = Array.from(owned.keys());
  let start = Math.min(active - WINDOW, ...(ownedIds.length ? ownedIds : [active]));
  let end = Math.max(active + WINDOW, ...(ownedIds.length ? ownedIds : [active]));
  if (end - start + 1 > MAX_BARS) {
    start = Math.max(start, active - MAX_BARS / 2);
    end = start + MAX_BARS - 1;
  }
  const byId = new Map<number, LadderBin>();
  for (const bin of ladder) byId.set(Number(bin.bin_id) + BIN_CENTER, bin);
  const scale = Math.pow(10, baseDecimals - quoteDecimals) / PRICE_SCALE;
  const bars: BinBar[] = [];
  for (let id = start; id <= end; id += 1) {
    const bin = byId.get(id);
    const pool = bin
      ? num(bin.reserve_y) / Math.pow(10, quoteDecimals) + (num(bin.reserve_x) / Math.pow(10, baseDecimals)) * num(bin.price) * scale
      : 0;
    const share = owned.get(id);
    bars.push({ id, pool, ours: share == null ? 0 : pool * share, active: id === active });
  }
  return bars;
};

export const livePoolDepth = (): PoolDepthReader => {
  const contracts = new Map<string, string>();
  const cache = new Map<string, Depth>();
  const inflight = new Set<string>();

  const refresh = async (key: string, req: DepthRequest): Promise<void> => {
    const base = (req.apiBase || DEFAULT_BASE).replace(/\/$/, '');
    let contract = req.poolId.includes('.') ? req.poolId : contracts.get(req.poolId);
    if (!contract) {
      // Every v2 route takes the contract id; only a legacy alias needs this lookup.
      const pool = await getJson<{ poolContract?: string; poolId?: string }>(`${base}/app/v2/pools/${req.poolId}`);
      contract = pool.poolContract || pool.poolId || '';
      if (!contract) throw new Error(`no contract for ${req.poolId}`);
    }
    contracts.set(req.poolId, contract);
    const [ladder, shares] = await Promise.all([
      getJson<{ bins?: LadderBin[]; active_bin_id?: number | null }>(`${base}/quotes/v2/bins/${contract}`),
      req.address
        ? getJson<{ bins?: CurrentBin[]; clean?: boolean; complete?: boolean }>(
            `${base}/app/v2/users/${req.address}/positions/${contract}/current-bins`,
          )
            .then((res) => (res.clean === true && res.complete === true ? res.bins || [] : null))
            .catch(() => null)
        : Promise.resolve([] as CurrentBin[]),
    ]);
    if (ladder.active_bin_id == null || !ladder.bins || !ladder.bins.length) throw new Error('empty ladder');
    cache.set(key, {
      bars: barsFromLadder(ladder.bins, ladder.active_bin_id, shares, req.baseDecimals, req.quoteDecimals),
      oursExact: shares != null,
      poolContract: contract,
      readAt: Date.now(),
    });
  };

  return {
    peek: (req) => {
      const key = `${req.poolId}|${req.address || ''}`;
      const hit = cache.get(key) || null;
      if ((!hit || Date.now() - hit.readAt > FRESH_MS) && !inflight.has(key)) {
        inflight.add(key);
        // A failed read keeps the last good depth; the page falls back to the bot's own bins.
        void refresh(key, req)
          .catch(() => undefined)
          .finally(() => inflight.delete(key));
      }
      return hit;
    },
    contractOf: (poolId) => (poolId.includes('.') ? poolId : contracts.get(poolId) || null),
  };
};
