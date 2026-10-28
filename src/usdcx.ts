// USDCx (Circle xReserve) constants and the address encodings each side of the
// bridge takes. Kept free of config.ts so the console can share it without
// loading an env file.
import { keccak_256 } from '@noble/hashes/sha3';
import { createAddress } from '@stacks/transactions';

export const USDCX_DEPLOYER = 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE';
export const USDCX_TOKEN = `${USDCX_DEPLOYER}.usdcx`;
export const USDCX_ASSET = 'usdcx-token';
export const USDCX_BRIDGE = `${USDCX_DEPLOYER}.usdcx-v1`;

/** Circle's domain ids: where a burn pays out, and where a deposit mints. */
export const ETHEREUM_DOMAIN = 0;
export const STACKS_DOMAIN = 10003;
export const XRESERVE = '0x8888888199b2Df864bf678259607d6D5EBb4e3Ce';
export const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/** Circle's per-deposit floor for Stacks. Stacks' relayer mints for free, so the bot needs no STX to receive. */
export const MIN_DEPOSIT_MICRO = 10_000_000;
/** The contract's own floor (`get-min-withdrawal-amount`), used when it cannot be read. */
export const MIN_WITHDRAW_MICRO = 4_800_000;
/**
 * Circle takes this off every Ethereum payout (1.00 gas + 1.00 forwarding). It
 * is not on-chain anywhere the console can read, so a change shows up as a
 * payout that is a little off; tracking allows for that.
 */
export const WITHDRAW_FEE_MICRO = 2_000_000;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** EIP-55 checksum form of 40 hex digits. */
const checksummed = (lower: string): string => {
  const hash = hex(keccak_256(lower));
  return `0x${[...lower].map((ch, i) => (parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('')}`;
};

/**
 * An Ethereum address in checksum form. All-lower and all-upper are accepted as
 * typed; mixed case must carry a valid checksum, since a typo there would
 * otherwise send USDC nowhere.
 */
export const ethAddressOf = (raw: string): string => {
  const text = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error('That is not an Ethereum address (0x and 40 hex characters).');
  const body = text.slice(2);
  const sum = checksummed(body.toLowerCase());
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && sum !== text) {
    throw new Error('That Ethereum address has a typo (its checksum does not match).');
  }
  return sum;
};

export const isEthAddress = (raw: string): boolean => {
  try {
    ethAddressOf(raw);
    return true;
  } catch {
    return false;
  }
};

/** `burn`'s native-recipient: the 20-byte address left-padded to 32. */
export const ethRecipientOf = (address: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(ethAddressOf(address).slice(2), 'hex'), 12);
  return out;
};

/**
 * `depositToRemote`'s remoteRecipient for a Stacks address: 11 zero bytes, the
 * version byte, then the hash160. usdcx-v1 decodes exactly this shape when it
 * mints, so anything else would strand the deposit.
 */
export const stacksRecipientOf = (stacksAddress: string): string => {
  const address = createAddress(stacksAddress);
  return `0x${'00'.repeat(11)}${address.version.toString(16).padStart(2, '0')}${address.hash160}`;
};

/** "12.5" USDC to micro-units, or null when it is not a plain positive amount with at most 6 decimals. */
export const usdcToMicro = (raw: string): number | null => {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const micro = Number(whole) * 1e6 + Number(frac.padEnd(6, '0'));
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
};
