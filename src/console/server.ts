import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { ConsoleStore, HttpError, ManualBody } from './store';

interface Reply {
  status: number;
  body: unknown;
  /** Sent as a file download instead of JSON. */
  file?: { name: string; type: string; text: string };
}

export interface RequestHeaders {
  host?: string;
  origin?: string;
  secFetchSite?: string;
  contentType?: string;
}

export interface ConsoleRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: RequestHeaders;
  body: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const hostnameOf = (value: string): string => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
};

// Bots hold real keys, so only this computer may drive them. Checking Host stops DNS rebinding;
// checking Origin / Sec-Fetch-Site stops other websites open in the same browser; requiring a JSON
// body forces a CORS preflight that this server never approves.
const checkLocal = (req: ConsoleRequest): void => {
  const { host, origin, secFetchSite, contentType } = req.headers;
  if (!host || !LOOPBACK.has(hostnameOf(host))) throw new HttpError(403, 'not_local', 'Only this computer can use the helper.');
  if (origin && !LOOPBACK.has(hostnameOf(origin))) throw new HttpError(403, 'not_local', 'Other websites cannot use the helper.');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    throw new HttpError(403, 'not_local', 'Other websites cannot use the helper.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(contentType || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json', 'Send JSON with content-type: application/json.');
  }
};

// The key and the payout address decide who ends up with the funds, so those
// routes answer only the page. Browsers always send Sec-Fetch-Site; curl and
// agents do not. This keeps an agent from doing it by default, not a hard wall:
// anything that can read the env file already has the key.
const requirePage = (req: ConsoleRequest): void => {
  if (req.headers.secFetchSite !== 'same-origin') {
    throw new HttpError(403, 'page_only', 'Do this on the page, not through the API.');
  }
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'too_large', 'Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'body', 'Could not read the request.')));
  });

export const handleConsole = async (store: ConsoleStore, req: ConsoleRequest, nowMs: number): Promise<Reply> => {
  checkLocal(req);
  const { method, path } = req;
  let body: Record<string, unknown> = {};
  if (req.body) {
    try {
      const parsed = JSON.parse(req.body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else throw new Error('body');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'json', 'Request body must be a JSON object.');
    }
  }

  const botAction = path.match(/^\/api\/bots\/([^/]+)\/([a-z-]+)$/);
  if (method === 'GET' && path === '/api/fleet') {
    return { status: 200, body: await store.fleet(nowMs) };
  }
  if (method === 'GET' && path === '/api/pools') {
    return { status: 200, body: await store.poolCatalog(String((req.query || {}).profile || '')) };
  }
  if (method === 'GET' && path === '/api/wallet') {
    return { status: 200, body: store.walletInfo() };
  }
  if (method === 'POST' && path === '/api/wallet/accounts') {
    requirePage(req);
    return { status: 200, body: { accounts: await store.phraseAccounts(typeof body.phrase === 'string' ? body.phrase : '') } };
  }
  if (method === 'GET' && path === '/api/profiles') {
    return { status: 200, body: { profiles: store.profiles() } };
  }
  if (method === 'GET' && botAction && botAction[2] === 'strategy') {
    return { status: 200, body: store.strategy(decodeURIComponent(botAction[1])) };
  }
  if (method === 'GET' && botAction && botAction[2] === 'history') {
    const asked = (req.query || {}).range;
    const range = asked === '7d' || asked === 'all' ? asked : '1d';
    return { status: 200, body: store.history(decodeURIComponent(botAction[1]), range, nowMs) };
  }
  const csv = path.match(/^\/api\/bots\/([^/]+)\/decisions\.csv$/);
  if (method === 'GET' && csv) {
    const out = store.decisionsCsv(decodeURIComponent(csv[1]));
    return { status: 200, body: null, file: { name: out.filename, type: 'text/csv; charset=utf-8', text: out.text } };
  }
  if (method === 'GET' && path === '/api/bridge') return { status: 200, body: { transfers: store.bridgeTransfers() } };
  if (method === 'GET' && botAction && botAction[2] === 'bridge') {
    return { status: 200, body: await store.bridgeView(decodeURIComponent(botAction[1])) };
  }
  if (method === 'GET' && botAction && botAction[2] === 'cash-out') {
    const bot = await store.one(decodeURIComponent(botAction[1]), nowMs);
    return { status: 200, body: { cashOut: bot.cashOut } };
  }
  const one = path.match(/^\/api\/bots\/([^/]+)$/);
  if (method === 'GET' && one) return { status: 200, body: await store.one(decodeURIComponent(one[1]), nowMs) };
  if (method === 'POST' && path === '/api/bots') {
    if (body.wallet !== 'create' && body.wallet !== 'import' && body.wallet !== 'phrase') {
      throw new HttpError(400, 'wallet', 'Create a new wallet or import one.');
    }
    return {
      status: 200,
      body: await store.create({
        profile: String(body.profile || ''),
        wallet: body.wallet,
        phrase: typeof body.phrase === 'string' ? body.phrase : undefined,
        account: typeof body.account === 'number' ? body.account : undefined,
        signerKey: typeof body.signerKey === 'string' ? body.signerKey : undefined,
        signerAddress: typeof body.signerAddress === 'string' ? body.signerAddress : undefined,
        poolId: typeof body.poolId === 'string' ? body.poolId : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        settings:
          body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
            ? Object.fromEntries(Object.entries(body.settings as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
            : undefined,
      }),
    };
  }
  if (method === 'POST' && path === '/api/pause-all') return { status: 200, body: await store.pauseAll(nowMs) };
  if (method === 'POST' && botAction) {
    const id = decodeURIComponent(botAction[1]);
    const action = botAction[2];
    if (action === 'pause') return { status: 200, body: await store.pause(id, nowMs) };
    if (action === 'resume') return { status: 200, body: await store.resume(id, nowMs) };
    if (action === 'start') return { status: 200, body: await store.start(id) };
    if (action === 'stop') return { status: 200, body: await store.stop(id) };
    if (action === 'settings') {
      const settings = body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, string>) : {};
      return {
        status: 200,
        body: await store.updateSettings(id, settings, {
          confirmLive: body.confirmLive === true,
          poolName: typeof body.poolName === 'string' ? body.poolName : '',
        }),
      };
    }
    if (action === 'name') return { status: 200, body: await store.rename(id, typeof body.name === 'string' ? body.name : '') };
    if (action === 'baseline-reset') return { status: 200, body: await store.resetBaseline(id) };
    if (action === 'key-backup') {
      requirePage(req);
      return { status: 200, body: store.keyBackup(id, body.acknowledged === true) };
    }
    if (action === 'key-saved') {
      requirePage(req);
      return { status: 200, body: await store.keySaved(id, typeof body.keyTail === 'string' ? body.keyTail : '') };
    }
    if (action === 'api-key') {
      requirePage(req);
      return {
        status: 200,
        body: await store.setApiKey(id, typeof body.name === 'string' ? body.name : '', typeof body.value === 'string' ? body.value : ''),
      };
    }
    if (action === 'payout') {
      requirePage(req);
      return {
        status: 200,
        body: await store.setPayout(id, {
          address: typeof body.address === 'string' ? body.address : '',
          memo: typeof body.memo === 'string' ? body.memo : '',
          addressTail: typeof body.addressTail === 'string' ? body.addressTail : '',
        }),
      };
    }
    if (action === 'pool') {
      return {
        status: 200,
        body: await store.switchPool(id, {
          poolId: typeof body.poolId === 'string' ? body.poolId : '',
          acknowledged: body.acknowledged === true,
          poolName: typeof body.poolName === 'string' ? body.poolName : '',
        }),
      };
    }
    if (action === 'bridge-deposit') return { status: 200, body: await store.bridgeDeposit(id) };
    if (action === 'bridge-demo-send') return { status: 200, body: await store.bridgeDemoSend(id, typeof body.asset === 'string' ? body.asset : 'btc') };
    if (action === 'bridge-usdc-deposit') {
      return {
        status: 200,
        body: await store.bridgeUsdcDeposit(id, {
          ethTxid: typeof body.ethTxid === 'string' ? body.ethTxid : '',
          amount: typeof body.amount === 'string' ? body.amount : '',
        }),
      };
    }
    if (action === 'bridge-usdc-withdraw') {
      requirePage(req);
      return {
        status: 200,
        body: await store.bridgeUsdcWithdraw(id, {
          amount: typeof body.amount === 'string' ? body.amount : '',
          ethAddress: typeof body.ethAddress === 'string' ? body.ethAddress : '',
          acknowledged: body.acknowledged === true,
          poolName: typeof body.poolName === 'string' ? body.poolName : '',
        }),
      };
    }
    if (action === 'bridge-withdraw') {
      // Sends funds to an address typed here, so it answers only the page, like the payout address.
      requirePage(req);
      return {
        status: 200,
        body: await store.bridgeWithdraw(id, {
          amount: typeof body.amount === 'string' ? body.amount : '',
          btcAddress: typeof body.btcAddress === 'string' ? body.btcAddress : '',
          acknowledged: body.acknowledged === true,
          poolName: typeof body.poolName === 'string' ? body.poolName : '',
        }),
      };
    }
    if (action === 'cash-out') {
      return {
        status: 200,
        body: await store.cashOut(id, {
          acknowledged: body.acknowledged === true,
          poolName: typeof body.poolName === 'string' ? body.poolName : '',
        }),
      };
    }
    if (action === 'manual') {
      const manual: ManualBody = {
        action: String(body.action || ''),
        acknowledged: body.acknowledged === true,
        poolName: typeof body.poolName === 'string' ? body.poolName : '',
        amount: typeof body.amount === 'string' ? body.amount : undefined,
        side: typeof body.side === 'string' ? body.side : undefined,
        xAmount: typeof body.xAmount === 'string' ? body.xAmount : undefined,
        yAmount: typeof body.yAmount === 'string' ? body.yAmount : undefined,
        pct: typeof body.pct === 'number' ? body.pct : undefined,
      };
      return { status: 200, body: await store.manual(id, manual) };
    }
  }
  throw new HttpError(404, 'not_found', 'No such call.');
};

const send = (res: ServerResponse, reply: Reply): void => {
  if (reply.file) {
    res.writeHead(reply.status, {
      'content-type': reply.file.type,
      'content-disposition': `attachment; filename="${reply.file.name}"`,
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(reply.file.text)),
    });
    res.end(reply.file.text);
    return;
  }
  const payload = JSON.stringify(reply.body);
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  };
  res.writeHead(reply.status, headers);
  res.end(payload);
};

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

export const listenConsole = (store: ConsoleStore, port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const method = req.method || 'GET';
          const raw = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
          const headers: RequestHeaders = {
            host: header(req, 'host'),
            origin: header(req, 'origin'),
            secFetchSite: header(req, 'sec-fetch-site'),
            contentType: header(req, 'content-type'),
          };
          const query = Object.fromEntries(url.searchParams.entries());
          const reply = await handleConsole(store, { method, path: url.pathname, query, headers, body: raw }, Date.now());
          send(res, reply);
        } catch (err) {
          const http = err instanceof HttpError ? err : new HttpError(500, 'error', (err as Error).message);
          send(res, { status: http.status, body: { error: http.code, message: http.message } });
        }
      })();
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
