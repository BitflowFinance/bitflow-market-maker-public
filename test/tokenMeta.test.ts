import { describe, expect, it } from 'vitest';
import { BffTokenMeta, CONFIG, hydrateTokenMetadata } from '../src/config';

const baseContract = CONFIG.BASE_TOKEN_CONTRACT;
const quoteContract = CONFIG.QUOTE_TOKEN_CONTRACT;

describe('hydrateTokenMetadata', () => {
  it('fills base/quote asset names + decimals from the BFF', () => {
    const tokens: BffTokenMeta[] = [
      { contract_address: baseContract, asset_name: 'sbtc-token', decimals: 8 },
      { contract_address: quoteContract, asset_name: 'usdcx-token', decimals: 6 },
    ];
    const { summary, warnings } = hydrateTokenMetadata(tokens);
    expect(CONFIG.BASE_ASSET_NAME).toBe('sbtc-token');
    expect(CONFIG.BASE_DECIMALS).toBe(8);
    expect(CONFIG.QUOTE_ASSET_NAME).toBe('usdcx-token');
    expect(CONFIG.QUOTE_DECIMALS).toBe(6);
    expect(summary).toContain('base=sbtc-token/8d');
    expect(warnings).toEqual([]);
  });

  it('falls back to the BFF symbol when asset_name is "unknown" (native-STX wrapper)', () => {
    const prevName = CONFIG.BASE_ASSET_NAME;
    const prevDec = CONFIG.BASE_DECIMALS;
    try {
      hydrateTokenMetadata([
        { contract_address: baseContract, asset_name: 'unknown', decimals: 6, symbol: 'STX' },
      ]);
      expect(CONFIG.BASE_ASSET_NAME).toBe('stx');
      expect(CONFIG.BASE_DECIMALS).toBe(6);
    } finally {
      CONFIG.BASE_ASSET_NAME = prevName;
      CONFIG.BASE_DECIMALS = prevDec;
    }
  });

  it('adopts the BFF asset name + decimals for a different contract', () => {
    const prevName = CONFIG.BASE_ASSET_NAME;
    const prevDec = CONFIG.BASE_DECIMALS;
    try {
      hydrateTokenMetadata([{ contract_address: baseContract, asset_name: 'sbtc-token', decimals: 8 }]);
      expect(CONFIG.BASE_ASSET_NAME).toBe('sbtc-token');
      expect(CONFIG.BASE_DECIMALS).toBe(8);
    } finally {
      CONFIG.BASE_ASSET_NAME = prevName;
      CONFIG.BASE_DECIMALS = prevDec;
    }
  });

  it('keeps the default and warns when a token is missing from the BFF', () => {
    const prevName = CONFIG.BASE_ASSET_NAME;
    const { warnings } = hydrateTokenMetadata([]);
    expect(CONFIG.BASE_ASSET_NAME).toBe(prevName);
    expect(warnings.some((w) => w.includes('not in BFF tokens'))).toBe(true);
  });
});
