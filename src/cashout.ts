// Cash out: withdraw the whole position, then send every pool token and finally
// the STX to the payout address. Each step reads live balances, so a run that
// stops halfway can simply be run again to finish.
import {
  AnchorMode,
  FungibleConditionCode,
  PostConditionMode,
  broadcastTransaction,
  bufferCVFromString,
  createAssetInfo,
  makeSTXTokenTransfer,
  makeStandardFungiblePostCondition,
  noneCV,
  someCV,
  standardPrincipalCV,
  uintCV,
} from '@stacks/transactions';
import { CONFIG } from './config';
import { broadcastLiquidity, prepareWithdrawLiquidity } from './liquidity';
import { logError, logInfo, logWarn } from './logger';
import { checkMemo, checkPayoutAddress, stxSweepAmount } from './payout';
import { getNetwork, microToString, parseContract } from './stacks';
import {
  ContractCall,
  getAccountBalances,
  getSignerAddress,
  preflight,
  signAndBroadcast,
  submitWithConfirmation,
} from './wallet';

const TAG = 'cashout';

const isMainnet = (): boolean => String(CONFIG.STACKS_NETWORK_VERSION || 'mainnet').toLowerCase() === 'mainnet';

interface PoolToken {
  symbol: string;
  contract: string;
  assetName: string;
  decimals: number;
}

const poolTokens = (): PoolToken[] =>
  [
    { symbol: 'base', contract: CONFIG.BASE_TOKEN_CONTRACT, assetName: CONFIG.BASE_ASSET_NAME, decimals: CONFIG.BASE_DECIMALS },
    { symbol: 'quote', contract: CONFIG.QUOTE_TOKEN_CONTRACT, assetName: CONFIG.QUOTE_ASSET_NAME, decimals: CONFIG.QUOTE_DECIMALS },
    // The STX wrapper side is paid out as native STX in the final sweep.
  ].filter((token) => token.contract !== CONFIG.STX_TOKEN_CONTRACT);

// A pending or missing nonce means another transaction from this wallet is in
// flight; sending now would queue behind it or collide, so stop and let the
// user run cash-out again once it settles.
const freshContext = async (): Promise<{ address: string; nonce: number; fee: bigint }> => {
  const pf = await preflight();
  if (pf.mempoolPending || pf.missingNonces.length) {
    throw new Error('another transaction from this wallet is still pending; run cash out again in a minute');
  }
  return { address: pf.address, nonce: pf.nonce, fee: pf.fee };
};

const withdrawAll = async (signer: string): Promise<void> => {
  let prepared;
  try {
    prepared = await prepareWithdrawLiquidity({ poolId: CONFIG.POOL_ID, signer, percentage: 100 });
  } catch (err) {
    if ((err as Error).message === 'no withdrawable positions found') {
      logInfo(`[${TAG}] step=withdraw skipped reason="nothing in the pool"`);
      return;
    }
    // Sweeping the wallet without knowing the position would spend the STX the
    // withdraw still needs for its fee, so an unreadable position stops the run.
    throw new Error(`could not read the pool position, so nothing was sent; try again in a few minutes (${(err as Error).message})`);
  }
  const ctx = await freshContext();
  logInfo(`[${TAG}] step=withdraw ${prepared.summary} nonce=${ctx.nonce}`);
  const res = await submitWithConfirmation(
    (fee) => broadcastLiquidity(prepared.call, { ...ctx, fee }),
    ctx.fee,
    `cashout_withdraw nonce=${ctx.nonce}`,
  );
  logInfo(`[${TAG}] step=withdraw tx=${res.txId} ok=${res.ok} status="${res.status}"`);
  if (!res.ok) throw new Error(`withdraw did not confirm (status="${res.status}")`);
};

const sendToken = async (token: PoolToken, signer: string, to: string, memo: string): Promise<void> => {
  const balances = await getAccountBalances(signer);
  const amount = balances.tokens[`${token.contract}::${token.assetName}`]?.balance ?? BigInt(0);
  if (amount <= BigInt(0)) {
    logInfo(`[${TAG}] step=send_${token.symbol} skipped reason="balance is zero"`);
    return;
  }
  const { address, name } = parseContract(token.contract);
  const call: ContractCall = {
    contract: token.contract,
    functionName: 'transfer',
    functionArgs: [
      uintCV(amount),
      standardPrincipalCV(signer),
      standardPrincipalCV(to),
      memo ? someCV(bufferCVFromString(memo)) : noneCV(),
    ],
    // Deny mode with an exact outflow: the transfer can move this amount of this
    // token and nothing else from the bot wallet.
    postConditions: [
      makeStandardFungiblePostCondition(
        signer,
        FungibleConditionCode.Equal,
        amount,
        createAssetInfo(address, name, token.assetName),
      ),
    ],
    postConditionMode: PostConditionMode.Deny,
  };
  const ctx = await freshContext();
  logInfo(
    `[${TAG}] step=send_${token.symbol} token=${token.contract} amount=${microToString(amount, token.decimals)} to=${to} nonce=${ctx.nonce}`,
  );
  const res = await submitWithConfirmation(
    (fee) => signAndBroadcast(call, { ...ctx, fee }),
    ctx.fee,
    `cashout_send_${token.symbol} nonce=${ctx.nonce}`,
  );
  logInfo(`[${TAG}] step=send_${token.symbol} tx=${res.txId} ok=${res.ok} status="${res.status}"`);
  if (!res.ok) throw new Error(`${token.symbol} transfer did not confirm (status="${res.status}")`);
};

const sweepStx = async (signer: string, to: string, memo: string): Promise<void> => {
  const balances = await getAccountBalances(signer);
  const ctx = await freshContext();
  if (stxSweepAmount(balances.stx, ctx.fee) <= BigInt(0)) {
    logInfo(`[${TAG}] step=send_stx skipped reason="nothing left after the fee"`);
    return;
  }
  const network = getNetwork();
  logInfo(
    `[${TAG}] step=send_stx amount=${microToString(stxSweepAmount(balances.stx, ctx.fee))} to=${to} nonce=${ctx.nonce}`,
  );
  // The fee comes out of the same balance, so the amount is recomputed for every
  // replace-by-fee bump; a fixed amount would overdraw once the fee rises.
  const res = await submitWithConfirmation(
    async (fee) => {
      const tx = await makeSTXTokenTransfer({
        recipient: to,
        amount: stxSweepAmount(balances.stx, fee),
        fee,
        nonce: ctx.nonce,
        senderKey: CONFIG.SIGNER_KEY,
        network,
        anchorMode: AnchorMode.Any,
        memo,
      });
      const result = await broadcastTransaction(tx, network);
      const failure = result as { error?: string; reason?: string };
      if (failure.error) throw new Error(`broadcast failed: ${failure.reason || failure.error}`);
      return `0x${(result as { txid: string }).txid}`;
    },
    ctx.fee,
    `cashout_send_stx nonce=${ctx.nonce}`,
  );
  logInfo(`[${TAG}] step=send_stx tx=${res.txId} ok=${res.ok} status="${res.status}"`);
  if (!res.ok) throw new Error(`STX transfer did not confirm (status="${res.status}")`);
};

/** Returns true when every step finished. Runs in dry run too: leaving is not trading. */
export const runCashOut = async (to: string, memo: string): Promise<boolean> => {
  try {
    const signer = getSignerAddress();
    const problem = checkPayoutAddress(to, signer, isMainnet()) || checkMemo(memo);
    if (problem) throw new Error(problem);
    logInfo(`[${TAG}] start from=${signer} to=${to} pool="${CONFIG.POOL_ID}" memo=${memo ? 'set' : 'none'}`);
    await withdrawAll(signer);
    for (const token of poolTokens()) await sendToken(token, signer, to, memo);
    await sweepStx(signer, to, memo);

    const left = await getAccountBalances(signer);
    const tokensLeft = poolTokens().filter(
      (token) => (left.tokens[`${token.contract}::${token.assetName}`]?.balance ?? BigInt(0)) > BigInt(0),
    );
    if (tokensLeft.length) {
      logWarn(`[${TAG}] incomplete tokens_left=${tokensLeft.map((t) => t.symbol).join(',')}; run cash out again`);
      return false;
    }
    logInfo(`[${TAG}] done to=${to} stx_left=${microToString(left.stx)}`);
    return true;
  } catch (err) {
    logError(`[${TAG}] failed error="${(err as Error).message}"`);
    return false;
  }
};
