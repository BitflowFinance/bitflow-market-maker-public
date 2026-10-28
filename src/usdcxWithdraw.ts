// USDCx -> USDC: one `usdcx-v1.burn` from the bot wallet. Circle then pays the
// USDC out on Ethereum; the console follows that part, so this runner ends once
// the burn confirms on Stacks.
import {
  FungibleConditionCode,
  PostConditionMode,
  bufferCV,
  createAssetInfo,
  makeStandardFungiblePostCondition,
  uintCV,
} from '@stacks/transactions';
import { freshContext } from './cashout';
import { logError, logInfo } from './logger';
import { ETHEREUM_DOMAIN, MIN_WITHDRAW_MICRO, USDCX_ASSET, USDCX_BRIDGE, USDCX_DEPLOYER, USDCX_TOKEN, ethAddressOf, ethRecipientOf } from './usdcx';
import { ContractCall, getAccountBalances, getSignerAddress, signAndBroadcast, submitWithConfirmation } from './wallet';

const TAG = 'usdcx';

/** Returns true once the burn confirms on Stacks. Runs in dry run too: like cash out, it is not trading. */
export const runUsdcxWithdraw = async (amountRaw: string, to: string): Promise<boolean> => {
  try {
    if (!/^\d+$/.test(amountRaw.trim())) throw new Error('amount must be a whole number of micro-USDCx');
    const amount = BigInt(amountRaw.trim());
    // The contract enforces its own (adjustable) floor; this only saves a failed
    // transaction fee when the amount is plainly too small.
    if (amount < BigInt(MIN_WITHDRAW_MICRO)) throw new Error(`withdraw at least ${MIN_WITHDRAW_MICRO / 1e6} USDCx`);
    const address = ethAddressOf(to);
    const signer = getSignerAddress();

    const balances = await getAccountBalances(signer);
    const held = balances.tokens[`${USDCX_TOKEN}::${USDCX_ASSET}`]?.balance ?? BigInt(0);
    if (held < amount) throw new Error(`the wallet holds ${held} micro-USDCx but this needs ${amount}; withdraw from the pool first`);

    const call: ContractCall = {
      contract: USDCX_BRIDGE,
      functionName: 'burn',
      functionArgs: [uintCV(amount), uintCV(ETHEREUM_DOMAIN), bufferCV(ethRecipientOf(address))],
      postConditions: [
        makeStandardFungiblePostCondition(signer, FungibleConditionCode.Equal, amount, createAssetInfo(USDCX_DEPLOYER, 'usdcx', USDCX_ASSET)),
      ],
      postConditionMode: PostConditionMode.Deny,
    };
    const ctx = await freshContext();
    logInfo(`[${TAG}] step=burn amount=${amount} to=${address} nonce=${ctx.nonce}`);
    const res = await submitWithConfirmation(
      (fee) => signAndBroadcast(call, { ...ctx, fee }),
      ctx.fee,
      `usdcx_withdraw nonce=${ctx.nonce}`,
    );
    logInfo(`[${TAG}] step=burn tx=${res.txId} ok=${res.ok} status="${res.status}"`);
    if (!res.ok) throw new Error(`the burn did not confirm (status="${res.status}")`);
    logInfo(`[${TAG}] done tx=${res.txId}`);
    return true;
  } catch (err) {
    logError(`[${TAG}] failed error="${(err as Error).message}"`);
    return false;
  }
};
