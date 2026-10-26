import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config';

/** Record the running loop so a local UI can stop this process. */
export const writePidFile = (file = CONFIG.PID_FILE, pid = process.pid): void => {
  const dir = dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${pid}\n`);
};

/** Remove the pid file only when it still names this process. */
export const clearPidFile = (file = CONFIG.PID_FILE, pid = process.pid): void => {
  if (!file || !existsSync(file)) return;
  try {
    const current = readFileSync(file, 'utf8').trim();
    if (current === String(pid)) rmSync(file);
  } catch {
    // Already gone, or not ours to remove.
  }
};
