import { StacksMainnet, StacksTestnet } from '@stacks/network';
import {
  ClarityValue,
  cvToHex,
  parseReadOnlyResponse,
  standardPrincipalCV,
  contractPrincipalCV,
} from '@stacks/transactions';
import { CONFIG } from './config';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const retry = async <T>(fn: () => Promise<T>, attempts: number): Promise<T> => {
  let lastError: Error | null = null;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (i === attempts) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastError ?? new Error('retry failed');
};

export const parseContract = (contract: string): { address: string; name: string } => {
  const [address, name] = String(contract).split('.');
  return { address, name };
};

export const cvToValue = (cv: unknown): unknown => {
  if (!cv) return null;
  const value = (cv as { value?: unknown }).value;
  if (value !== undefined) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') return cvToValue(value);
    return value;
  }
  return cv;
};

export const cvToBigInt = (cv: unknown): bigint => {
  const v = cvToValue(cv);
  if (v === null || v === undefined) return BigInt(0);
  try {
    return BigInt(String(v));
  } catch {
    return BigInt(0);
  }
};

export const microToString = (atomic: bigint, decimals = 6): string => {
  const negative = atomic < BigInt(0);
  const abs = (negative ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${out}` : out;
};

export const getNetwork = (): StacksMainnet | StacksTestnet => {
  const isMainnet =
    String(CONFIG.STACKS_NETWORK_VERSION || 'mainnet').toLowerCase() === 'mainnet';
  const url = CONFIG.STACKS_NODE_URL || undefined;

  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.STACKS_CALL_TIMEOUT_MS);
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (CONFIG.STACKS_NODE_KEY) headers['X-API-Key'] = CONFIG.STACKS_NODE_KEY;
    return fetch(input, { ...(init || {}), headers, signal: controller.signal }).finally(() =>
      clearTimeout(timeoutId),
    );
  };

  return isMainnet
    ? new StacksMainnet({ url, fetchFn })
    : new StacksTestnet({ url, fetchFn });
};

export const callReadOnly = async (
  contract: string,
  functionName: string,
  functionArgs: ClarityValue[],
  sender: string,
): Promise<ClarityValue> => {
  const { address, name } = parseContract(contract);
  const network = getNetwork();
  const url = network.getReadOnlyFunctionCallApiUrl(address, name, functionName);
  const body = JSON.stringify({
    sender: sender || address,
    arguments: functionArgs.map((arg) => cvToHex(arg)),
  });

  return retry(async () => {
    const res = await network.fetchFn(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`read-only ${name}.${functionName} failed (${res.status}): ${msg}`);
    }
    return parseReadOnlyResponse(await res.json());
  }, CONFIG.STACKS_CALL_MAX_RETRIES);
};

export const fetchJson = async <T = unknown>(
  url: string,
  apiKey = '',
): Promise<T> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  return retry(async () => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
    return (await res.json()) as T;
  }, CONFIG.STACKS_CALL_MAX_RETRIES);
};

// Same as fetchJson but treats 404 as a legitimate "nothing here" answer rather
// than a failure to retry, for endpoints that 404 instead of returning an empty
// collection.
export const fetchJsonAllowMissing = async <T = unknown>(
  url: string,
  apiKey = '',
): Promise<T | null> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  return retry(async () => {
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
    return (await res.json()) as T;
  }, CONFIG.STACKS_CALL_MAX_RETRIES);
};

export const getFtBalance = async (
  tokenContract: string,
  address: string,
): Promise<bigint> => {
  if (!tokenContract || !address) return BigInt(0);
  const owner = address.includes('.')
    ? (() => {
        const { address: a, name: n } = parseContract(address);
        return contractPrincipalCV(a, n);
      })()
    : standardPrincipalCV(address);
  const response = await callReadOnly(tokenContract, 'get-balance', [owner], address);
  return cvToBigInt((response as { value?: unknown }).value ?? response);
};