import { MAINNET, SbtcApiClientMainnet, buildSbtcDepositAddress } from 'sbtc';
import { BridgeClient, BridgeInput, BridgeJob } from './store';

/** Bridging is parked until it is ready to ship. Turning this on exposes /api/bridge again; the page has no entry point yet. */
export const BRIDGE_ENABLED = false;

export const DIRECTIONS = ['btc_to_sbtc', 'sbtc_to_btc', 'usdc_to_usdcx', 'usdcx_to_usdc'];
/** Directions the page can actually carry out today. The rest are refused before anything is sent. */
export const AVAILABLE_DIRECTIONS = ['btc_to_sbtc'];

const MAX_SIGNER_FEE_SATS = 80_000;
export const MIN_DEPOSIT_BTC = 0.001;

interface DepositJob extends BridgeJob {
  depositScript?: string;
  reclaimScript?: string;
}

const job = (input: BridgeInput, status: string, message: string, depositAddress: string | null): DepositJob => ({
  id: '',
  botId: input.botId,
  pair: '',
  direction: input.direction,
  amount: input.amount,
  status,
  message,
  depositAddress,
  stacksAddress: input.stacksAddress,
});

/** Wallets show either a 33-byte compressed key or the 32-byte x-only key. sBTC wants x-only. */
export const xOnlyKey = (raw: string): string => {
  const key = raw.trim().replace(/^0x/, '').toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/.test(key)) return key.slice(2);
  if (/^[0-9a-f]{64}$/.test(key)) return key;
  return '';
};

export const checkBridgeInput = (input: BridgeInput): string => {
  if (DIRECTIONS.indexOf(input.direction) < 0) return 'Pick a bridge direction.';
  if (AVAILABLE_DIRECTIONS.indexOf(input.direction) < 0) {
    return 'This direction is not built into the page yet. Nothing was sent.';
  }
  if (!/^\d+(\.\d+)?$/.test(input.amount.trim()) || Number(input.amount) <= 0) return 'Enter an amount greater than 0.';
  if (input.direction === 'btc_to_sbtc') {
    if (Number(input.amount) < MIN_DEPOSIT_BTC) {
      return `Deposit at least ${MIN_DEPOSIT_BTC} BTC. The signers may keep up to ${MAX_SIGNER_FEE_SATS.toLocaleString('en-US')} sats as a fee.`;
    }
    if (!xOnlyKey(input.reclaimPublicKey)) {
      return 'Enter the public key of the Bitcoin wallet you are sending from (66 or 64 hex characters). This is a public key, not a private key.';
    }
  }
  return '';
};

/**
 * Official sBTC deposit: build the signers' taproot address for this bot's
 * Stacks wallet, then tell Emily once the bitcoin transaction is in the
 * mempool. The Stacks private key is never read here.
 */
export const liveBridgeClient = (): BridgeClient => ({
  prepare: async (input) => {
    const problem = checkBridgeInput(input);
    if (problem) return job(input, 'failed', problem, null);
    try {
      const client = new SbtcApiClientMainnet();
      const signersPublicKey = await client.fetchSignersPublicKey();
      const deposit = buildSbtcDepositAddress({
        stacksAddress: input.stacksAddress,
        signersPublicKey,
        reclaimPublicKey: xOnlyKey(input.reclaimPublicKey),
        network: MAINNET,
        maxSignerFee: MAX_SIGNER_FEE_SATS,
      });
      const out = job(
        input,
        'needs_deposit',
        `Send exactly ${input.amount} BTC to this address from the wallet that owns the public key you entered. sBTC is minted to the bot’s wallet after one or two Bitcoin confirmations.`,
        deposit.address,
      );
      out.depositScript = deposit.depositScript;
      out.reclaimScript = deposit.reclaimScript;
      return out;
    } catch (err) {
      return job(input, 'failed', `Could not build an sBTC deposit address (${(err as Error).message}). Nothing was sent.`, null);
    }
  },
  notify: async (current, txid) => {
    const extra = current as DepositJob;
    if (!extra.depositScript || !extra.reclaimScript) {
      return { ...current, status: 'failed', message: 'This transfer has no deposit script. Start a new deposit.' };
    }
    try {
      const client = new SbtcApiClientMainnet();
      const transaction = await client.fetchTxHex(txid);
      const res = await client.notifySbtc({
        transaction,
        depositScript: extra.depositScript,
        reclaimScript: extra.reclaimScript,
      });
      return {
        ...current,
        status: 'pending',
        message: `The sBTC signers have the deposit (${res.status}). sBTC usually arrives after one or two Bitcoin confirmations.`,
      };
    } catch (err) {
      return {
        ...current,
        status: 'needs_deposit',
        message: `The signers did not accept that transaction yet (${(err as Error).message}). If you just sent it, wait a minute and try again.`,
      };
    }
  },
});
