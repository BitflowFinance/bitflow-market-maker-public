// Pure shaping math for the curve strategy. No I/O, no config -- callers pass in
// the geometry so this stays trivially testable and reusable by both the
// strategy (to describe the shape) and the liquidity layer (to size positions).

export interface CurveLeg {
  // Bin offset relative to the active bin (0 = active, >0 = above, <0 = below).
  offset: number;
  // Relative weight (unnormalized) for this leg.
  weight: number;
}

// Symmetric geometric curve: weight = decay^|offset|, so the active bin is
// heaviest and depth tapers outward. halfWidth bins on each side (total
// 2*halfWidth + 1 legs). decay in (0,1].
export const curveWeights = (halfWidth: number, decay: number): CurveLeg[] => {
  const h = Math.max(0, Math.floor(halfWidth));
  const d = Math.min(1, Math.max(0, decay));
  const legs: CurveLeg[] = [];
  for (let k = -h; k <= h; k += 1) {
    legs.push({ offset: k || 0, weight: d ** Math.abs(k) });
  }
  return legs;
};

// Multiplier on the base cash (C / quote) deployment, from the inventory fraction
// f = V/(V+C). Three regimes around the neutral f*:
//  - f >= f_soft: 0 -- bids fully pulled (M4 saturated).
//  - f* <= f < f_soft: 1 -> 0 linearly (M4 "pull bids": stop buying V, let it
//    bleed off through the asks).
//  - f < f*: 1 -> leanMax linearly as f -> 0 (M6 cash-heavy bid-lean: deploy MORE
//    cash as bids to re-accumulate V passively; leanMax=1 disables the lean).
// Base (V) is unaffected -- it always deploys as asks (no idle V). >1 results are
// clamped to available cash by the caller. Pure; caller supplies the levels.
export const bidFractionFromF = (
  f: number,
  fStar: number,
  fSoft: number,
  leanMax = 1,
): number => {
  if (f >= fStar) {
    if (fSoft <= fStar) return f >= fSoft ? 0 : 1;
    const skew = (f - fStar) / (fSoft - fStar);
    return 1 - Math.min(1, Math.max(0, skew));
  }
  const max = Math.max(1, leanMax);
  const t = fStar > 0 ? Math.min(1, Math.max(0, (fStar - f) / fStar)) : 0;
  return 1 + (max - 1) * t;
};

// Volatility-scaled width (M2). baseHalf is the half-width (bins/side) at the
// reference vol sigmaRef; above it the curve widens in proportion to sigma/sigmaRef
// (capped at maxHalf), at/under it stays at baseHalf. sigmaRef<=0 or sigma<=0
// disables scaling (falls back to baseHalf). Pure; caller supplies the levels.
export const volHalfWidthBins = (
  baseHalf: number,
  maxHalf: number,
  sigma: number,
  sigmaRef: number,
): number => {
  const base = Math.max(1, Math.floor(baseHalf));
  const cap = Math.max(base, Math.floor(maxHalf));
  if (!(sigmaRef > 0) || !(sigma > 0)) return base;
  const scaled = Math.round(base * Math.max(1, sigma / sigmaRef));
  return Math.min(cap, Math.max(base, scaled));
};

// Volatility-scaled size (M2). baseSize is the deployed fraction at sigmaRef; above
// it the fraction shrinks in proportion to sigmaRef/sigma (reserve more), floored
// at minSize; at/under sigmaRef stays at baseSize (never grows past the baseline).
// sigmaRef<=0 or sigma<=0 disables scaling. Pure; caller supplies the levels.
export const volSizeFraction = (
  baseSize: number,
  minSize: number,
  sigma: number,
  sigmaRef: number,
): number => {
  const base = Math.min(1, Math.max(0, baseSize));
  const floor = Math.min(base, Math.max(0, minSize));
  if (!(sigmaRef > 0) || !(sigma > 0)) return base;
  const scaled = base / Math.max(1, sigma / sigmaRef);
  return Math.min(base, Math.max(floor, scaled));
};

// Volatility-scaled reposition drift tolerance (M2b, opt-in "churn cooldown").
// baseDrift is the drift trigger (bins from center) at sigmaRef; above it the
// tolerance widens in proportion to sigma/sigmaRef (capped at maxDrift) so we
// reposition LESS during vol spikes -- reposition churn is most expensive exactly
// when the tape is moving fast. At/under sigmaRef it stays at baseDrift. maxDrift
// <= baseDrift (the default), or sigmaRef<=0/sigma<=0, disables it entirely and
// returns baseDrift (current behavior). Pure; caller supplies the levels.
export const volRepositionDriftBins = (
  baseDrift: number,
  maxDrift: number,
  sigma: number,
  sigmaRef: number,
): number => {
  const base = Math.max(1, Math.floor(baseDrift));
  const cap = Math.max(base, Math.floor(maxDrift));
  if (cap <= base || !(sigmaRef > 0) || !(sigma > 0)) return base;
  const scaled = Math.round(base * Math.max(1, sigma / sigmaRef));
  return Math.min(cap, Math.max(base, scaled));
};

export interface CurvePosition {
  offset: number;
  // Amount placed on the "upper" (X / at-or-above active) side at this offset.
  upper: bigint;
  // Amount placed on the "lower" (Y / at-or-below active) side at this offset.
  lower: bigint;
}

// Distribute `upperMicro` across legs at offset >= 0 and `lowerMicro` across legs
// at offset <= 0, proportional to weight. DLMM holds only the X token above the
// active bin and only Y below it, with both at the active bin -- so the active
// leg (offset 0) draws from BOTH pools and is the only two-sided position. The
// caller maps upper->X and lower->Y (or via base/quote orientation). Amounts are
// in each side's own micro-units (decimals are irrelevant here).
export const allocateCurve = (
  legs: CurveLeg[],
  upperMicro: bigint,
  lowerMicro: bigint,
): CurvePosition[] => {
  const upperLegs = legs.filter((l) => l.offset >= 0 && l.weight > 0);
  const lowerLegs = legs.filter((l) => l.offset <= 0 && l.weight > 0);
  const upperSum = upperLegs.reduce((s, l) => s + l.weight, 0);
  const lowerSum = lowerLegs.reduce((s, l) => s + l.weight, 0);

  const byOffset = new Map<number, CurvePosition>();
  for (const l of legs) byOffset.set(l.offset, { offset: l.offset, upper: BigInt(0), lower: BigInt(0) });

  if (upperSum > 0 && upperMicro > BigInt(0)) {
    for (const l of upperLegs) {
      const amt = Math.floor((Number(upperMicro) * l.weight) / upperSum);
      byOffset.get(l.offset)!.upper = BigInt(Math.max(0, amt));
    }
  }
  if (lowerSum > 0 && lowerMicro > BigInt(0)) {
    for (const l of lowerLegs) {
      const amt = Math.floor((Number(lowerMicro) * l.weight) / lowerSum);
      byOffset.get(l.offset)!.lower = BigInt(Math.max(0, amt));
    }
  }

  return legs
    .map((l) => byOffset.get(l.offset)!)
    .filter((p) => p.upper > BigInt(0) || p.lower > BigInt(0));
};
