import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { demoBridge } from './bridgeDemo';
import { liveBridgeClient } from './bridgeLive';
import { processHost } from './host';
import { livePoolDepth } from './poolDepth';
import { livePoolCatalog } from './pools';
import { liveWalletTokens } from './walletTokens';
import { listenConsole } from './server';
import { ConsoleStore } from './store';

const root = process.cwd();
const apiPort = Number(process.env.CONSOLE_API_PORT || 4173);
const pagePort = Number(process.env.CONSOLE_PAGE_PORT || 5191);

const main = async (): Promise<void> => {
  if (!existsSync(join(root, 'ui', 'node_modules'))) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', '--prefix', 'ui', '--no-audit', '--no-fund'], {
        cwd: root,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', (status) => (status === 0 ? resolve() : reject(new Error(`ui install exited ${status}`))));
    });
  }

  const demo = process.env.CONSOLE_BRIDGE_DEMO === '1' ? demoBridge() : null;
  const store = new ConsoleStore(root, processHost(root), demo || liveBridgeClient(), Date.now(), livePoolDepth(), livePoolCatalog(), liveWalletTokens());
  store.bridgeDemo = demo;
  await listenConsole(store, apiPort);
  // Deposits are found and registered with the signers from here, so they go through even with the page closed.
  setInterval(() => void store.syncBridges(new Date()).catch(() => undefined), demo ? 3000 : 20_000);

  const vite = spawn('npm', ['run', 'dev', '--prefix', 'ui', '--', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CONSOLE_API_PORT: String(apiPort) },
  });

  console.log('');
  console.log(`Bitflow Market Maker is running: http://127.0.0.1:${pagePort}`);
  console.log('Only this computer can open it. Bots started from the page stop when this process stops.');
  if (demo) console.log('Bridge demo mode: balances and transfers on the Bridge page are made up. Do not send real BTC.');
  console.log('');

  const shutdown = (): void => {
    vite.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
