import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve, sep } from 'path';

export const readEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

/** Replace listed keys in place and append any that were missing. Comments stay. */
export const upsertEnv = (text: string, updates: Record<string, string>): string => {
  const seen = new Set<string>();
  const next = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const key of Object.keys(updates)) {
    if (!seen.has(key)) next.push(`${key}=${updates[key]}`);
  }
  const body = next.join('\n');
  return body.endsWith('\n') ? body : `${body}\n`;
};

export const readEnvFile = (file: string): Record<string, string> => {
  if (!existsSync(file)) return {};
  return readEnv(readFileSync(file, 'utf8'));
};

// Env files hold SIGNER_KEY. `mode` only applies when the file is created, so
// chmod as well to tighten a file that already existed with the default 0644.
export const writeSecretFile = (file: string, text: string): void => {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
};

export const tightenSecretFile = (file: string): void => {
  if (existsSync(file)) chmodSync(file, 0o600);
};

export const writeEnvUpdates = (file: string, updates: Record<string, string>): void => {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeSecretFile(file, upsertEnv(current, updates));
};

/** Resolve a repo-relative path and refuse anything that leaves the repo. */
export const insideRoot = (root: string, file: string): string => {
  const base = resolve(root);
  const abs = resolve(base, file);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error('That path is outside this repo.');
  }
  if (isAbsolute(file) && !file.startsWith(base + sep) && file !== base) {
    throw new Error('That path is outside this repo.');
  }
  return abs;
};

export const touchFile = (file: string): void => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${new Date().toISOString()}\n`);
};

export const removeFile = (file: string): void => {
  if (existsSync(file)) rmSync(file);
};
