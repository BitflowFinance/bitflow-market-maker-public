/** Whole-token decimal string to an integer micro-unit string. Rejects floats. */
export const decimalToMicro = (amount: string, decimals: number): string => {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('Enter a positive amount.');
  const parts = trimmed.split('.');
  const whole = parts[0];
  const frac = parts[1] || '';
  if (frac.length > decimals) throw new Error('Too many decimal places for this token.');
  const digits = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+/, '');
  if (!digits) throw new Error('Amount must be greater than 0.');
  return digits;
};

export const microToWhole = (micro: string, decimals: number): string => {
  const digits = micro.replace(/^0+/, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
