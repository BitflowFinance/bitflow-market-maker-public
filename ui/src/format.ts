export const usd = (value: number | null | undefined, signed = false): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs !== 0 && abs < 0.01 ? 4 : 2;
  const text = abs.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
  if (value < 0) return `−${text}`;
  return signed && value > 0 ? `+${text}` : text;
};

const DIGITS: Record<string, number> = { sBTC: 8, BTC: 8, STX: 2, USDCx: 2, USDC: 2 };

export const tok = (value: number | null | undefined, symbol: string): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  const max = DIGITS[symbol] ?? 4;
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: max })} ${symbol}`;
};

export const price = (value: number | null | undefined, quote: string): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : 4;
  return `${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${quote}`;
};

export const pct = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
};

export const ago = (iso: string | null | undefined, now: number): string => {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
};

export const clock = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (d.toDateString() === new Date().toDateString()) return time;
  // Past today, a bare time is ambiguous; drop seconds to make room for the date.
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time.slice(0, 5)}`;
};

/** m:ss until a moment, or null once it has passed. */
export const countdown = (targetMs: number, now: number): string | null => {
  const sec = Math.round((targetMs - now) / 1000);
  if (sec <= 0) return null;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

export const stx = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} STX`;
};

/** The contract name part of a pool id; the deployer address adds nothing on screen. */
export const poolName = (poolId: string): string => poolId.split('.').pop() || poolId;

export const shortAddr = (address: string | null | undefined): string => {
  if (!address) return '';
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
};
