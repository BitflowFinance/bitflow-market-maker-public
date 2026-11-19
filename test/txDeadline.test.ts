import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v6 from '@stacks/transactions';
import * as v7 from 'stacks-tx-v7';
import { CONFIG } from '../src/config';
import { broadcastLiquidity, buildAddLiquidityCall, buildWithdrawLiquidityCall, poolRef } from '../src/liquidity';
import { buildSwapCall } from '../src/swap';
import { signAndBroadcast, submitWithConfirmation, txDeadline, withFreshDeadline } from '../src/wallet';

// Signing and broadcasting are stubbed; everything between the call builders and
// makeContractCall is the real code path, so these pin which deadline each
// broadcast actually carries.
const signs: { atMs: number; args: unknown[] }[] = [];
let txCounter = 0;

vi.mock('stacks-tx-v7', async () => {
  const actual = await vi.importActual<typeof import('stacks-tx-v7')>('stacks-tx-v7');
  return {
    ...actual,
    makeContractCall: async (opts: { functionArgs: unknown[] }) => {
      signs.push({ atMs: Date.now(), args: opts.functionArgs });
      return {};
    },
    broadcastTransaction: async () => ({ txid: (++txCounter).toString(16).padStart(64, '0') }),
  };
});

vi.mock('@stacks/transactions', async () => {
  const actual = await vi.importActual<typeof import('@stacks/transactions')>('@stacks/transactions');
  return {
    ...actual,
    makeContractCall: async (opts: { functionArgs: unknown[] }) => {
      signs.push({ atMs: Date.now(), args: opts.functionArgs });
      return {};
    },
    broadcastTransaction: async () => ({ txid: (++txCounter).toString(16).padStart(64, '0') }),
  };
});

// Every tx-status poll reports "pending" and moves the clock on, so the
// confirmation window runs out and submitWithConfirmation replaces the tx.
const POLL_STEP_MS = 61_000;
vi.mock('../src/stacks', async () => {
  const actual = await vi.importActual<typeof import('../src/stacks')>('../src/stacks');
  return {
    ...actual,
    fetchJson: async () => {
      vi.setSystemTime(Date.now() + POLL_STEP_MS);
      return { tx_status: 'pending' };
    },
  };
});

const POOL = 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10';
const SIGNER = 'SP15VM42Q85WEKQFW9NQDKKCFNJF2NG2VBTPR6CBR';
const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const saved = { ...CONFIG };

const pool = () => poolRef(POOL, CONFIG.BASE_TOKEN_CONTRACT, CONFIG.QUOTE_TOKEN_CONTRACT);
const addCall = () =>
  buildAddLiquidityCall(
    pool(),
    [{ binId: 500, offset: 0, xAmount: BigInt(1000), yAmount: BigInt(1000), minDlp: BigInt(1), maxXFee: BigInt(0), maxYFee: BigInt(0) }],
    SIGNER,
    { activeBinTolerance: { maxDeviation: 2, expectedSignedBinId: 0 }, deadline: txDeadline() },
  );
const deadlineAt = (signTimeMs: number): number => Math.floor(signTimeMs / 1000) + CONFIG.TX_DEADLINE_SECONDS;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  signs.length = 0;
  Object.assign(CONFIG, {
    SIGNER_KEY: 'stubbed-signing',
    TX_DEADLINE_SECONDS: 120,
    TX_CONFIRMATION_TIMEOUT_MS: 120_000,
    TX_POLL_INTERVAL_MS: 1,
    TX_MAX_FEE_BUMPS: 3,
    TX_FEE_BUMP_MULTIPLIER: 1.5,
    MAX_TX_FEE_USTX: 150_000,
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(CONFIG, saved);
});

describe('withFreshDeadline', () => {
  it('re-stamps only the deadline slot', () => {
    const args = ['a', 'b', 'old'];
    expect(withFreshDeadline(args, 2, (d) => `deadline:${d}`)).toEqual(['a', 'b', `deadline:${deadlineAt(T0)}`]);
    expect(args).toEqual(['a', 'b', 'old']);
  });

  it('leaves calls without a deadline untouched', () => {
    const args = ['a', 'b'];
    expect(withFreshDeadline(args, undefined, () => 'never')).toBe(args);
  });
});

describe('call builders mark the router deadline argument', () => {
  it('add, withdraw and swap point at their trailing (optional uint) deadline', () => {
    const add = addCall();
    const withdraw = buildWithdrawLiquidityCall(
      pool(),
      [{ binId: 500, amount: BigInt(10), minX: BigInt(1), minY: BigInt(1) }],
      SIGNER,
      { deadline: txDeadline() },
    );
    const swap = buildSwapCall(
      {
        poolContract: POOL,
        xToken: CONFIG.BASE_TOKEN_CONTRACT,
        yToken: CONFIG.QUOTE_TOKEN_CONTRACT,
        amountIn: BigInt(1000),
        minReceived: BigInt(900),
        xForY: true,
        maxSteps: 10,
        deadline: txDeadline(),
      },
      SIGNER,
    );
    const v7Deadline = v7.someCV(v7.uintCV(deadlineAt(T0)));
    expect(add.deadlineArgIndex).toBe(add.functionArgs.length - 1);
    expect(add.functionArgs[add.deadlineArgIndex as number]).toEqual(v7Deadline);
    expect(withdraw.deadlineArgIndex).toBe(withdraw.functionArgs.length - 1);
    expect(withdraw.functionArgs[withdraw.deadlineArgIndex as number]).toEqual(v7Deadline);
    expect(swap.deadlineArgIndex).toBe(swap.functionArgs.length - 1);
    expect(swap.functionArgs[swap.deadlineArgIndex as number]).toEqual(v6.someCV(v6.uintCV(deadlineAt(T0))));
  });

  it('marks nothing when no deadline is set', () => {
    const add = buildAddLiquidityCall(
      pool(),
      [{ binId: 500, offset: 0, xAmount: BigInt(1), yAmount: BigInt(0), minDlp: BigInt(1), maxXFee: BigInt(0), maxYFee: BigInt(0) }],
      SIGNER,
    );
    expect(add.deadlineArgIndex).toBeUndefined();
  });
});

describe('replace-by-fee keeps the router deadline live', () => {
  it('every liquidity broadcast, including each fee bump, signs a deadline in the future', async () => {
    const call = addCall();
    const preparedDeadline = deadlineAt(T0);

    const res = await submitWithConfirmation(
      (fee) => broadcastLiquidity(call, { address: SIGNER, nonce: 7, fee }),
      BigInt(50_000),
      'test add',
    );

    // Original + 3 bumps at 0.05 -> 0.075 -> 0.1125 -> 0.15 STX, as in the report.
    expect(res).toMatchObject({ ok: false, status: 'timeout', bumps: 3, fee: BigInt(150_000) });
    expect(signs).toHaveLength(4);
    // Without the fix every bump re-signed preparedDeadline, which had already
    // passed when the first replacement went out.
    expect(signs[1].atMs / 1000).toBeGreaterThan(preparedDeadline);
    for (const s of signs) {
      expect(s.args[call.deadlineArgIndex as number]).toEqual(v7.someCV(v7.uintCV(deadlineAt(s.atMs))));
      expect(deadlineAt(s.atMs)).toBeGreaterThan(s.atMs / 1000);
    }
    // The rest of the call is unchanged across bumps.
    const withoutDeadline = (args: unknown[]) => args.slice(0, call.deadlineArgIndex);
    for (const s of signs) expect(withoutDeadline(s.args)).toEqual(withoutDeadline(call.functionArgs));
  });

  it('swaps signed through signAndBroadcast get a fresh deadline per sign too', async () => {
    const call = buildSwapCall(
      {
        poolContract: POOL,
        xToken: CONFIG.BASE_TOKEN_CONTRACT,
        yToken: CONFIG.QUOTE_TOKEN_CONTRACT,
        amountIn: BigInt(1000),
        minReceived: BigInt(900),
        xForY: true,
        maxSteps: 10,
        deadline: txDeadline(),
      },
      SIGNER,
    );
    await signAndBroadcast(call, { address: SIGNER, nonce: 7, fee: BigInt(50_000) });
    vi.setSystemTime(T0 + 130_000);
    await signAndBroadcast(call, { address: SIGNER, nonce: 7, fee: BigInt(75_000) });

    const idx = call.deadlineArgIndex as number;
    expect(signs[0].args[idx]).toEqual(v6.someCV(v6.uintCV(deadlineAt(T0))));
    expect(signs[1].args[idx]).toEqual(v6.someCV(v6.uintCV(deadlineAt(T0 + 130_000))));
  });
});
