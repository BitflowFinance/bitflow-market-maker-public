import { SbtcApiClientMainnet } from 'sbtc';
import { BridgeClient, BridgeLimits, EmilyRecord } from './bridge';
import { liveUsdcClient } from './usdcLive';

const EMILY = 'https://sbtc-emily.com';
const MEMPOOL = 'https://mempool.space/api';
const SIGNERS_FRESH_MS = 10 * 60_000;
const LIMITS_FRESH_MS = 10 * 60_000;
const WITHDRAWAL_PAGES = 3;

interface EmilyRaw {
  status?: string;
  statusMessage?: string;
  message?: string;
  requestId?: number;
  txid?: string;
  fulfillment?: { BitcoinTxid?: string; StacksTxid?: string } | null;
}

const bare = (txid: string): string => txid.trim().replace(/^0x/, '').toLowerCase();

const request = async <T>(url: string, init?: RequestInit): Promise<T | null> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as EmilyRaw | null;
    throw new Error(body?.message || `${res.status} ${url}`);
  }
  return (await res.json()) as T;
};

const recordOf = (raw: EmilyRaw): EmilyRecord => ({
  status: raw.status || 'pending',
  message: raw.status === 'failed' ? raw.statusMessage || '' : '',
  btcTxid: raw.fulfillment?.BitcoinTxid || null,
  stacksTxid: raw.fulfillment?.StacksTxid ? `0x${bare(raw.fulfillment.StacksTxid)}` : null,
  requestId: raw.requestId ?? null,
});

/** Official sBTC: signers' key from the chain, intake and status through Emily, Bitcoin reads through mempool.space. USDCx reads come from usdcLive.ts. */
export const liveBridgeClient = (): BridgeClient => {
  const sbtc = new SbtcApiClientMainnet();
  let signers: { at: number; key: string } | null = null;
  let limits: { at: number; value: BridgeLimits } | null = null;
  const requestIds = new Map<string, number>();

  return {
    signersKey: async () => {
      if (signers && Date.now() - signers.at < SIGNERS_FRESH_MS) return signers.key;
      signers = { at: Date.now(), key: await sbtc.fetchSignersPublicKey() };
      return signers.key;
    },
    utxos: async (address) => {
      const list = (await request<Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>>(`${MEMPOOL}/address/${address}/utxo`)) || [];
      return list.map((utxo) => ({ txid: utxo.txid, vout: utxo.vout, value: utxo.value, confirmed: Boolean(utxo.status?.confirmed) }));
    },
    register: async ({ txid, vout, depositScript, reclaimScript }) => {
      const transactionHex = await sbtc.fetchTxHex(txid);
      const raw = await request<EmilyRaw>(`${EMILY}/deposit`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ bitcoinTxid: txid, bitcoinTxOutputIndex: vout, depositScript, reclaimScript, transactionHex }),
      });
      if (!raw?.status) throw new Error(raw?.message || 'Emily did not accept the deposit');
      return recordOf(raw);
    },
    deposit: async (txid, vout) => {
      const raw = await request<EmilyRaw>(`${EMILY}/deposit/${bare(txid)}/${vout}`);
      return raw ? recordOf(raw) : null;
    },
    withdrawal: async (sender, stacksTxid) => {
      const key = bare(stacksTxid);
      let id = requestIds.get(key);
      if (id === undefined) {
        let next = '';
        for (let page = 0; page < WITHDRAWAL_PAGES && id === undefined; page++) {
          const res = await request<{ withdrawals?: EmilyRaw[]; nextToken?: string }>(
            `${EMILY}/withdrawal/sender/${sender}${next ? `?nextToken=${encodeURIComponent(next)}` : ''}`,
          );
          const hit = (res?.withdrawals || []).find((item) => item.txid && bare(item.txid) === key);
          if (hit?.requestId != null) id = hit.requestId;
          if (!res?.nextToken) break;
          next = res.nextToken;
        }
        if (id === undefined) return null;
        requestIds.set(key, id);
      }
      // Only the single-request read carries the Bitcoin fulfillment.
      const raw = await request<EmilyRaw>(`${EMILY}/withdrawal/${id}`);
      return raw ? recordOf(raw) : null;
    },
    feeRate: () => sbtc.fetchFeeRate('high'),
    limits: async () => {
      if (limits && Date.now() - limits.at < LIMITS_FRESH_MS) return limits.value;
      const raw = await request<{ perDepositMinimum?: number; perWithdrawalCap?: number; availableToWithdraw?: number }>(`${EMILY}/limits`);
      const caps = [raw?.perWithdrawalCap, raw?.availableToWithdraw].filter((value): value is number => typeof value === 'number');
      limits = {
        at: Date.now(),
        value: { minDepositSats: raw?.perDepositMinimum || 10_000, maxWithdrawSats: caps.length ? Math.min(...caps) : null },
      };
      return limits.value;
    },
    usdc: liveUsdcClient(),
  };
};
