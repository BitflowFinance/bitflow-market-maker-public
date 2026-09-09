import {
  AnchorMode,
  ClarityValue,
  PostCondition,
  PostConditionMode,
  TransactionVersion,
  broadcastTransaction,
  getAddressFromPrivateKey,
  makeContractCall,
  validateStacksAddress,
} from '@stacks/transactions';
import { CONFIG } from './config';
import { logDebug, logInfo, logWarn } from './logger';
import { fetchJson, getNetwork, microToString, parseContract } from './stacks';

const TAG = 'wallet';

const apiBase = (): string =>
  (CONFIG.STACKS_NODE_URL || 'https://api.hiro.so').replace(/\/$/, '');

export const isValidStacksAddress = (address: string): boolean => {
  if (!address) return false;
  const [addr] = address.split('.');
  return validateStacksAddress(addr);
};

export const isValidTxId = (txId: string): boolean => {
  const id = txId.startsWith('0x') ? txId.slice(2) : txId;
  return /^[0-9a-fA-F]{64}$/.test(id);
};

export const getSignerAddress = (): string => {
  const address = CONFIG.SIGNER_ADDRESS;
  if (!isValidStacksAddress(address)) {
    throw new Error(`SIGNER_ADDRESS invalid or unset ("${address}")`);
  }
  return address;
};

// Guards against a misconfigured wallet: we read nonce/balance and build post-
// conditions for SIGNER_ADDRESS but sign with SIGNER_KEY. If they don't match,
// every tx would act on the wrong account. Derive the address from the key and
// require it equal SIGNER_ADDRESS before signing anything.
export const assertSignerKeyMatchesAddress = (): void => {
  if (!CONFIG.SIGNER_KEY) throw new Error('SIGNER_KEY not set');
  const configured = getSignerAddress();
  const version =
    String(CONFIG.STACKS_NETWORK_VERSION || 'mainnet').toLowerCase() === 'mainnet'
      ? TransactionVersion.Mainnet
      : TransactionVersion.Testnet;
  let derived: string;
  try {
    derived = getAddressFromPrivateKey(CONFIG.SIGNER_KEY, version);
  } catch (err) {
    throw new Error(`SIGNER_KEY is not a valid private key: ${(err as Error).message}`);
  }
  if (derived !== configured) {
    throw new Error(
      `SIGNER_KEY/SIGNER_ADDRESS mismatch: key derives ${derived} but SIGNER_ADDRESS is ${configured}; refusing to sign`,
    );
  }
};

export interface AccountBalances {
  stx: bigint;
  tokens: Record<string, { balance: bigint; sent: bigint; received: bigint }>;
}

const toBig = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? '0'));
  } catch {
    return BigInt(0);
  }
};

export const getAccountBalances = async (address: string): Promise<AccountBalances> => {
  const data = await fetchJson<{
    stx?: { balance?: string };
    fungible_tokens?: Record<string, { balance?: string; total_sent?: string; total_received?: string }>;
  }>(`${apiBase()}/extended/v1/address/${address}/balances`, CONFIG.STACKS_NODE_KEY);

  const tokens: AccountBalances['tokens'] = {};
  for (const [id, t] of Object.entries(data.fungible_tokens || {})) {
    tokens[id] = {
      balance: toBig(t.balance),
      sent: toBig(t.total_sent),
      received: toBig(t.total_received),
    };
  }
  return { stx: toBig(data.stx?.balance), tokens };
};

export interface NonceInfo {
  nextNonce: number;
  // A tx of ours is in the mempool but not yet mined (last mempool nonce is
  // ahead of the last executed nonce). Starting a new plan now would queue
  // behind it and pile up nonces.
  mempoolPending: boolean;
  // Nonces the node sees as missing (a gap). New txs at higher nonces can't be
  // mined until the gap is filled, so this needs manual attention.
  missingNonces: number[];
}

export const getNonceInfo = async (address: string): Promise<NonceInfo> => {
  const data = await fetchJson<{
    last_executed_tx_nonce?: number;
    last_mempool_tx_nonce?: number | null;
    possible_next_nonce?: number;
    detected_missing_nonces?: number[];
  }>(`${apiBase()}/extended/v1/address/${address}/nonces`, CONFIG.STACKS_NODE_KEY);

  const missingNonces = data.detected_missing_nonces ?? [];
  const lastExecuted =
    typeof data.last_executed_tx_nonce === 'number' ? data.last_executed_tx_nonce : -1;
  const lastMempool =
    typeof data.last_mempool_tx_nonce === 'number' ? data.last_mempool_tx_nonce : null;
  const mempoolPending = lastMempool !== null && lastMempool > lastExecuted;

  let nextNonce: number;
  if (missingNonces.length > 0) {
    nextNonce = Math.min(...missingNonces);
  } else if (typeof data.possible_next_nonce === 'number') {
    nextNonce = data.possible_next_nonce;
  } else {
    throw new Error('failed to resolve next nonce');
  }
  return { nextNonce, mempoolPending, missingNonces };
};

// Base fee for a contract call. Primary source is the live mempool fee
// distribution for contract calls (what txs are actually paying) at a
// configurable percentile. Stacks' mempool is thin, so a few whale txs skew p50+
// badly (observed p50=0.25 STX, p75/p95=2101 STX from one large transfer) while
// p25 holds the true ~0.001 STX rate -- robustFee() caps the chosen percentile at
// FEE_OUTLIER_MULTIPLE x p25 to discard that skew. Falls back to the /v2 estimate
// (same de-skew), then DEFAULT. Clamped to [MIN, MAX]; replace-by-fee covers any
// remaining shortfall.
type FeePercentiles = {
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  p95?: number | null;
};

// Pick the configured percentile but reject a sparse-mempool outlier by capping
// it at FEE_OUTLIER_MULTIPLE x the (stable) p25 anchor. During broad congestion
// every percentile rises together so the cap rises with them; during pure whale
// skew p25 stays low and the cap discards the spike. Returns micro-STX, or null
// when the data is unusable so the caller falls through to the next source.
export const robustFee = (cc: FeePercentiles, percentile: string): number | null => {
  const chosen = cc[percentile as keyof FeePercentiles];
  if (typeof chosen !== 'number' || !(chosen > 0)) return null;
  const anchor = cc.p25;
  if (CONFIG.FEE_OUTLIER_MULTIPLE > 0 && typeof anchor === 'number' && anchor > 0) {
    return Math.min(chosen, anchor * CONFIG.FEE_OUTLIER_MULTIPLE);
  }
  return chosen;
};

export const estimateFee = async (): Promise<bigint> => {
  const min = BigInt(CONFIG.MIN_TX_FEE_USTX);
  const max = BigInt(CONFIG.MAX_TX_FEE_USTX);
  const clamp = (v: bigint): bigint => (v < min ? min : v > max ? max : v);

  try {
    const stats = await fetchJson<{
      tx_simple_fee_averages?: { contract_call?: FeePercentiles };
    }>(`${apiBase()}/extended/v1/tx/mempool/stats`, CONFIG.STACKS_NODE_KEY);
    const cc = stats.tx_simple_fee_averages?.contract_call;
    const fee = cc ? robustFee(cc, CONFIG.FEE_MEMPOOL_PERCENTILE) : null;
    if (fee !== null) return clamp(BigInt(Math.ceil(fee)));
  } catch (err) {
    logDebug(`[${TAG}] mempool stats fetch failed error="${(err as Error).message}" -> trying fee estimate`);
  }

  try {
    const data = await fetchJson<{
      contract_call?: {
        no_priority?: number;
        low_priority?: number;
        medium_priority?: number;
        high_priority?: number;
      };
    }>(`${apiBase()}/extended/v2/mempool/fees`, CONFIG.STACKS_NODE_KEY);
    const cc = data.contract_call;
    // Map the priority tiers onto the same percentile shape (no_priority is the
    // stable p25 anchor) so the de-skew cap applies to this source too.
    const tiers: FeePercentiles = {
      p25: cc?.no_priority,
      p50: cc?.low_priority,
      p75: cc?.medium_priority,
      p95: cc?.high_priority,
    };
    const fee = cc ? robustFee(tiers, CONFIG.FEE_MEMPOOL_PERCENTILE) : null;
    if (fee !== null) return clamp(BigInt(Math.ceil(fee)));
  } catch (err) {
    logDebug(`[${TAG}] fee estimate fetch failed error="${(err as Error).message}" -> using default`);
  }

  return clamp(BigInt(CONFIG.DEFAULT_TX_FEE_USTX));
};

export const getTransaction = async (txId: string): Promise<{ tx_status?: string } | null> => {
  const id = txId.startsWith('0x') ? txId.slice(2) : txId;
  try {
    return await fetchJson<{ tx_status?: string }>(
      `${apiBase()}/extended/v1/tx/0x${id}`,
      CONFIG.STACKS_NODE_KEY,
    );
  } catch {
    return null;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isAbort = (status?: string): boolean => Boolean(status && status.startsWith('abort'));

// Polls every candidate tx id (the original plus any replace-by-fee resubmits,
// which share the nonce) until one reaches a terminal state or the budget runs
// out. 'dropped_replace_by_fee' on a superseded tx is ignored.
const pollOutcome = async (
  txIds: string[],
  deadlineMs: number,
): Promise<{ resolved: boolean; ok: boolean; txId: string; status: string }> => {
  while (Date.now() < deadlineMs) {
    for (const txId of txIds) {
      const tx = await getTransaction(txId);
      const status = tx?.tx_status ?? '';
      if (status === 'success') return { resolved: true, ok: true, txId, status };
      if (isAbort(status)) return { resolved: true, ok: false, txId, status };
    }
    await sleep(CONFIG.TX_POLL_INTERVAL_MS);
  }
  return { resolved: false, ok: false, txId: txIds[txIds.length - 1] ?? '', status: 'timeout' };
};

export interface SubmitResult {
  ok: boolean;
  txId: string;
  status: string;
  fee: bigint;
  bumps: number;
}

// Broadcasts via `submit(fee)`, waits for confirmation, and if the tx is still
// pending after the timeout, re-broadcasts at the same nonce with a higher fee
// (replace-by-fee) up to TX_MAX_FEE_BUMPS times. `submit` must sign with a fixed
// nonce so each resubmit replaces the previous one.
export const submitWithConfirmation = async (
  submit: (fee: bigint) => Promise<string>,
  baseFee: bigint,
  label: string,
): Promise<SubmitResult> => {
  const maxFee = BigInt(CONFIG.MAX_TX_FEE_USTX);
  let fee = baseFee > maxFee ? maxFee : baseFee;
  const txIds: string[] = [];

  let txId = await submit(fee);
  txIds.push(txId);
  logInfo(`[${TAG}] ${label} broadcast tx=${txId} fee=${microToString(fee)}`);

  for (let bump = 0; ; bump++) {
    const outcome = await pollOutcome(txIds, Date.now() + CONFIG.TX_CONFIRMATION_TIMEOUT_MS);
    if (outcome.resolved) {
      return { ok: outcome.ok, txId: outcome.txId, status: outcome.status, fee, bumps: bump };
    }
    if (bump >= CONFIG.TX_MAX_FEE_BUMPS) {
      return { ok: false, txId, status: 'timeout', fee, bumps: bump };
    }
    const next = BigInt(Math.ceil(Number(fee) * CONFIG.TX_FEE_BUMP_MULTIPLIER));
    const bumped = next > maxFee ? maxFee : next;
    if (bumped <= fee) {
      return { ok: false, txId, status: 'timeout_max_fee', fee, bumps: bump };
    }
    fee = bumped;
    logInfo(
      `[${TAG}] ${label} still pending; replace-by-fee attempt ${bump + 1} new_fee=${microToString(fee)}`,
    );
    try {
      txId = await submit(fee);
      txIds.push(txId);
    } catch (err) {
      // The resubmit can fail if the original confirmed in the gap (its nonce is
      // now used). Re-check the txs we already broadcast before declaring failure
      // so a confirmed original isn't reported as a failure.
      logWarn(
        `[${TAG}] ${label} replace-by-fee resubmit failed error="${(err as Error).message}"; re-checking prior txs`,
      );
      const recheck = await pollOutcome(txIds, Date.now() + CONFIG.TX_POLL_INTERVAL_MS * 2);
      if (recheck.resolved) {
        return { ok: recheck.ok, txId: recheck.txId, status: recheck.status, fee, bumps: bump + 1 };
      }
      return { ok: false, txId, status: 'rbf_resubmit_failed', fee, bumps: bump + 1 };
    }
  }
};

export interface ExecutionContext {
  address: string;
  nonce: number;
  fee: bigint;
}

export interface ContractCall {
  contract: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: PostConditionMode;
}

export const signAndBroadcast = async (
  call: ContractCall,
  ctx: ExecutionContext,
): Promise<string> => {
  if (!CONFIG.SIGNER_KEY) throw new Error('SIGNER_KEY not set');
  const { address, name } = parseContract(call.contract);
  const network = getNetwork();
  const tx = await makeContractCall({
    contractAddress: address,
    contractName: name,
    functionName: call.functionName,
    functionArgs: call.functionArgs,
    senderKey: CONFIG.SIGNER_KEY,
    network,
    nonce: ctx.nonce,
    fee: ctx.fee,
    anchorMode: AnchorMode.Any,
    postConditionMode: call.postConditionMode,
    postConditions: call.postConditions,
  });

  const result = await broadcastTransaction(tx, network);
  const failure = result as { error?: string; reason?: string };
  if (failure.error) {
    throw new Error(`broadcast failed: ${failure.reason || failure.error}`);
  }
  return `0x${(result as { txid: string }).txid}`;
};

export interface Preflight {
  address: string;
  nonce: number;
  fee: bigint;
  stxBalance: bigint;
  mempoolPending: boolean;
  missingNonces: number[];
}

export const preflight = async (): Promise<Preflight> => {
  assertSignerKeyMatchesAddress();
  const address = getSignerAddress();
  const [nonceInfo, fee, balances] = await Promise.all([
    getNonceInfo(address),
    estimateFee(),
    getAccountBalances(address),
  ]);

  // Fees are paid from free STX. The gas reserve (STX_GAS_RESERVE_USTX) is the
  // gas tank itself -- spendableStx keeps it undeployed, so it's available to
  // fund fees here. We only need to cover this tx's fee, not fee + reserve.
  if (balances.stx < fee) {
    throw new Error(
      `stx cannot cover tx fee balance=${microToString(balances.stx)} fee=${microToString(fee)}`,
    );
  }

  logInfo(
    `[${TAG}] preflight address=${address} nonce=${nonceInfo.nextNonce} fee=${microToString(fee)} stx=${microToString(balances.stx)}`,
  );
  return {
    address,
    nonce: nonceInfo.nextNonce,
    fee,
    stxBalance: balances.stx,
    mempoolPending: nonceInfo.mempoolPending,
    missingNonces: nonceInfo.missingNonces,
  };
};
