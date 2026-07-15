// ============================================================
// DEX Metrics Engine — SimpleAMM (EURC/USDC) · READ-ONLY
// ============================================================
// Phase 2 hardening:
//   • Pure functions — no RPC, no writes, no side effects.
//   • Every number derives EXCLUSIVELY from verified on-chain
//     reserves passed in by the caller (dex-cache snapshots).
//   • No external price APIs, no fake market prices, no
//     hardcoded reserves.
//
// Includes:
//   calcPriceRatio / calcTvl / calcReserveRatio
//   simulateLiquidityDepth  (10 → 10,000 USDC ladder)
//   detectDonations         (balanceOf vs tracked reserves)
//   classifyPool            (HEALTHY … CRITICAL, informational)
// ============================================================

export const FEE_NUM = 997n;
export const FEE_DENOM = 1000n;

// Liquidity depth ladder (USDC, human units) — Phase 2 Part 4
export const DEPTH_LEVELS_USDC = [10, 50, 100, 500, 1000, 5000, 10000];

// Classification thresholds (informational only — Phase 2 Part 6)
export const HEALTH_THRESHOLDS = {
  TVL_HEALTHY_USDC: 50_000,   // ≥ 50k USDC and low impact → HEALTHY
  TVL_LOW_USDC: 10_000,       // < 10k USDC → LOW_LIQUIDITY
  IMPACT_HEALTHY_PCT: 2,      // 1,000 USDC swap impact ≤ 2% → HEALTHY
  IMPACT_WARNING_PCT: 5,      // 1,000 USDC swap impact > 5% → WARNING
  PRICE_IMBALANCE_MIN: 0.5,   // EURC/USDC spot outside [0.5, 2.0] → IMBALANCED
  PRICE_IMBALANCE_MAX: 2.0,
  DONATION_WARNING_PCT: 1,    // untracked surplus > 1% of reserve → WARNING
};

export const HEALTH_LABELS = {
  HEALTHY: 'Healthy',
  GOOD: 'Good',
  WARNING: 'Warning',
  LOW_LIQUIDITY: 'Low Liquidity',
  IMBALANCED: 'Imbalanced',
  CRITICAL: 'Critical',
};

// ─── Core AMM math (mirrors SimpleAMM.getAmountOut, 0.3% fee) ────────────────
export function ammGetAmountOut(amountIn, rIn, rOut) {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const amountInWithFee = amountIn * FEE_NUM;
  return (amountInWithFee * rOut) / (rIn * FEE_DENOM + amountInWithFee);
}

export function sqrtBigInt(y) {
  if (y < 0n) throw new Error('sqrt of negative');
  if (y < 4n) return y === 0n ? 0n : 1n;
  let z = y;
  let x = y / 2n + 1n;
  while (x < z) { z = x; x = (y / x + x) / 2n; }
  return z;
}

// ─── Ratios / TVL (derived ONLY from verified reserves) ──────────────────────
export function calcPriceRatio(reserveA, reserveB) {
  const rA = Number(reserveA);
  const rB = Number(reserveB);
  return {
    priceAinB: rA > 0 ? rB / rA : 0,  // 1 EURC = X USDC
    priceBinA: rB > 0 ? rA / rB : 0,  // 1 USDC = X EURC
  };
}

/**
 * TVL in USDC terms using the pool's own spot price:
 * value(A side in B units) = rA * (rB/rA) = rB → TVL = 2 * rB.
 * No external market price is used (Phase 2 mandate).
 */
export function calcTvl(reserveA, reserveB) {
  if (reserveA <= 0n || reserveB <= 0n) return 0;
  return (2 * Number(reserveB)) / 1e6;
}

export function calcReserveRatio(reserveA, reserveB) {
  const rB = Number(reserveB);
  return rB > 0 ? Number(reserveA) / rB : 0;
}

/** sqrt(k) / totalSupply — 1.0 at genesis, grows with fees + donations. */
export function calcLpValueIndex(reserveA, reserveB, totalSupply) {
  if (totalSupply <= 0n) return 0;
  return Number(sqrtBigInt(reserveA * reserveB)) / Number(totalSupply);
}

// ─── Liquidity depth simulator (Phase 2 Part 4) ──────────────────────────────
/**
 * Simulates USDC → EURC swaps at the standard ladder using ONLY
 * verified reserves. slippage = total deviation from spot (incl. 0.3% fee);
 * priceImpact = depth-only component (fee excluded).
 */
export function simulateLiquidityDepth(reserveA, reserveB, levels = DEPTH_LEVELS_USDC) {
  const rIn = reserveB;   // USDC in
  const rOut = reserveA;  // EURC out
  if (rIn <= 0n || rOut <= 0n) {
    return levels.map((amount) => ({
      amountIn: amount,
      estimatedAmountOut: 0,
      priceImpact: null,
      slippage: null,
      minimumAmountOut: 0,
      exceedsLiquidity: true,
    }));
  }
  const spot = Number(rOut) / Number(rIn); // EURC per USDC (pre-fee)

  return levels.map((amount) => {
    const amountInRaw = BigInt(Math.round(amount * 1e6));
    const outRaw = ammGetAmountOut(amountInRaw, rIn, rOut);
    const out = Number(outRaw) / 1e6;
    const ideal = amount * spot;                    // no fee, no impact
    const idealAfterFee = ideal * 0.997;            // fee only, no impact
    const slippage = ideal > 0 ? (1 - out / ideal) * 100 : null;
    const priceImpact = idealAfterFee > 0 ? (1 - out / idealAfterFee) * 100 : null;
    const minimumAmountOut = (Number(outRaw * 995n / 1000n)) / 1e6; // 0.5% tolerance

    return {
      amountIn: amount,
      estimatedAmountOut: round6(out),
      priceImpact: priceImpact === null ? null : round4(priceImpact),
      slippage: slippage === null ? null : round4(slippage),
      minimumAmountOut: round6(minimumAmountOut),
      exceedsLiquidity: outRaw >= rOut,
    };
  });
}

// ─── Donation / excess-asset detection (Phase 2 Part 5) ──────────────────────
/**
 * Compares actual token.balanceOf(SimpleAMM) with tracked reserves.
 * Read-only: surplus is reported, never touched.
 */
export function detectDonations({ reserveA, reserveB, balanceA, balanceB, blockNumber = null, timestamp = null }) {
  const excess = [];

  const excessA = balanceA - reserveA;
  if (excessA > 0n) {
    excess.push({
      asset: 'EURC',
      excessRaw: excessA.toString(),
      excessAmount: round6(Number(excessA) / 1e6),
      pctOfReserve: reserveA > 0n ? round4((Number(excessA) / Number(reserveA)) * 100) : null,
    });
  }
  const excessB = balanceB - reserveB;
  if (excessB > 0n) {
    excess.push({
      asset: 'USDC',
      excessRaw: excessB.toString(),
      excessAmount: round6(Number(excessB) / 1e6),
      pctOfReserve: reserveB > 0n ? round4((Number(excessB) / Number(reserveB)) * 100) : null,
    });
  }

  // Deficit should be impossible (reserves are internal accounting) —
  // if it ever happens it is a solvency red flag.
  const deficit = [];
  if (excessA < 0n) deficit.push({ asset: 'EURC', deficitRaw: (-excessA).toString(), deficitAmount: round6(Number(-excessA) / 1e6) });
  if (excessB < 0n) deficit.push({ asset: 'USDC', deficitRaw: (-excessB).toString(), deficitAmount: round6(Number(-excessB) / 1e6) });

  return {
    status: deficit.length > 0 ? 'DEFICIT_ALERT' : (excess.length > 0 ? 'EXCESS_DETECTED' : 'CLEAN'),
    excess,
    deficit,
    blockNumber,
    timestamp,
  };
}

// ─── Pool classifier (Phase 2 Part 6 — informational only) ───────────────────
/**
 * Input metrics must derive from a verified snapshot:
 *   { reserveA, reserveB, totalSupply, tvl, impact1000Pct, priceAinB, donation }
 */
export function classifyPool(metrics) {
  const t = HEALTH_THRESHOLDS;
  const reasons = [];
  let status = 'HEALTHY';

  const empty = metrics.reserveA <= 0n || metrics.reserveB <= 0n || metrics.totalSupply <= 0n;
  const donationPct = Math.max(
    0,
    ...((metrics.donation && metrics.donation.excess) || []).map((e) => e.pctOfReserve || 0),
  );

  if (empty) {
    status = 'CRITICAL';
    reasons.push('Pool has no liquidity (empty reserves or zero LP supply)');
  } else if (metrics.donation && metrics.donation.status === 'DEFICIT_ALERT') {
    status = 'CRITICAL';
    reasons.push('Token balances are below tracked reserves (solvency alert)');
  } else if (metrics.priceAinB < t.PRICE_IMBALANCE_MIN || metrics.priceAinB > t.PRICE_IMBALANCE_MAX) {
    status = 'IMBALANCED';
    reasons.push(`Spot price ${metrics.priceAinB.toFixed(4)} USDC/EURC is outside [${t.PRICE_IMBALANCE_MIN}, ${t.PRICE_IMBALANCE_MAX}]`);
  } else if (metrics.tvl < t.TVL_LOW_USDC) {
    status = 'LOW_LIQUIDITY';
    reasons.push(`TVL ${metrics.tvl.toFixed(2)} USDC is below ${t.TVL_LOW_USDC}`);
  } else if (metrics.impact1000Pct > t.IMPACT_WARNING_PCT) {
    status = 'WARNING';
    reasons.push(`Price impact for 1,000 USDC is ${metrics.impact1000Pct.toFixed(2)}% (> ${t.IMPACT_WARNING_PCT}%)`);
  } else if (donationPct > t.DONATION_WARNING_PCT) {
    status = 'WARNING';
    reasons.push(`Untracked surplus is ${donationPct.toFixed(2)}% of reserves (> ${t.DONATION_WARNING_PCT}%)`);
  } else if (metrics.tvl < t.TVL_HEALTHY_USDC || metrics.impact1000Pct > t.IMPACT_HEALTHY_PCT) {
    status = 'GOOD';
    if (metrics.tvl < t.TVL_HEALTHY_USDC) reasons.push(`TVL ${metrics.tvl.toFixed(2)} USDC is below the ${t.TVL_HEALTHY_USDC} HEALTHY threshold`);
    if (metrics.impact1000Pct > t.IMPACT_HEALTHY_PCT) reasons.push(`Price impact for 1,000 USDC is ${metrics.impact1000Pct.toFixed(2)}% (> ${t.IMPACT_HEALTHY_PCT}%)`);
  } else {
    reasons.push('TVL and liquidity depth are within healthy thresholds');
  }

  return { status, label: HEALTH_LABELS[status], reasons };
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function round4(n) { return Math.round(n * 1e4) / 1e4; }
function round6(n) { return Math.round(n * 1e6) / 1e6; }
