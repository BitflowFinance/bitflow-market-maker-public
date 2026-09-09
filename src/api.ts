import { IncomingMessage, Server, ServerResponse, createServer } from 'http';
import { CONFIG } from './config';
import { logError, logInfo, logWarn } from './logger';
import { getHealth, getHistory, getMetrics, getStatus } from './metrics';

const TAG = 'api';

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const handle = (req: IncomingMessage, res: ServerResponse): void => {
  try {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    switch (url.pathname) {
      case '/':
      case '/health':
        sendJson(res, 200, getHealth());
        return;
      case '/status':
        sendJson(res, 200, getStatus());
        return;
      case '/metrics':
        sendJson(res, 200, getMetrics());
        return;
      case '/history': {
        const n = Number(url.searchParams.get('n') || '50');
        sendJson(res, 200, { ticks: getHistory(n) });
        return;
      }
      default:
        sendJson(res, 404, { error: 'not_found', paths: ['/health', '/status', '/metrics', '/history'] });
    }
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
};

// Starts the read-only observability API. Returns the server (so the caller can
// close it on shutdown) or null when disabled. Never throws -- a bind failure is
// logged and the bot keeps running headless.
export const startMetricsServer = (): Server | null => {
  if (!CONFIG.METRICS_ENABLED || !CONFIG.METRICS_HTTP_ENABLED) return null;

  const server = createServer(handle);
  server.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      logError(
        `[${TAG}] metrics port ${CONFIG.METRICS_HTTP_HOST}:${CONFIG.METRICS_HTTP_PORT} already in use -- ` +
          `another instance is likely still running or suspended (Ctrl+Z). Free it ` +
          `("kill $(lsof -ti tcp:${CONFIG.METRICS_HTTP_PORT})") or set METRICS_HTTP_PORT. Continuing headless.`,
      );
      return;
    }
    logWarn(`[${TAG}] server_error error="${e.message}"`);
  });
  server.listen(CONFIG.METRICS_HTTP_PORT, CONFIG.METRICS_HTTP_HOST, () => {
    logInfo(
      `[${TAG}] metrics api listening http://${CONFIG.METRICS_HTTP_HOST}:${CONFIG.METRICS_HTTP_PORT} (/health /status /metrics /history)`,
    );
  });
  return server;
};
