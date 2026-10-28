import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { walletFromPrivateKey, WalletMaterial } from './wallet';

// The derivation Stacks wallets use for account N (Leather and Xverse show it as
// "Account N+1"), so a phrase made here restores there with the same addresses.
const accountPath = (index: number): string => `m/44'/5757'/0'/0/${index}`;

export const MAX_ACCOUNT = 99;

/** 24 words, the length Stacks wallets create. */
export const newPhrase = (): string => generateMnemonic(wordlist, 256);

/** Lowercase, single-spaced, so a pasted phrase with stray spacing still matches. */
export const normalizePhrase = (raw: string): string => raw.trim().toLowerCase().split(/\s+/).join(' ');

export const isPhrase = (raw: string): boolean => {
  const phrase = normalizePhrase(raw);
  const words = phrase.split(' ').length;
  return (words === 12 || words === 24) && validateMnemonic(phrase, wordlist);
};

/** The key and address for one account of a phrase. */
export const accountOf = (phrase: string, index: number): WalletMaterial => {
  if (!Number.isInteger(index) || index < 0 || index > MAX_ACCOUNT) throw new Error(`Account must be 0 to ${MAX_ACCOUNT}.`);
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizePhrase(phrase))).derive(accountPath(index));
  if (!node.privateKey) throw new Error('Could not derive that account.');
  // The trailing 01 marks a compressed public key, the form Stacks keys use.
  return walletFromPrivateKey(`${Buffer.from(node.privateKey).toString('hex')}01`);
};
