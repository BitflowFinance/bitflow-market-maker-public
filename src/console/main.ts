import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { liveBridgeClient } from './bridgeLive';
import { processHost } from './host';
import { livePoolDepth } from './poolDepth';
import { livePoolCatalog } from './pools';
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

  const store = new ConsoleStore(root, processHost(root), liveBridgeClient(), Date.now(), livePoolDepth(), livePoolCatalog());
  await listenConsole(store, apiPort);

  const vite = spawn('npm', ['run', 'dev', '--prefix', 'ui', '--', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CONSOLE_API_PORT: String(apiPort) },
  });

  console.log('');
  console.log(`Bitflow MM is running: http://127.0.0.1:${pagePort}`);
  console.log('Only this computer can open it. Bots started from the page stop when this process stops.');
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
