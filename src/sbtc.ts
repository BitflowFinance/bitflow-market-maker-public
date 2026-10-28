// sBTC peg constants and the Bitcoin-address encoding its withdrawal contract
// takes. Kept free of config.ts so the console can share it without loading an
// env file.
import { Address, NETWORK } from '@scure/btc-signer';

export const SBTC_DEPLOYER = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4';
export const SBTC_TOKEN = `${SBTC_DEPLOYER}.sbtc-token`;
export const SBTC_ASSET = 'sbtc-token';
export const SBTC_WITHDRAWAL = `${SBTC_DEPLOYER}.sbtc-withdrawal`;

/** Below this the BTC the signers send is mostly fee; the contract's own floor is dust. */
export const MIN_WITHDRAW_SATS = 10_000;
/** Fallback cap on the signers' fee for a withdrawal, used when the fee rate cannot be read. */
export const MAX_WITHDRAW_FEE_SATS = 80_000;

export interface BtcRecipient {
  version: Uint8Array;
  hashbytes: Uint8Array;
}

// The version byte is the contract's own enumeration of output types, not a
// Bitcoin address version.
const VERSION: Record<string, number> = { pkh: 0x00, sh: 0x01, wpkh: 0x04, wsh: 0x05, tr: 0x06 };

/** A mainnet Bitcoin address as the withdrawal contract's recipient tuple. Throws on anything else. */
export const btcRecipientOf = (raw: string): BtcRecipient => {
  let decoded: { type: string; hash?: Uint8Array; pubkey?: Uint8Array };
  try {
    decoded = Address(NETWORK).decode(raw.trim()) as typeof decoded;
  } catch {
    throw new Error('That is not a Bitcoin mainnet address (bc1…, 1… or 3…).');
  }
  const version = VERSION[decoded.type];
  const hashbytes = decoded.type === 'tr' ? decoded.pubkey : decoded.hash;
  if (version === undefined || !hashbytes) throw new Error('That kind of Bitcoin address cannot receive sBTC withdrawals.');
  return { version: Uint8Array.of(version), hashbytes };
};

export const isBtcAddress = (raw: string): boolean => {
  try {
    btcRecipientOf(raw);
    return true;
  } catch {
    return false;
  }
};
