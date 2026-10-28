import { hexToCV } from '@stacks/transactions';
import { keccak_256 } from '@noble/hashes/sha3';
import { EthDeposit, UsdcClient } from './bridge';
import { MIN_WITHDRAW_MICRO, USDCX_BRIDGE, USDCX_TOKEN, USDCX_ASSET, USDC_ETHEREUM, XRESERVE } from '../usdcx';

const HIRO = 'https://api.hiro.so';
// publicnode serves eth_getLogs over ~5000 blocks without a key, which covers a
// payout's hour many times over. ETH_RPC_URL swaps in your own node.
const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';
const LOG_WINDOW = 4000;
const MIN_FRESH_MS = 10 * 60_000;
const MINT_PAGE = 50;

const topic = (signature: string): string => `0x${Buffer.from(keccak_256(signature)).toString('hex')}`;
// Indexed: localToken, depositor, remoteRecipient; the data holds value, remoteDomain, remoteToken, maxFee, hookData.
const DEPOSIT_TOPIC = topic('DepositedToRemote(address,uint256,address,bytes32,uint32,bytes32,uint256,bytes)');
const TRANSFER_TOPIC = topic('Transfer(address,address,uint256)');
const word = (address: string): string => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const ZERO_WORD = word('0x0');

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
}

const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
};

/** The xReserve deposit event of a receipt, read as the fields tracking needs. */
export const depositOfLogs = (logs: RpcLog[]): EthDeposit | null => {
  const log = logs.find((item) => item.address.toLowerCase() === XRESERVE.toLowerCase() && item.topics[0] === DEPOSIT_TOPIC);
  if (!log || log.topics[1] !== word(USDC_ETHEREUM)) return null;
  const words = log.data.replace(/^0x/, '').match(/.{64}/g) || [];
  return { ok: true, recipient: log.topics[3], value: Number(BigInt(`0x${words[0]}`)), domain: Number(BigInt(`0x${words[1]}`)) };
};

export const liveUsdcClient = (rpcUrl = process.env.ETH_RPC_URL || DEFAULT_RPC): UsdcClient => {
  let id = 0;
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const body = await getJson<{ result?: T; error?: { message: string } }>(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  };
  const head = async (): Promise<number> => Number(await rpc<string>('eth_blockNumber', []));
  let min: { at: number; value: number } | null = null;

  return {
    ethHead: head,
    deposit: async (ethTxid) => {
      const receipt = await rpc<{ status: string; logs: RpcLog[] } | null>('eth_getTransactionReceipt', [ethTxid]);
      if (!receipt) return null;
      if (receipt.status !== '0x1') return { ok: false };
      // Mined, but not an xReserve USDC deposit at all (a stray approve, say).
      return depositOfLogs(receipt.logs) || { ok: false };
    },
    findMint: async (stacksAddress, amount, sinceMs, skip) => {
      const res = await getJson<{
        results: Array<{ tx_id: string; event_type: string; asset?: { asset_event_type?: string; asset_id?: string; recipient?: string; amount?: string } }>;
      }>(`${HIRO}/extended/v1/address/${stacksAddress}/assets?limit=${MINT_PAGE}`);
      const asset = `${USDCX_TOKEN}::${USDCX_ASSET}`;
      for (const event of res.results) {
        const a = event.asset;
        if (!a || a.asset_event_type !== 'mint' || a.asset_id !== asset || a.recipient !== stacksAddress) continue;
        if (Number(a.amount) !== amount || skip.includes(event.tx_id)) continue;
        // An older mint of the same amount is an earlier deposit, not this one.
        const tx = await getJson<{ block_time?: number }>(`${HIRO}/extended/v1/tx/${event.tx_id}`);
        if ((tx.block_time || 0) * 1000 >= sinceMs) return event.tx_id;
      }
      return null;
    },
    findPayout: async (ethAddress, fromBlock, minValue, maxValue, skip) => {
      const latest = await head();
      const logs = await rpc<RpcLog[]>('eth_getLogs', [
        {
          address: USDC_ETHEREUM,
          // Circle pays out by minting fresh USDC to the recipient.
          topics: [TRANSFER_TOPIC, ZERO_WORD, word(ethAddress)],
          fromBlock: `0x${Math.max(fromBlock, latest - LOG_WINDOW).toString(16)}`,
          toBlock: 'latest',
        },
      ]);
      for (const log of logs) {
        const value = Number(BigInt(log.data));
        if (value >= minValue && value <= maxValue && !skip.includes(log.transactionHash)) return { ethTxid: log.transactionHash, value };
      }
      return null;
    },
    minWithdraw: async () => {
      if (min && Date.now() - min.at < MIN_FRESH_MS) return min.value;
      const [deployer, name] = USDCX_BRIDGE.split('.');
      const res = await getJson<{ okay: boolean; result?: string }>(`${HIRO}/v2/contracts/call-read/${deployer}/${name}/get-min-withdrawal-amount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: deployer, arguments: [] }),
      });
      const cv = res.okay && res.result ? (hexToCV(res.result) as { value?: bigint }) : null;
      const value = cv && typeof cv.value === 'bigint' ? Number(cv.value) : MIN_WITHDRAW_MICRO;
      min = { at: Date.now(), value };
      return value;
    },
  };
};
