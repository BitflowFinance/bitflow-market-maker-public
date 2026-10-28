// sBTC -> BTC: one `initiate-withdrawal-request` from the bot wallet. The sBTC
// signers then send the BTC on Bitcoin; the console follows that part through
// Emily, so this runner ends once the Stacks request confirms.
import {
  FungibleConditionCode,
  PostConditionMode,
  bufferCV,
  createAssetInfo,
  makeStandardFungiblePostCondition,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { freshContext } from './cashout';
import { logError, logInfo } from './logger';
import { MIN_WITHDRAW_SATS, SBTC_ASSET, SBTC_DEPLOYER, SBTC_TOKEN, SBTC_WITHDRAWAL, btcRecipientOf } from './sbtc';
import { ContractCall, getAccountBalances, getSignerAddress, signAndBroadcast, submitWithConfirmation } from './wallet';

const TAG = 'sbtc';

const sats = (raw: string, label: string): bigint => {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be a whole number of sats`);
  return BigInt(raw.trim());
};

/** Returns true once the request confirms on Stacks. Runs in dry run too: like cash out, it is not trading. */
export const runSbtcWithdraw = async (amountRaw: string, to: string, maxFeeRaw: string): Promise<boolean> => {
  try {
    const amount = sats(amountRaw, 'amount');
    const maxFee = sats(maxFeeRaw, 'max fee');
    if (amount < BigInt(MIN_WITHDRAW_SATS)) throw new Error(`withdraw at least ${MIN_WITHDRAW_SATS} sats`);
    const recipient = btcRecipientOf(to);
    const signer = getSignerAddress();

    // The contract takes the amount and the whole fee cap up front; the signers
    // return whatever part of the cap the Bitcoin transaction did not use.
    const total = amount + maxFee;
    const balances = await getAccountBalances(signer);
    const held = balances.tokens[`${SBTC_TOKEN}::${SBTC_ASSET}`]?.balance ?? BigInt(0);
    if (held < total) {
      throw new Error(`the wallet holds ${held} sats of sBTC but this needs ${total} (amount plus the fee cap); withdraw from the pool first`);
    }

    const call: ContractCall = {
      contract: SBTC_WITHDRAWAL,
      functionName: 'initiate-withdrawal-request',
      functionArgs: [
        uintCV(amount),
        tupleCV({ version: bufferCV(recipient.version), hashbytes: bufferCV(recipient.hashbytes) }),
        uintCV(maxFee),
      ],
      postConditions: [
        makeStandardFungiblePostCondition(signer, FungibleConditionCode.Equal, total, createAssetInfo(SBTC_DEPLOYER, 'sbtc-token', SBTC_ASSET)),
      ],
      postConditionMode: PostConditionMode.Deny,
    };
    const ctx = await freshContext();
    logInfo(`[${TAG}] step=request amount=${amount} max_fee=${maxFee} to=${to.trim()} nonce=${ctx.nonce}`);
    const res = await submitWithConfirmation(
      (fee) => signAndBroadcast(call, { ...ctx, fee }),
      ctx.fee,
      `sbtc_withdraw nonce=${ctx.nonce}`,
    );
    logInfo(`[${TAG}] step=request tx=${res.txId} ok=${res.ok} status="${res.status}"`);
    if (!res.ok) throw new Error(`the withdrawal request did not confirm (status="${res.status}")`);
    logInfo(`[${TAG}] done tx=${res.txId}`);
    return true;
  } catch (err) {
    logError(`[${TAG}] failed error="${(err as Error).message}"`);
    return false;
  }
};
