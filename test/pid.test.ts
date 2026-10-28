import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { clearPidFile, writePidFile } from '../src/pid';

describe('pid file', () => {
  it('writes the process id and removes it only when it still matches', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mm-pid-')), 'bot.pid');
    writePidFile(file, 4242);
    expect(readFileSync(file, 'utf8').trim()).toBe('4242');

    clearPidFile(file, 1);
    expect(existsSync(file)).toBe(true);

    clearPidFile(file, 4242);
    expect(existsSync(file)).toBe(false);
  });

  it('creates the parent directory', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mm-pid-')), 'nested', 'bot.pid');
    writePidFile(file, 7);
    expect(existsSync(file)).toBe(true);
  });

  it('ignores a missing file on clear', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mm-pid-')), 'missing.pid');
    writeFileSync(join(file, '..', 'keep'), '');
    expect(() => clearPidFile(file, 1)).not.toThrow();
  });
});
