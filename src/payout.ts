import { validateStacksAddress } from '@stacks/transactions';

// Kept free of CONFIG so the local console can validate a payout address
// without loading a bot env file (config.ts reads dotenv on import).

// STX transfer memos and SIP-010 `(optional (buff 34))` memos share this cap.
export const MEMO_MAX_BYTES = 34;

/** Empty string when `to` is a usable payout address; otherwise one sentence saying why not. */
export const checkPayoutAddress = (to: string, signer: string, mainnet = true): string => {
  const address = to.trim();
  if (!address) return 'Enter a Stacks address.';
  // Contract principals can receive tokens, but a mistyped contract name strands
  // the funds with no owner key, so cash-out only pays a standard address.
  if (address.includes('.')) return 'Use a wallet address, not a contract.';
  if (!validateStacksAddress(address)) return 'That is not a valid Stacks address.';
  const prefix = address.slice(0, 2);
  if (mainnet && prefix !== 'SP' && prefix !== 'SM') return 'Use a mainnet address (starts with SP or SM).';
  if (!mainnet && prefix !== 'ST' && prefix !== 'SN') return 'Use a testnet address (starts with ST or SN).';
  if (signer && address === signer) return 'That is the bot’s own wallet. Use your own address.';
  return '';
};

/** Empty string when the memo fits; otherwise one sentence saying why not. */
export const checkMemo = (memo: string): string => {
  if (!memo) return '';
  if (!/^[\x20-\x7e]*$/.test(memo)) return 'The memo can only use plain letters, numbers, and symbols.';
  if (Buffer.byteLength(memo, 'utf8') > MEMO_MAX_BYTES) return `The memo is at most ${MEMO_MAX_BYTES} characters.`;
  return '';
};

/** STX left to send once this transaction's fee is paid from the same balance. */
export const stxSweepAmount = (balance: bigint, fee: bigint): bigint =>
  balance > fee ? balance - fee : BigInt(0);
