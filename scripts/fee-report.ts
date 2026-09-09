// Tally the DLMM fees on our wallet's swap + add-liquidity txs, straight from the
// on-chain print events (dlmm-core-v-1-1). Reports TOKEN amounts (not USD):
//
//   - protocol / provider / variable  -> emitted by swaps (in the input token;
//     provider is the LP share, variable is the dynamic fee = 0 while disabled)
//   - liquidity                       -> emitted by adds (composition fee, in x/y;
//     0 when liquidity is added on-ratio)
//
// Usage:
//   npm run fees                       # reads SIGNER_ADDRESS from .env.sbtc
//   npm run fees -- --pool sbtc        # pick a different .env.<pool>
//   npm run fees -- --address SP..     # explicit wallet
//   npm run fees -- --max-tx 200 --verbose
//
// Dependency-free (node builtins + global fetch) so it runs without a build step.
import { readFileSync } from 'fs';

const HIRO = process.env.HIRO_API_URL || 'https://api.hiro.so';
const HIRO_KEY = process.env.HIRO_API_KEY || '';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);

const pool = flag('--pool') || 'sbtc';
const maxTx = Math.max(1, Number(flag('--max-tx') || 500));
const verbose = has('--verbose');
// Optional: restrict to one pool contract (this wallet may have traded several).
// Accepts a full contract or any substring, e.g. --pool-contract sbtc-usdcx.
const poolFilter = flag('--pool-contract');

// Resolve the wallet: explicit --address wins, else SIGNER_ADDRESS from .env.<pool>.
const resolveAddress = (): string => {
  const explicit = flag('--address');
  if (explicit) return explicit;
  for (const file of [`.env.${pool}`, '.env']) {
    try {
      const m = readFileSync(file, 'utf8').match(/^\s*SIGNER_ADDRESS\s*=\s*(\S+)/m);
      if (m) return m[1];
    } catch {
      // next
    }
  }
  console.error('no wallet: pass --address SP... or set SIGNER_ADDRESS in .env.' + pool);
  process.exit(1);
};

const address = resolveAddress();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const getJson = async <T>(url: string): Promise<T> => {
  const headers: Record<string, string> = {};
  if (HIRO_KEY) headers['x-api-key'] = HIRO_KEY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} (${url})`);
  }
};

interface TxSummary {
  tx_id: string;
  tx_type: string;
  tx_status: string;
  contract_call?: { function_name?: string; contract_id?: string };
}

interface TxEvent {
  event_type: string;
  contract_log?: { contract_id?: string; value?: { repr?: string } };
}

// Fee kinds emitted by dlmm-core; variable is the (currently off) dynamic fee.
type FeeKind = 'protocol' | 'provider' | 'variable' | 'liquidity';
const FEE_KINDS: FeeKind[] = ['liquidity', 'protocol', 'provider', 'variable'];

// fee kind -> token contract -> summed micro amount.
const totals: Record<FeeKind, Map<string, bigint>> = {
  protocol: new Map(),
  provider: new Map(),
  variable: new Map(),
  liquidity: new Map(),
};

const add = (kind: FeeKind, token: string, amount: bigint): void => {
  totals[kind].set(token, (totals[kind].get(token) || BigInt(0)) + amount);
};

// Pretty-print micro amounts. sBTC is 8-decimal, everything else here is 6.
const meta = (token: string): { sym: string; dec: number } => {
  if (token.endsWith('sbtc-token')) return { sym: 'sBTC', dec: 8 };
  if (token.endsWith('.usdcx')) return { sym: 'USDCx', dec: 6 };
  const short = token.split('.')[1] || token;
  return { sym: short, dec: 6 };
};
const fmt = (micro: bigint, token: string): string => {
  const { sym, dec } = meta(token);
  const neg = micro < BigInt(0);
  const s = (neg ? -micro : micro).toString().padStart(dec + 1, '0');
  const whole = s.slice(0, s.length - dec);
  const frac = s.slice(s.length - dec).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''} ${sym} (${micro} micro)`;
};

// x-token / y-token contracts from an event repr, so x-*/y-* fees bucket by token.
const tokenOf = (repr: string, side: 'x' | 'y'): string => {
  const m = repr.match(new RegExp(`\\(${side}-token '([^ )]+)`));
  return m ? m[1] : side;
};

const FEE_RE = /\(([xy])-amount-fees-(protocol|provider|variable|liquidity) u(\d+)\)/g;

const scanTx = async (txId: string): Promise<{ [k in FeeKind]: bigint } | null> => {
  const first = await getJson<{ event_count: number; events: TxEvent[] }>(
    `${HIRO}/extended/v1/tx/${txId}?event_offset=0&event_limit=100`,
  );
  const events = [...first.events];
  for (let off = 100; off < first.event_count; off += 100) {
    const page = await getJson<{ events: TxEvent[] }>(
      `${HIRO}/extended/v1/tx/${txId}?event_offset=${off}&event_limit=100`,
    );
    events.push(...page.events);
    await sleep(120);
  }

  const perTx: { [k in FeeKind]: bigint } = {
    protocol: BigInt(0),
    provider: BigInt(0),
    variable: BigInt(0),
    liquidity: BigInt(0),
  };
  let sawCore = false;
  for (const e of events) {
    const log = e.contract_log;
    if (!log || !log.contract_id || !log.contract_id.endsWith('dlmm-core-v-1-1')) continue;
    const repr = log.value?.repr || '';
    if (poolFilter) {
      const pc = repr.match(/\(pool-contract '([^ )]+)/);
      if (!pc || !pc[1].includes(poolFilter)) continue;
    }
    sawCore = true;
    for (const m of repr.matchAll(FEE_RE)) {
      const side = m[1] as 'x' | 'y';
      const kind = m[2] as FeeKind;
      const amount = BigInt(m[3]);
      if (amount === BigInt(0)) continue;
      add(kind, tokenOf(repr, side), amount);
      perTx[kind] += amount;
    }
  }
  return sawCore ? perTx : null;
};

const main = async (): Promise<void> => {
  console.log(`wallet:  ${address}`);
  console.log(`api:     ${HIRO}${HIRO_KEY ? ' (keyed)' : ''}`);
  if (poolFilter) console.log(`pool:    only legs matching "${poolFilter}"`);

  // Page the wallet's tx history, keep successful swap/add contract-calls.
  const relevant: TxSummary[] = [];
  let offset = 0;
  const limit = 50;
  let scanned = 0;
  while (scanned < maxTx) {
    const page = await getJson<{ total: number; results: TxSummary[] }>(
      `${HIRO}/extended/v1/address/${address}/transactions?limit=${limit}&offset=${offset}`,
    );
    if (page.results.length === 0) break;
    for (const tx of page.results) {
      scanned++;
      if (tx.tx_type !== 'contract_call' || tx.tx_status !== 'success') continue;
      const fn = tx.contract_call?.function_name || '';
      if (/swap|liquidity/.test(fn) && !/withdraw|remove/.test(fn)) relevant.push(tx);
    }
    offset += limit;
    if (offset >= page.total) break;
    await sleep(120);
  }

  const swaps = relevant.filter((t) => /swap/.test(t.contract_call?.function_name || ''));
  const adds = relevant.filter((t) => /liquidity/.test(t.contract_call?.function_name || ''));
  console.log(`scanned: ${scanned} txs -> ${swaps.length} swaps, ${adds.length} adds\n`);

  let i = 0;
  for (const tx of relevant) {
    const perTx = await scanTx(tx.tx_id);
    i++;
    if (verbose && perTx) {
      const parts = FEE_KINDS.filter((k) => perTx[k] > BigInt(0)).map((k) => `${k}=${perTx[k]}`);
      console.log(
        `  [${i}/${relevant.length}] ${tx.tx_id.slice(0, 10)} ${tx.contract_call?.function_name} ${parts.join(' ') || '(no fees)'}`,
      );
    }
    await sleep(120);
  }

  console.log('\n=== fee totals (token amounts) ===');
  for (const kind of FEE_KINDS) {
    const byToken = totals[kind];
    if (byToken.size === 0) {
      console.log(`${kind.padEnd(10)} 0`);
      continue;
    }
    const lines = [...byToken.entries()].map(([token, micro]) => fmt(micro, token));
    console.log(`${kind.padEnd(10)} ${lines.join('   ')}`);
  }
  console.log('\nnote: protocol + provider are collected by the pool operator; provider is the');
  console.log('LP share. liquidity = add-liquidity composition fee. variable = dynamic (off).');
};

main().catch((err) => {
  console.error(`fee-report failed: ${(err as Error).message}`);
  process.exit(1);
});
