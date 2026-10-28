import { execFileSync, spawn } from 'child_process';
import { existsSync, openSync } from 'fs';
import { join } from 'path';
import { ConsoleHost } from './store';

const launchCommand = (root: string): string[] => {
  const dist = join(root, 'dist', 'index.js');
  if (existsSync(dist)) return [process.execPath, dist];
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return [process.execPath, tsx, join(root, 'src', 'index.ts')];
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const processHost = (root: string): ConsoleHost => ({
  spawn: (profile) => {
    const cmd = launchCommand(root);
    const logPath = join(root, 'data', `bot.${profile}.log`);
    const out = openSync(logPath, 'a');
    const child = spawn(cmd[0], [...cmd.slice(1), '--pool', profile], {
      cwd: root,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.unref();
    if (!child.pid) throw new Error('The bot process did not start.');
    return child.pid;
  },
  stop: (pid) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw err;
    }
  },
  alive: (pid) => isAlive(pid),
  isBot: (pid, profile) => {
    try {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return /index\.(ts|js)\b/.test(command) && command.includes(`--pool ${profile}`);
    } catch (err) {
      // No `ps` (Windows): fall back to trusting the pid file, as before.
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? isAlive(pid) : false;
    }
  },
  runManual: (profile, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const cmd = launchCommand(root);
      const child = spawn(cmd[0], [...cmd.slice(1), '--pool', profile, ...args], {
        cwd: root,
        env: process.env,
      });
      let output = '';
      const take = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        output += text;
        if (opts.onOutput) opts.onOutput(text);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, opts.timeoutMs || 120_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(output.slice(-4000));
      });
    }),
  readRemote: async (profile, port) => {
    void profile;
    const pull = async (path: string): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!res.ok) return '';
      return res.text();
    };
    try {
      const historyText = await pull('/history?n=200');
      const parsed = historyText ? (JSON.parse(historyText) as { ticks?: [] }) : {};
      return { history: parsed.ticks || [], log: '' };
    } catch {
      return { history: [], log: '' };
    }
  },
});
