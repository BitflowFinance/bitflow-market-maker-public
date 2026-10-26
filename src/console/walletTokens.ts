// Every token a bot wallet holds, read straight from the chain. The page shows
// balances from it even when the bot is paused or stopped (and so not reading
// them), and flags tokens its pool doesn't use (sBTC sent to the STX bot).
// Self-contained for the same reason as poolDepth.ts: the bot's own readers load
// config.ts and a .env file.

const HIRO = 'https://api.hiro.so';
const BFF = 'https://bff.bitflowapis.finance/api';
const FRESH_MS = 20_000;
const TOKENS_FRESH_MS = 10 * 60_000;

export interface HeldToken {
  contract: string;
  symbol: string;
  amount: number;
  /** False when Bitflow does not list it, so cash-out cannot send it and it needs a wallet app. */
  known: boolean;
}

export interface WalletRead {
  /** Native STX, in whole STX. */
  stx: number;
  tokens: HeldToken[];
  at: number;
}

export interface WalletTokenReader {
  /** Last read of the wallet (or null), refreshing in the background. */
  peek(address: string): WalletRead | null;
}

export const noWalletTokens: WalletTokenReader = { peek: () => null };

interface BffToken {
  contract_address: string;
  symbol: string;
  decimals: number;
}

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
};

/** Pure: Hiro's fungible balances, labelled from Bitflow's token list. Zero balances are dropped. */
export const heldTokensOf = (
  balances: Record<string, { balance?: string }>,
  known: BffToken[],
): HeldToken[] => {
  const byContract = new Map(known.map((token) => [token.contract_address, token]));
  const out: HeldToken[] = [];
  for (const [id, entry] of Object.entries(balances)) {
    const raw = Number(entry.balance || '0');
    if (!(raw > 0)) continue;
    const contract = id.split('::')[0];
    const token = byContract.get(contract);
    out.push({
      contract,
      symbol: token ? token.symbol : contract.split('.').pop() || contract,
      amount: token ? raw / Math.pow(10, token.decimals) : raw,
      known: Boolean(token),
    });
  }
  return out;
};

export const liveWalletTokens = (): WalletTokenReader => {
  const cache = new Map<string, WalletRead>();
  const inflight = new Set<string>();
  let known: { at: number; tokens: BffToken[] } | null = null;

  const tokenList = async (): Promise<BffToken[]> => {
    if (known && Date.now() - known.at < TOKENS_FRESH_MS) return known.tokens;
    const res = await getJson<{ tokens?: BffToken[] }>(`${BFF}/quotes/v2/tokens`);
    known = { at: Date.now(), tokens: res.tokens || [] };
    return known.tokens;
  };

  const refresh = async (address: string): Promise<void> => {
    const [balances, tokens] = await Promise.all([
      getJson<{ stx?: { balance?: string }; fungible_tokens?: Record<string, { balance?: string }> }>(`${HIRO}/extended/v1/address/${address}/balances`),
      tokenList(),
    ]);
    cache.set(address, {
      stx: Number(balances.stx?.balance || '0') / 1e6,
      tokens: heldTokensOf(balances.fungible_tokens || {}, tokens),
      at: Date.now(),
    });
  };

  return {
    peek: (address) => {
      const hit = cache.get(address);
      if ((!hit || Date.now() - hit.at > FRESH_MS) && !inflight.has(address)) {
        inflight.add(address);
        void refresh(address)
          .catch(() => undefined)
          .finally(() => inflight.delete(address));
      }
      return hit || null;
    },
  };
};
