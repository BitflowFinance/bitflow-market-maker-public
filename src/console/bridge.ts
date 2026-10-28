// BTC <-> sBTC bridging for one bot wallet, kept in data/bridge.<bot>.json so a
// transfer survives a restart of the console. Deposits are watched rather than
// reported: the console finds the BTC at the deposit address and registers it
// with Emily (the signers' intake API) itself, so the user only has to send it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { pubKeyfromPrivKey, publicKeyToString } from '@stacks/transactions';
import { MAINNET, buildSbtcDepositAddress } from 'sbtc';

/** Signers' fee cap baked into the deposit script. They charge the actual sweep fee, never more than this. */
export const DEPOSIT_MAX_FEE_SATS = 80_000;
/** Bitcoin blocks (about a week) before BTC the signers never swept can be reclaimed with the bot key. */
export const RECLAIM_LOCK_BLOCKS = 950;
/** An address with nothing sent to it is still watched this long, in case BTC arrives late. */
const WATCH_MS = 30 * 24 * 3600_000;
const KEEP_TRANSFERS = 50;

// Vsizes the dapp uses to size the signers' fee: a deposit is swept with a
// taproot script-path input; a withdrawal adds an input and an output to their
// transaction. Doubled because the signers batch, so the rate can rise first.
const DEPOSIT_SWEEP_VBYTES = 150;
const WITHDRAW_VBYTES = 113;
const FEE_HEADROOM = 2;
// At today's 1-3 sat/vB the formula gives a few hundred sats, which a fee spike
// before the signers' next batch would outrun. The unused part of the cap is
// returned, so a floor costs nothing.
const WITHDRAW_FEE_FLOOR_SATS = 5_000;

export interface EmilyRecord {
  /** pending | reprocessing | accepted | confirmed | failed */
  status: string;
  message: string;
  btcTxid: string | null;
  stacksTxid: string | null;
  requestId: number | null;
}

export interface BridgeLimits {
  minDepositSats: number;
  maxWithdrawSats: number | null;
}

/** Network calls only, so the book can be tested without the chain. */
export interface BridgeClient {
  signersKey(): Promise<string>;
  utxos(address: string): Promise<Array<{ txid: string; vout: number; value: number; confirmed: boolean }>>;
  /** Hands Emily the deposit transaction. */
  register(deposit: { txid: string; vout: number; depositScript: string; reclaimScript: string }): Promise<EmilyRecord>;
  deposit(txid: string, vout: number): Promise<EmilyRecord | null>;
  withdrawal(sender: string, stacksTxid: string): Promise<EmilyRecord | null>;
  /** sat/vB the next block or two would take. */
  feeRate(): Promise<number>;
  limits(): Promise<BridgeLimits>;
}

export const noBridge: BridgeClient = {
  signersKey: () => Promise.reject(new Error('bridging is not connected')),
  utxos: () => Promise.resolve([]),
  register: () => Promise.reject(new Error('bridging is not connected')),
  deposit: () => Promise.resolve(null),
  withdrawal: () => Promise.resolve(null),
  feeRate: () => Promise.reject(new Error('bridging is not connected')),
  limits: () => Promise.resolve({ minDepositSats: 10_000, maxWithdrawSats: null }),
};

export interface DepositAddress {
  address: string;
  depositScript: string;
  reclaimScript: string;
  signersKey: string;
  reclaimKey: string;
  maxFeeSats: number;
  lockBlocks: number;
  createdAt: string;
}

export type TransferStatus = 'sending' | 'sent' | 'processing' | 'done' | 'failed';

export interface BridgeTransfer {
  id: string;
  kind: 'deposit' | 'withdraw';
  status: TransferStatus;
  amountSats: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  btcTxid: string | null;
  stacksTxid: string | null;
  depositAddress?: string;
  vout?: number;
  registered?: boolean;
  btcAddress?: string;
  maxFeeSats?: number;
  requestId?: number | null;
}

interface BridgeFile {
  addresses: DepositAddress[];
  transfers: BridgeTransfer[];
}

/** Wallets show a 33-byte compressed or 65-byte uncompressed key; sBTC wants the 32-byte x-only form. */
export const xOnlyKey = (raw: string): string => {
  const key = raw.trim().replace(/^0x/, '').toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/.test(key)) return key.slice(2);
  if (/^04[0-9a-f]{128}$/.test(key)) return key.slice(2, 66);
  if (/^[0-9a-f]{64}$/.test(key)) return key;
  return '';
};

/**
 * The bot's own key is the refund key, so a deposit can come from an exchange
 * that never shows its public key, and an unswept deposit stays recoverable
 * with the key the user already backed up.
 */
export const reclaimKeyOf = (signerKey: string): string => xOnlyKey(publicKeyToString(pubKeyfromPrivKey(signerKey.trim().replace(/^0x/, ''))));

export const buildDeposit = (stacksAddress: string, signersKey: string, reclaimKey: string, now: Date): DepositAddress => {
  const deposit = buildSbtcDepositAddress({
    network: MAINNET,
    stacksAddress,
    signersPublicKey: signersKey,
    reclaimPublicKey: reclaimKey,
    maxSignerFee: DEPOSIT_MAX_FEE_SATS,
    reclaimLockTime: RECLAIM_LOCK_BLOCKS,
  });
  return {
    address: deposit.address,
    depositScript: deposit.depositScript,
    reclaimScript: deposit.reclaimScript,
    signersKey,
    reclaimKey,
    maxFeeSats: DEPOSIT_MAX_FEE_SATS,
    lockBlocks: RECLAIM_LOCK_BLOCKS,
    createdAt: now.toISOString(),
  };
};

export const depositFeeOf = (satPerVb: number): number => Math.min(DEPOSIT_MAX_FEE_SATS, Math.ceil(satPerVb * DEPOSIT_SWEEP_VBYTES * FEE_HEADROOM));
/** What the signers' Bitcoin transaction is expected to cost this withdrawal, without headroom. */
export const withdrawCostOf = (satPerVb: number): number => Math.ceil(satPerVb * WITHDRAW_VBYTES);
export const withdrawFeeOf = (satPerVb: number): number => Math.max(WITHDRAW_FEE_FLOOR_SATS, Math.ceil(satPerVb * WITHDRAW_VBYTES * FEE_HEADROOM));

/** "0.0015" BTC to sats, or null when it is not a plain positive amount with at most 8 decimals. */
export const btcToSats = (raw: string): number | null => {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const sats = Number(whole) * 1e8 + Number(frac.padEnd(8, '0'));
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null;
};

const statusOfEmily = (record: EmilyRecord): TransferStatus => {
  if (record.status === 'confirmed') return 'done';
  if (record.status === 'failed') return 'failed';
  return 'processing';
};

/** One bot's bridge state and the steps that move each transfer along. */
export class BridgeBook {
  private data: BridgeFile;

  constructor(private file: string) {
    this.data = { addresses: [], transfers: [] };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BridgeFile>;
        this.data = { addresses: parsed.addresses || [], transfers: parsed.transfers || [] };
      } catch {
        // An unreadable file is set aside rather than overwritten: it may hold the
        // scripts of a deposit that still needs registering.
        renameSync(file, `${file}.bad-${Date.now()}`);
      }
    }
  }

  get transfers(): BridgeTransfer[] {
    return this.data.transfers;
  }

  /** The address to show: the newest one, unless the signers have rotated their key since. */
  current(signersKey: string | null): DepositAddress | null {
    const latest = this.data.addresses[this.data.addresses.length - 1] || null;
    if (!latest || (signersKey && latest.signersKey !== signersKey)) return null;
    return latest;
  }

  latestAddress(): DepositAddress | null {
    return this.data.addresses[this.data.addresses.length - 1] || null;
  }

  /** Demo mode's made-up history. */
  seed(transfers: BridgeTransfer[]): void {
    this.data.transfers.push(...transfers);
    this.save();
  }

  addAddress(address: DepositAddress): void {
    if (!this.data.addresses.some((item) => item.address === address.address)) this.data.addresses.push(address);
    this.save();
  }

  get active(): boolean {
    return this.watched(Date.now()).length > 0 || this.data.transfers.some((t) => t.status !== 'done' && t.status !== 'failed');
  }

  private watched(nowMs: number): DepositAddress[] {
    // Kept on watch while new, or while BTC sent to it is still on its way through.
    return this.data.addresses.filter(
      (item) =>
        nowMs - Date.parse(item.createdAt) < WATCH_MS ||
        this.data.transfers.some((t) => t.depositAddress === item.address && t.status !== 'done' && t.status !== 'failed'),
    );
  }

  addWithdrawal(input: { amountSats: number; btcAddress: string; maxFeeSats: number }, now: Date): BridgeTransfer {
    const transfer: BridgeTransfer = {
      id: `wd-${now.getTime()}`,
      kind: 'withdraw',
      status: 'sending',
      amountSats: input.amountSats,
      message: 'Signing the request.',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      btcTxid: null,
      stacksTxid: null,
      btcAddress: input.btcAddress,
      maxFeeSats: input.maxFeeSats,
      requestId: null,
    };
    this.data.transfers.push(transfer);
    this.save();
    return transfer;
  }

  update(id: string, patch: Partial<BridgeTransfer>, now: Date): void {
    const transfer = this.data.transfers.find((item) => item.id === id);
    if (!transfer) return;
    Object.assign(transfer, patch, { updatedAt: now.toISOString() });
    this.save();
  }

  /** Finds new deposits, registers them, and follows every open transfer. Network errors leave a transfer as it was. */
  async sync(client: BridgeClient, sender: string, now: Date): Promise<void> {
    for (const address of this.watched(now.getTime())) {
      const found = await client.utxos(address.address).catch(() => []);
      for (const utxo of found) {
        const id = `dep-${utxo.txid}-${utxo.vout}`;
        if (this.data.transfers.some((item) => item.id === id)) continue;
        this.data.transfers.push({
          id,
          kind: 'deposit',
          status: 'sent',
          amountSats: utxo.value,
          message: 'BTC detected.',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          btcTxid: utxo.txid,
          stacksTxid: null,
          depositAddress: address.address,
          vout: utxo.vout,
          registered: false,
        });
        this.save();
      }
    }
    for (const transfer of this.data.transfers) {
      if (transfer.status === 'done' || transfer.status === 'failed') continue;
      if (transfer.kind === 'deposit') await this.followDeposit(client, transfer, now);
      else if (transfer.status === 'processing' && transfer.stacksTxid) await this.followWithdrawal(client, sender, transfer, now);
    }
  }

  private async followDeposit(client: BridgeClient, transfer: BridgeTransfer, now: Date): Promise<void> {
    const txid = transfer.btcTxid || '';
    const vout = transfer.vout ?? 0;
    try {
      let record = await client.deposit(txid, vout);
      if (!record && !transfer.registered) {
        const address = this.data.addresses.find((item) => item.address === transfer.depositAddress);
        if (!address) return;
        record = await client.register({ txid, vout, depositScript: address.depositScript, reclaimScript: address.reclaimScript });
      }
      if (!record) return;
      const status = statusOfEmily(record);
      const message =
        status === 'done'
          ? 'sBTC arrived.'
          : status === 'failed'
            ? 'Rejected by signers. BTC can be reclaimed after about a week; see docs/RECOVERY.md.'
            : record.status === 'accepted'
              ? 'Minting sBTC.'
              : 'Waiting for the BTC to confirm.';
      if (status !== transfer.status || message !== transfer.message || !transfer.registered || record.stacksTxid !== transfer.stacksTxid) {
        this.update(transfer.id, { status, message, registered: true, stacksTxid: record.stacksTxid || transfer.stacksTxid }, now);
      }
    } catch (err) {
      // Emily refuses a transaction it cannot see in the mempool yet; the next pass
      // retries, and the reason stays visible in case it is not that.
      if (transfer.registered) return;
      const message = `Retrying registration (${(err as Error).message}).`;
      if (message !== transfer.message) this.update(transfer.id, { message }, now);
    }
  }

  private async followWithdrawal(client: BridgeClient, sender: string, transfer: BridgeTransfer, now: Date): Promise<void> {
    try {
      const record = await client.withdrawal(sender, transfer.stacksTxid || '');
      if (!record) return;
      const status = statusOfEmily(record);
      const message =
        status === 'done'
          ? 'BTC sent.'
          : status === 'failed'
            ? 'Not processed by signers. The sBTC goes back to the bot wallet.'
            : 'Waiting for the signers to send BTC.';
      if (status !== transfer.status || message !== transfer.message || record.btcTxid !== transfer.btcTxid) {
        this.update(transfer.id, { status, message, btcTxid: record.btcTxid || transfer.btcTxid, requestId: record.requestId ?? transfer.requestId }, now);
      }
    } catch {
      // Emily lists a request a few blocks after it confirms; the next pass retries.
    }
  }

  private save(): void {
    const done = this.data.transfers.filter((t) => t.status === 'done' || t.status === 'failed');
    if (done.length > KEEP_TRANSFERS) {
      const drop = new Set(done.slice(0, done.length - KEEP_TRANSFERS).map((t) => t.id));
      this.data.transfers = this.data.transfers.filter((t) => !drop.has(t.id));
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
