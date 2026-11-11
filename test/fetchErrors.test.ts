import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/config';
import { probeBff } from '../src/bitflow';
import { describeFetchError, fetchJson } from '../src/stacks';

// Shape of what Node's undici fetch rejects with when TLS is answered by
// something that is not TLS (a proxy or web filter on port 443).
const tlsFailure = (): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('error:0A00010B:SSL routines::wrong version number'), {
      code: 'ERR_SSL_WRONG_VERSION_NUMBER',
    }),
  });

const originalBase = CONFIG.BFF_API_BASE_URL;

beforeEach(() => {
  CONFIG.STACKS_CALL_MAX_RETRIES = 0;
  CONFIG.BFF_API_BASE_URL = 'https://bff.example.test/api';
});

afterEach(() => {
  CONFIG.BFF_API_BASE_URL = originalBase;
  vi.unstubAllGlobals();
});

describe('describeFetchError', () => {
  it('names the host and the hidden cause code and message', () => {
    const err = describeFetchError(tlsFailure(), 'https://bff.example.test/api/app/v1/pools/dlmm_3');
    expect(err.message).toBe(
      'fetch failed host="bff.example.test" cause="ERR_SSL_WRONG_VERSION_NUMBER: error:0A00010B:SSL routines::wrong version number"',
    );
  });

  it('does not repeat a code the cause message already carries', () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND bff.example.test'), { code: 'ENOTFOUND' }),
    });
    expect(describeFetchError(dns, 'https://bff.example.test/x').message).toBe(
      'fetch failed host="bff.example.test" cause="getaddrinfo ENOTFOUND bff.example.test"',
    );
  });

  it('keeps a multi-line OpenSSL cause on one log line', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('error:0A00010B:SSL routines:ssl3_get_record:wrong version number:ssl3_record.c:355:\n'), {
        code: 'ERR_SSL_WRONG_VERSION_NUMBER',
      }),
    });
    expect(describeFetchError(err, 'https://h.test/a').message).toBe(
      'fetch failed host="h.test" cause="ERR_SSL_WRONG_VERSION_NUMBER: error:0A00010B:SSL routines:ssl3_get_record:wrong version number:ssl3_record.c:355:"',
    );
  });

  it('still names the host when there is no cause', () => {
    expect(describeFetchError(new Error('The operation was aborted due to timeout'), 'https://h.test/a').message).toBe(
      'The operation was aborted due to timeout host="h.test"',
    );
  });
});

describe('fetchJson transport failures', () => {
  it('rejects with the described error instead of a bare "fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(tlsFailure())));
    await expect(fetchJson('https://bff.example.test/api/quotes/v2/status')).rejects.toThrow(
      /^fetch failed host="bff\.example\.test" cause="ERR_SSL_WRONG_VERSION_NUMBER/,
    );
  });

  it('leaves HTTP status errors unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) })),
    );
    await expect(fetchJson('https://bff.example.test/api/x')).rejects.toThrow(/^503 Service Unavailable/);
  });
});

describe('probeBff', () => {
  it('treats any HTTP answer, even an error status, as reachable', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeBff()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://bff.example.test/api/quotes/v2/status');
  });

  it('returns the transport failure with host and cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(tlsFailure())));
    expect(await probeBff()).toMatch(/host="bff\.example\.test" cause="ERR_SSL_WRONG_VERSION_NUMBER/);
  });

  it('reports a missing base URL instead of throwing', async () => {
    CONFIG.BFF_API_BASE_URL = '';
    expect(await probeBff()).toMatch(/BFF_API_BASE_URL is not configured/);
  });
});
