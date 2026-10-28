// Bridge demo mode (CONSOLE_BRIDGE_DEMO=1): made-up balances and transfers that
// move through every stage on a timer, so the Bridge page can be tried without
// real BTC. Nothing here touches the network or signs anything.
import { randomBytes } from 'crypto';
import { BridgeClient, BridgeTransfer, EmilyRecord, reclaimKeyOf } from './bridge';

// A throwaway key, so the deposit address is well-formed. The page warns not to
// send to it: nobody runs signers for this key.
const DEMO_SIGNERS = reclaimKeyOf('11'.repeat(32));

/** sBTC and STX the demo wallet pretends to hold. */
export const DEMO_HELD_SATS = 4_200_000;
export const DEMO_STX = 0.4;

const STAGE_MS = 15_000;

const hex = (): string => randomBytes(32).toString('hex');

export interface DemoBridge extends BridgeClient {
  /** Pretends BTC landed at the address, as if the user had sent it. */
  send(address: string, sats: number): void;
}

export const demoBridge = (): DemoBridge => {
  const utxos = new Map<string, Array<{ txid: string; vout: number; value: number; confirmed: boolean }>>();
  const born = new Map<string, number>();
  const ids = new Map<string, string>();
  const age = (key: string): number => {
    if (!born.has(key)) born.set(key, Date.now());
    return Date.now() - (born.get(key) || 0);
  };
  const idFor = (key: string): string => {
    if (!ids.has(key)) ids.set(key, hex());
    return ids.get(key) || '';
  };
  const record = (status: string, extra: Partial<EmilyRecord> = {}): EmilyRecord => ({ status, message: '', btcTxid: null, stacksTxid: null, requestId: null, ...extra });

  return {
    signersKey: () => Promise.resolve(DEMO_SIGNERS),
    utxos: (address) => Promise.resolve(utxos.get(address) || []),
    register: ({ txid, vout }) => {
      age(`dep:${txid}:${vout}`);
      return Promise.resolve(record('pending'));
    },
    deposit: (txid, vout) => {
      const key = `dep:${txid}:${vout}`;
      if (!born.has(key)) return Promise.resolve(null);
      const t = age(key);
      if (t < STAGE_MS) return Promise.resolve(record('pending'));
      if (t < 2 * STAGE_MS) return Promise.resolve(record('accepted'));
      return Promise.resolve(record('confirmed', { btcTxid: idFor(`${key}:sweep`), stacksTxid: `0x${idFor(`${key}:mint`)}` }));
    },
    withdrawal: (_sender, stacksTxid) => {
      const t = age(`wd:${stacksTxid}`);
      if (t < STAGE_MS / 3) return Promise.resolve(null);
      if (t < 2 * STAGE_MS) return Promise.resolve(record('pending', { requestId: 4242 }));
      return Promise.resolve(record('confirmed', { requestId: 4242, btcTxid: idFor(`wd:${stacksTxid}:btc`) }));
    },
    feeRate: () => Promise.resolve(3),
    limits: () => Promise.resolve({ minDepositSats: 10_000, maxWithdrawSats: 50_100_000_000 }),
    send: (address, sats) => {
      const list = utxos.get(address) || [];
      list.push({ txid: hex(), vout: 0, value: sats, confirmed: false });
      utxos.set(address, list);
    },
  };
};

/** What the `--sbtc-withdraw` runner would print, after a pause like a real confirmation. */
export const demoWithdrawRun = (): Promise<string> =>
  new Promise((resolve) => {
    const tx = `0x${hex()}`;
    setTimeout(() => resolve(`[sbtc] step=request tx=${tx} ok=true status="success"\n[sbtc] done tx=${tx}\n`), 4000);
  });

/** Finished transfers so the history list has something to show. */
export const demoHistory = (now: number): BridgeTransfer[] => {
  const at = (hoursAgo: number): string => new Date(now - hoursAgo * 3600_000).toISOString();
  const base = { message: '', btcTxid: hex(), stacksTxid: `0x${hex()}` };
  return [
    { ...base, id: 'demo-1', kind: 'deposit', status: 'done', amountSats: 2_500_000, createdAt: at(72), updatedAt: at(70), message: 'sBTC arrived.' },
    {
      ...base,
      id: 'demo-2',
      kind: 'withdraw',
      status: 'done',
      amountSats: 600_000,
      createdAt: at(30),
      updatedAt: at(29),
      btcAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      message: 'BTC sent.',
    },
    {
      ...base,
      id: 'demo-3',
      kind: 'deposit',
      status: 'failed',
      amountSats: 12_000,
      createdAt: at(6),
      updatedAt: at(5),
      stacksTxid: null,
      message: 'Rejected by signers. BTC can be reclaimed after about a week; see docs/RECOVERY.md.',
    },
  ];
};
