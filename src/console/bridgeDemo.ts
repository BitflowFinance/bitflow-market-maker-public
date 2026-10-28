// Bridge demo mode (CONSOLE_BRIDGE_DEMO=1): made-up balances and transfers that
// move through every stage on a timer, so the Bridge page can be tried without
// real BTC or USDC. Nothing here touches the network or signs anything.
import { randomBytes } from 'crypto';
import { STACKS_DOMAIN, WITHDRAW_FEE_MICRO, ethAddressOf } from '../usdcx';
import { BridgeClient, BridgeTransfer, EmilyRecord, reclaimKeyOf } from './bridge';

// A throwaway key, so the deposit address is well-formed. The page warns not to
// send to it: nobody runs signers for this key.
const DEMO_SIGNERS = reclaimKeyOf('11'.repeat(32));

/** sBTC, USDCx and STX the demo wallet pretends to hold. */
export const DEMO_HELD_SATS = 4_200_000;
export const DEMO_HELD_USDC_MICRO = 1_250_500_000;
export const DEMO_STX = 0.4;

const STAGE_MS = 15_000;

const hex = (): string => randomBytes(32).toString('hex');

export interface DemoBridge extends BridgeClient {
  /** Pretends BTC landed at the address, as if the user had sent it. */
  send(address: string, sats: number): void;
  /** Pretends the user's Ethereum wallet sent a deposit to `recipient`; returns its made-up hash. */
  sendUsdc(recipient: string, micro: number): string;
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
  const ethDeposits = new Map<string, { recipient: string; value: number }>();
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
    sendUsdc: (recipient, micro) => {
      const txid = `0x${hex()}`;
      ethDeposits.set(txid, { recipient, value: micro });
      age(`eth:${txid}`);
      return txid;
    },
    usdc: {
      ethHead: () => Promise.resolve(21_000_000),
      deposit: (ethTxid) => {
        const sent = ethDeposits.get(ethTxid);
        if (!sent || age(`eth:${ethTxid}`) < STAGE_MS / 2) return Promise.resolve(null);
        return Promise.resolve({ ok: true as const, recipient: sent.recipient, domain: STACKS_DOMAIN, value: sent.value });
      },
      // Keyed by amount: the demo's deposits are one per click, so that is enough to tell them apart.
      findMint: (_address, amount, sinceMs) => Promise.resolve(Date.now() - sinceMs < 2 * STAGE_MS ? null : `0x${idFor(`mint:${amount}:${sinceMs}`)}`),
      // Keyed without the block: the search window moves on every pass.
      findPayout: (address, fromBlock, _min, max) => {
        const key = `payout:${address}:${max}`;
        return Promise.resolve({ found: age(key) < 2 * STAGE_MS ? null : { ethTxid: `0x${idFor(key)}`, value: max - WITHDRAW_FEE_MICRO }, scannedTo: fromBlock });
      },
      minWithdraw: () => Promise.resolve(4_800_000),
    },
  };
};

/** What the `--sbtc-withdraw` or `--usdcx-withdraw` runner would print, after a pause like a real confirmation. */
export const demoWithdrawRun = (tag: 'sbtc' | 'usdcx'): Promise<string> =>
  new Promise((resolve) => {
    const tx = `0x${hex()}`;
    const step = tag === 'sbtc' ? 'request' : 'burn';
    setTimeout(() => resolve(`[${tag}] step=${step} tx=${tx} ok=true status="success"\n[${tag}] done tx=${tx}\n`), 4000);
  });

/** Finished transfers so the history list has something to show. */
export const demoHistory = (now: number): BridgeTransfer[] => {
  const at = (hoursAgo: number): string => new Date(now - hoursAgo * 3600_000).toISOString();
  const base = { message: '', btcTxid: hex(), stacksTxid: `0x${hex()}` };
  return [
    {
      ...base,
      id: 'demo-4',
      kind: 'deposit',
      asset: 'usdc',
      status: 'done',
      amount: 1_500_000_000,
      createdAt: at(96),
      updatedAt: at(96),
      btcTxid: null,
      ethTxid: `0x${hex()}`,
      message: 'USDCx arrived.',
    },
    {
      ...base,
      id: 'demo-5',
      kind: 'withdraw',
      asset: 'usdc',
      status: 'done',
      amount: 250_000_000,
      received: 248_000_000,
      createdAt: at(12),
      updatedAt: at(11),
      btcTxid: null,
      ethTxid: `0x${hex()}`,
      ethAddress: ethAddressOf('0x1234567890abcdef1234567890abcdef12345678'),
      message: 'USDC sent.',
    },
    { ...base, id: 'demo-1', kind: 'deposit', asset: 'btc', status: 'done', amount: 2_500_000, createdAt: at(72), updatedAt: at(70), message: 'sBTC arrived.' },
    {
      ...base,
      id: 'demo-2',
      kind: 'withdraw',
      asset: 'btc',
      status: 'done',
      amount: 600_000,
      createdAt: at(30),
      updatedAt: at(29),
      btcAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      message: 'BTC sent.',
    },
    {
      ...base,
      id: 'demo-3',
      kind: 'deposit',
      asset: 'btc',
      status: 'failed',
      amount: 12_000,
      createdAt: at(6),
      updatedAt: at(5),
      stacksTxid: null,
      message: 'Rejected by signers. BTC can be reclaimed after about a week; see docs/RECOVERY.md.',
    },
  ];
};
