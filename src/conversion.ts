// Inventory conversion for this bot is swap-only: there is no external
// mint/redeem path. Shifting value between sides goes through a pool swap,
// which moves the active bin -- the curve strategy owns that trade-off.

export interface SwapOnlyConversion {
  kind: 'swap_only';
}

export type Conversion = SwapOnlyConversion;

export const swapOnly: SwapOnlyConversion = { kind: 'swap_only' };
