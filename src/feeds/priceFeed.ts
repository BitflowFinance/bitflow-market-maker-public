import { Conversion } from '../conversion';

// Fair value for a pool. This bot quotes around the live active bin rather than
// a canonical NAV; CoinGecko fills `reference` instead. Spreads of 0 collapse
// the band to a point price.
export interface FairValue {
  price: number;
  lowerSpreadBps: number;
  upperSpreadBps: number;
}

// External reference (e.g. CoinGecko BTC/USD or STX/USD). This is NOT a price
// the bot pushes the pool toward -- it's context (price + freshness + recent
// vol) the curve uses to size/center quotes around the live active bin.
export interface ReferencePrice {
  price: number;
  ageMs: number;
  volatility?: number;
}

// Peg health for a wrapped asset (e.g. sBTC vs BTC). `broken` lets the curve
// halt when the asset it quotes has de-pegged. Unpegged assets omit it.
export interface PegStatus {
  deviationBps: number;
  broken: boolean;
}

export interface MarketReading {
  target?: FairValue;
  reference?: ReferencePrice;
  peg?: PegStatus;
  conversion: Conversion;
  conversionError?: string;
}

export interface PriceFeed {
  readonly name: string;
  read(): Promise<MarketReading>;
}
