// ============================================================
// ARC DEX — AMM Pricing Engine
// Implements Uniswap V2 constant-product formula: x * y = k
//
// amountOut = (reserveOut * amountIn * 997) / (reserveIn * 1000 + amountIn * 997)
// Fee: 0.3% (stays in pool, auto-compounds for LP holders)
//
// Security checks:
//   • Blocks swaps with price impact > 15%
//   • Warning at > 5%
//   • Slippage protection for minimum received
// ============================================================

export const AMM_FEE_NUMERATOR   = 997;
export const AMM_FEE_DENOMINATOR = 1000;
export const AMM_FEE_RATE        = 0.003; // 0.3%

// ─── Core AMM formula (x * y = k, 0.3% fee) ─────────────────────────────────
export function ammGetAmountOut(
  amountIn:   number,
  reserveIn:  number,
  reserveOut: number
): number {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  const amountInWithFee = amountIn * AMM_FEE_NUMERATOR;
  const numerator       = amountInWithFee * reserveOut;
  const denominator     = reserveIn * AMM_FEE_DENOMINATOR + amountInWithFee;
  return numerator / denominator;
}

// Reverse calculation: how much amountIn needed to get amountOut
export function ammGetAmountIn(
  amountOut:  number,
  reserveIn:  number,
  reserveOut: number
): number {
  if (amountOut <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  if (amountOut >= reserveOut) throw new Error('Amount out exceeds reserve');
  const numerator   = reserveIn * amountOut * AMM_FEE_DENOMINATOR;
  const denominator = (reserveOut - amountOut) * AMM_FEE_NUMERATOR;
  return numerator / denominator + 1;
}

// ─── Price impact (% of reserve being consumed) ──────────────────────────────
export function calcPriceImpact(amountIn: number, reserveIn: number): number {
  if (reserveIn <= 0) return 100;
  return (amountIn / (reserveIn + amountIn)) * 100;
}

// ─── Spot price ───────────────────────────────────────────────────────────────
export function spotPrice(reserveIn: number, reserveOut: number): number {
  if (reserveIn <= 0) return 0;
  return reserveOut / reserveIn;
}

// ─── Execution price (price after swap) ──────────────────────────────────────
export function execPrice(amountIn: number, amountOut: number): number {
  if (amountIn <= 0) return 0;
  return amountOut / amountIn;
}

// ─── Fee collected for a given amountIn ──────────────────────────────────────
export function calcFee(amountIn: number): number {
  return amountIn * AMM_FEE_RATE;
}

// ─── Minimum received after slippage ─────────────────────────────────────────
export function calcMinReceived(amountOut: number, slippagePct: number): number {
  return amountOut * (1 - slippagePct / 100);
}

// ─── Full swap quote ──────────────────────────────────────────────────────────
export interface SwapQuote {
  amountIn:          number;
  amountOut:         number;
  fee:               number;
  feePercent:        number;
  priceImpact:       number;
  priceImpactPct:    string;
  minimumReceived:   number;
  spotPrice:         number;
  execPrice:         number;
  slippage:          number;
  highImpactWarning: boolean;
  rejectSwap:        boolean;
  route:             string;
  poolId:            string;
}

export function buildSwapQuote(
  amountIn:     number,
  reserveIn:    number,
  reserveOut:   number,
  fromToken:    string,
  toToken:      string,
  poolId:       string,
  slippagePct   = 0.5
): SwapQuote {
  const amountOut      = ammGetAmountOut(amountIn, reserveIn, reserveOut);
  const fee            = calcFee(amountIn);
  const priceImpact    = calcPriceImpact(amountIn, reserveIn);
  const minimumReceived = calcMinReceived(amountOut, slippagePct);
  const sp             = spotPrice(reserveIn, reserveOut);
  const ep             = execPrice(amountIn, amountOut);

  return {
    amountIn,
    amountOut,
    fee,
    feePercent:        AMM_FEE_RATE * 100,
    priceImpact,
    priceImpactPct:    `${priceImpact.toFixed(4)}%`,
    minimumReceived,
    spotPrice:         sp,
    execPrice:         ep,
    slippage:          slippagePct,
    highImpactWarning: priceImpact > 5,
    rejectSwap:        priceImpact > 15,
    route:             `${fromToken} → ${toToken} (Direct, ${poolId})`,
    poolId,
  };
}

// ─── LP Token minting ─────────────────────────────────────────────────────────

// First provider: LP = sqrt(amountA * amountB)
export function lpFirstMint(amountA: number, amountB: number): number {
  if (amountA <= 0 || amountB <= 0) return 0;
  return Math.sqrt(amountA * amountB);
}

// Subsequent providers: LP = min(amountA / reserveA, amountB / reserveB) * totalLP
export function lpSubsequentMint(
  amountA:      number,
  amountB:      number,
  reserveA:     number,
  reserveB:     number,
  totalLiquidity: number
): number {
  if (reserveA <= 0 || reserveB <= 0 || totalLiquidity <= 0) return 0;
  const lpFromA = (amountA / reserveA) * totalLiquidity;
  const lpFromB = (amountB / reserveB) * totalLiquidity;
  return Math.min(lpFromA, lpFromB);
}

// ─── LP Token burning (returns) ───────────────────────────────────────────────
export function lpBurnReturns(
  lpAmount:       number,
  totalLiquidity: number,
  reserveA:       number,
  reserveB:       number
): { amountA: number; amountB: number } {
  if (totalLiquidity <= 0) return { amountA: 0, amountB: 0 };
  const share  = lpAmount / totalLiquidity;
  return {
    amountA: share * reserveA,
    amountB: share * reserveB,
  };
}

// ─── Pool share percent ───────────────────────────────────────────────────────
export function calcShare(lpAmount: number, totalLiquidity: number): number {
  if (totalLiquidity <= 0) return 0;
  return (lpAmount / totalLiquidity) * 100;
}

// ─── Impermanent loss calculation ─────────────────────────────────────────────
// IL = 2 * sqrt(r) / (1 + r) - 1
// where r = current price ratio / initial price ratio
export function calcImpermanentLoss(priceChangePct: number): number {
  const r = 1 + priceChangePct / 100;
  return (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
}

// ─── APR estimation ───────────────────────────────────────────────────────────
// APR = (24h fees * 365) / TVL
export function calcAPR(volume24h: number, fee: number, tvl: number): number {
  if (tvl <= 0) return 0;
  return ((volume24h * fee * 365) / tvl) * 100;
}

// ─── TVL calculation in USD ───────────────────────────────────────────────────
export function calcTVL(
  reserveA: number,
  reserveB: number,
  priceA:   number,
  priceB:   number,
  decimals  = 6
): number {
  const scale = Math.pow(10, decimals);
  return (reserveA / scale) * priceA + (reserveB / scale) * priceB;
}
