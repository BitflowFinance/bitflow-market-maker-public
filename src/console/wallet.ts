import { getAddressFromPrivateKey, makeRandomPrivKey, privateKeyToString, TransactionVersion } from '@stacks/transactions';

export interface WalletMaterial {
  address: string;
  key: string;
}

const normalizeKey = (raw: string): string => raw.trim().replace(/^0x/, '');

export const walletFromPrivateKey = (raw: string): WalletMaterial => {
  const key = normalizeKey(raw);
  if (!/^[0-9a-fA-F]{64}(01)?$/.test(key)) {
    throw new Error('That private key is not a 32-byte hex Stacks key.');
  }
  let address = '';
  try {
    address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
  } catch (err) {
    throw new Error(`Could not read that private key (${(err as Error).message}).`);
  }
  if (!address.startsWith('SP')) {
    throw new Error('That key does not derive a mainnet Stacks address.');
  }
  return { address, key };
};

export const createWallet = (): WalletMaterial => walletFromPrivateKey(privateKeyToString(makeRandomPrivKey()));
