// ============================================================
// Pool Analytics Engine — SimpleAMM (Phase 3) · READ-ONLY
// ============================================================
//   • PoolAnalyticsSnapshot: canonical analytics source of truth,
//     derived EXCLUSIVELY from the verified DEX cache snapshot
//     (Phase 2). One RPC snapshot is shared by every endpoint.
//   • Memoized per verified fetch: when the cache is valid the
//     entire analytics payload is computed zero times — served
//     from memory in microseconds (Phase 3 Part 9).
//   • LP Analytics, Liquidity Ratio Analyzer, Risk Engine and
//     TWAP feasibility are informational only. NO writes, NO
//     transaction mutation, NO automatic actions.
// ============================================================

import {
  ammGetAmountOut,
  calcLpValueIndex,
  simulateLiquidityDepth,
  classifyPool,
  sqrtBigInt,
} from './dex-metrics.mjs';

// Deadline suggestion for swaps (quote-layer protection — the
// deployed v1 AMM has no on-chain deadline support).
export const DEADLINE_SUGGESTION_SEC = 300;   // 5 minutes
export const QUOTE_VALIDITY_MS = 15_000;      // mirrors cache TTL

// Selectors probed against deployed bytecode (Part 1 / Part 2)
export const CAPABILITY_SELECTORS = {
  swapAforB_v1: '140e6247',        // swapAforB(uint256,uint256)
  swapBforA_v1: 'c915cc24',        // swapBforA(uint256,uint256)
  swapAforB_deadline: 'bd5fd41c',  // swapAforB(uint256,uint256,uint256)
  swapBforA_deadline: 'd8f4d44b',  // swapBforA(uint256,uint256,uint256)
  addLiquidity: '9cd441da',
  removeLiquidity: '9c8f9f23',
  quoteAforB: '0b4a945e',
  quoteBforA: 'd9497f00',
  priceImpactBps: '5d1257e8',
  getLPBalance: 'd2258beb',
  price0CumulativeLast: '5909c0d5', // TWAP accumulator (Uniswap V2 style)
  price1CumulativeLast: '5a3d5493',
  kLast: '7464fc3d',
  sync: 'fff6cae9',
  skim: 'bc25cf77',
};

const LIQUIDITY_OPTIMAL_TOLERANCE_PCT = 0.1; // ≤0.1% of deposit donated → OPTIMAL

// ─── Capability probe (bytecode selector scan, read-only) ────────────────────
export function scanBytecodeCapabilities(bytecodeHex) {
  const code = String(bytecodeHex || '').toLowerCase();
  const caps = {};
  for (const [name, selector] of Object.entries(CAPABILITY_SELECTORS)) {
    caps[name] = code.includes(selector);
  }
  return {
    ...caps,
    bytecodeSize: code.startsWith('0x') ? (code.length - 2) / 2 : 0,
    deadlineSupportedOnChain: caps.swapAforB_deadline && caps.swapBforA_deadline,
    twapAccumulatorsOnChain: caps.price0CumulativeLast && caps.price1CumulativeLast,
    upgradeable: false, // direct deployment: no proxy dispatch, no admin surface
  };
}

// ─── TWAP feasibility (Part 7 — analysis only, never migrates) ───────────────
export function analyzeTwapFeasibility(capabilities) {
  const onChain = !!(capabilities && capabilities.twapAccumulatorsOnChain);
  return {
    onChainTwap: onChain ? 'FEASIBLE' : 'NOT_FEASIBLE',
    cumulativePriceDataExists: onChain,
    helperContractPossible: true,
    helperContractRecommended: false,
    offChainOracle: 'FEASIBLE',
    migrationRequired: false,
    detail: onChain
      ? 'Deployed AMM exposes cumulative price accumulators; on-chain TWAP is possible.'
      : 'Deployed SimpleAMM v1 has no cumulative price accumulators (price0/1CumulativeLast absent). '
        + 'On-chain TWAP would require a new deployment — forbidden (no migration). '
        + 'Feasible path: off-chain indexer over Swap/Liquidity events (reserves are emitted '
        + 'in every event) with block timestamps. See audit/PHASE3_COMPATIBILITY_REPORT.md.',
  };
}

// ─── Deadline protection (quote layer — Part 2 fallback) ─────────────────────
export function makeDeadlineGuidance(nowMs, capabilities = null) {
  const deadline = Math.floor(nowMs / 1000) + DEADLINE_SUGGESTION_SEC;
  return {
    deadlineSuggestion: deadline,                       // unix seconds
    deadlineSuggestionISO: new Date(deadline * 1000).toISOString(),
    quoteExpiresAt: new Date(nowMs + QUOTE_VALIDITY_MS).toISOString(),
    deadlineSupportedOnChain: !!(capabilities && capabilities.deadlineSupportedOnChain),
    note: (capabilities && capabilities.deadlineSupportedOnChain)
      ? 'Pass deadline to swapAforB/swapBforA (uint256,uint256,uint256) overloads.'
      : 'Deployed AMM v1 has no deadline parameter — treat quotes older than quoteExpiresAt as stale and re-quote before signing.',
  };
}

export function isDeadlineValid(deadlineUnixSec, nowMs) {
  const d = Number(deadlineUnixSec);
  if (!Number.isFinite(d) || d <= 0) return false;
  return d * 1000 >= nowMs;
}

// ─── LP Analytics Engine (Part 4 — read-only) ────────────────────────────────
export function calcLpAnalytics(snapshot, minimumLiquidity = null) {
  const { reserveA, reserveB, totalSupply, tvl } = snapshot;
  const supplyHuman = Number(totalSupply) / 1e6;
  const growthIndex = calcLpValueIndex(reserveA, reserveB, totalSupply);
  const lpValueUsdc = totalSupply > 0n ? tvl / supplyHuman : 0;
  const minLock = minimumLiquidity !== null ? minimumLiquidity : null;
  const minLockPct = minLock !== null && totalSupply > 0n
    ? (Number(minLock) / Number(totalSupply)) * 100
    : null;

  let lpHealth = 'HEALTHY';
  if (totalSupply <= 0n) lpHealth = 'CRITICAL';
  else if (growthIndex < 1) lpHealth = 'WARNING';       // below genesis parity
  else if (tvl < 10_000) lpHealth = 'LOW_LIQUIDITY';

  return {
    lpSupply: totalSupply.toString(),
    lpSupplyHuman: round6(supplyHuman),
    lpValueUsdc: round6(lpValueUsdc),                    // USDC value per 1.0 LP token
    growthIndex: round6(growthIndex),                    // sqrt(k)/supply — 1.0 at genesis
    utilization: round6(growthIndex),                    // value accrued per LP unit
    minimumLiquidityLock: minLock !== null ? minLock.toString() : null,
    minimumLiquidityLockPct: minLockPct !== null ? round6(minLockPct) : null,
    lpHealth,
  };
}

/** Wallet-level LP position, from verified reserves. Read-only. */
export function calcLpPosition(snapshot, lpBalance) {
  const { reserveA, reserveB, totalSupply } = snapshot;
  if (totalSupply <= 0n) {
    return {
      lpBalance: lpBalance.toString(), lpBalanceHuman: 0,
      sharePercent: 0, withdrawableA: 0, withdrawableB: 0, valueUsdc: 0,
    };
  }
  const sharePercent = Number(lpBalance * 1_000_000n / totalSupply) / 10_000;
  const withdrawA = (lpBalance * reserveA) / totalSupply;  // mirrors removeLiquidity
  const withdrawB = (lpBalance * reserveB) / totalSupply;
  const priceAinB = snapshot.priceRatio ? snapshot.priceRatio.priceAinB : (Number(reserveB) / Number(reserveA));
  const valueUsdc = (Number(withdrawB) + Number(withdrawA) * priceAinB) / 1e6;

  return {
    lpBalance: lpBalance.toString(),
    lpBalanceHuman: round6(Number(lpBalance) / 1e6),
    sharePercent: round6(sharePercent),
    withdrawableA: round6(Number(withdrawA) / 1e6),      // EURC on removeLiquidity
    withdrawableB: round6(Number(withdrawB) / 1e6),      // USDC on removeLiquidity
    valueUsdc: round6(valueUsdc),
  };
}

// ─── Liquidity Ratio Analyzer (Part 3 — informational only) ──────────────────
/**
 * Mirrors SimpleAMM.addLiquidity math:
 *   lpMinted = min(amountA·S/rA, amountB·S/rB)
 * Any excess over the optimal ratio is silently DONATED to the pool.
 * amounts are raw 6-decimal bigints.
 */
export function analyzeLiquidityAddition(snapshot, amountA, amountB) {
  const { reserveA, reserveB, totalSupply } = snapshot;

  if (amountA <= 0n || amountB <= 0n) {
    return { valid: false, error: 'amountA and amountB must be > 0' };
  }

  // First liquidity: any ratio is accepted, LP = sqrt(a·b) − 1000
  if (totalSupply <= 0n || reserveA <= 0n || reserveB <= 0n) {
    const lp = sqrtBigInt(amountA * amountB);
    return {
      valid: true,
      firstDeposit: true,
      verdict: 'OPTIMAL',
      expectedLpTokens: (lp > 1000n ? lp - 1000n : 0n).toString(),
      donation: { amountA: 0, amountB: 0, totalUsdc: 0, pctOfDeposit: 0 },
      note: 'First deposit sets the pool price; 1000 LP units are locked forever.',
    };
  }

  const lpFromA = (amountA * totalSupply) / reserveA;
  const lpFromB = (amountB * totalSupply) / reserveB;
  const lpMinted = lpFromA < lpFromB ? lpFromA : lpFromB;

  // Amounts actually credited at the binding side; the rest is donated
  const neededA = (lpMinted * reserveA + totalSupply - 1n) / totalSupply; // ceil
  const neededB = (lpMinted * reserveB + totalSupply - 1n) / totalSupply;
  const donatedA = amountA > neededA ? amountA - neededA : 0n;
  const donatedB = amountB > neededB ? amountB - neededB : 0n;

  const priceAinB = Number(reserveB) / Number(reserveA);
  const donatedUsdc = (Number(donatedB) + Number(donatedA) * priceAinB) / 1e6;
  const depositUsdc = (Number(amountB) + Number(amountA) * priceAinB) / 1e6;
  const donationPct = depositUsdc > 0 ? (donatedUsdc / depositUsdc) * 100 : 0;

  // Post-deposit spot price shift (reserves grow by FULL deposited amounts)
  const newPrice = Number(reserveB + amountB) / Number(reserveA + amountA);
  const priceImpactPct = priceAinB > 0 ? Math.abs(newPrice - priceAinB) / priceAinB * 100 : 0;

  // Optimal counterpart amounts at the current on-chain ratio
  const optimalBForA = (amountA * reserveB) / reserveA;
  const optimalAForB = (amountB * reserveA) / reserveB;

  return {
    valid: true,
    firstDeposit: false,
    verdict: donationPct <= LIQUIDITY_OPTIMAL_TOLERANCE_PCT
      ? 'OPTIMAL'
      : 'WARNING: EXCESS TOKENS WILL BE DONATED',
    expectedLpTokens: lpMinted.toString(),
    expectedLpTokensHuman: round6(Number(lpMinted) / 1e6),
    expectedSharePercent: round6(Number(lpMinted * 1_000_000n / (totalSupply + lpMinted)) / 10_000),
    optimalRatio: {
      reserveRatioAperB: round6(Number(reserveA) / Number(reserveB)),
      optimalAmountBForGivenA: optimalBForA.toString(),
      optimalAmountBForGivenAHuman: round6(Number(optimalBForA) / 1e6),
      optimalAmountAForGivenB: optimalAForB.toString(),
      optimalAmountAForGivenBHuman: round6(Number(optimalAForB) / 1e6),
    },
    donation: {
      amountA: round6(Number(donatedA) / 1e6),
      amountB: round6(Number(donatedB) / 1e6),
      amountARaw: donatedA.toString(),
      amountBRaw: donatedB.toString(),
      totalUsdc: round6(donatedUsdc),
      pctOfDeposit: round4(donationPct),
    },
    liquidityPriceImpactPct: round4(priceImpactPct),
    note: 'Informational only — the transaction is never modified and no refunds occur on-chain.',
  };
}

// ─── Advanced Pool Risk Engine (Part 6 — informational only) ─────────────────
const RISK_ORDER = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };

function bandFromImpact(impactPct) {
  if (impactPct === null || impactPct === undefined) return 'CRITICAL';
  if (impactPct < 1) return 'LOW';
  if (impactPct < 3) return 'MODERATE';
  if (impactPct < 10) return 'HIGH';
  return 'CRITICAL';
}

export function assessPoolRisk(snapshot, depthLevels, poolHealth) {
  const factors = [];
  const add = (name, level, detail) => factors.push({ factor: name, level, detail });

  const impact1k = (depthLevels.find((d) => d.amountIn === 1000) || {}).priceImpact ?? null;
  const impact10k = (depthLevels.find((d) => d.amountIn === 10000) || {}).priceImpact ?? null;

  add('swapDepthRisk', bandFromImpact(impact1k),
    `Price impact for 1,000 USDC: ${impact1k === null ? 'n/a' : impact1k.toFixed(2) + '%'}`);
  add('slippageRisk', bandFromImpact(impact10k === null ? null : impact10k / 4),
    `Price impact for 10,000 USDC: ${impact10k === null ? 'n/a' : impact10k.toFixed(2) + '%'}`);

  const price = snapshot.priceRatio.priceAinB;
  const imbalance = price > 0 ? Math.abs(Math.log(price)) : Infinity; // 0 = perfectly 1:1
  add('reserveImbalance',
    imbalance < 0.3 ? 'LOW' : imbalance < 0.7 ? 'MODERATE' : imbalance < 1.2 ? 'HIGH' : 'CRITICAL',
    `Spot price ${price.toFixed(4)} USDC/EURC`);

  const donationPct = Math.max(0, ...(snapshot.donation.excess || []).map((e) => e.pctOfReserve || 0));
  add('donationRisk',
    snapshot.donation.status === 'DEFICIT_ALERT' ? 'CRITICAL'
      : donationPct > 5 ? 'HIGH' : donationPct > 1 ? 'MODERATE' : 'LOW',
    `Untracked surplus: ${donationPct.toFixed(4)}% of reserves (${snapshot.donation.status})`);

  add('liquidityConcentration', 'HIGH',
    'Single pool holds 100% of EURC/USDC liquidity on this DEX (no alternative venues).');

  add('lpConcentration', 'MODERATE',
    'LP holder distribution unavailable on-chain (no holder enumeration); assumed concentrated on testnet.');

  const util = calcLpValueIndex(snapshot.reserveA, snapshot.reserveB, snapshot.totalSupply);
  add('poolUtilization', util >= 1 ? 'LOW' : 'MODERATE',
    `LP value index ${util.toFixed(4)} (1.0 = genesis parity)`);

  if (poolHealth && (poolHealth.status === 'CRITICAL')) {
    add('poolHealth', 'CRITICAL', poolHealth.reasons.join('; '));
  }

  const overall = factors.reduce(
    (acc, f) => (RISK_ORDER[f.level] > RISK_ORDER[acc] ? f.level : acc), 'LOW',
  );

  return {
    overall,
    factors,
    informationalOnly: true,
  };
}

// ─── PoolAnalyticsSnapshot (Part 5 — canonical source of truth) ──────────────
export function buildPoolAnalyticsSnapshot(dexSnapshot, options = {}) {
  const minimumLiquidity = options.minimumLiquidity !== undefined ? options.minimumLiquidity : null;

  const liquidityDepth = simulateLiquidityDepth(dexSnapshot.reserveA, dexSnapshot.reserveB);
  const impact1k = (liquidityDepth.find((d) => d.amountIn === 1000) || {}).priceImpact ?? null;

  const poolHealth = classifyPool({
    reserveA: dexSnapshot.reserveA,
    reserveB: dexSnapshot.reserveB,
    totalSupply: dexSnapshot.totalSupply,
    tvl: dexSnapshot.tvl,
    impact1000Pct: impact1k ?? 100,
    priceAinB: dexSnapshot.priceRatio.priceAinB,
    donation: dexSnapshot.donation,
  });

  const lpMetrics = calcLpAnalytics(dexSnapshot, minimumLiquidity);
  const risk = assessPoolRisk(dexSnapshot, liquidityDepth, poolHealth);

  return {
    ammAddress: dexSnapshot.ammAddress,
    reserveA: dexSnapshot.reserveA,
    reserveB: dexSnapshot.reserveB,
    totalSupply: dexSnapshot.totalSupply,
    balanceA: dexSnapshot.balanceA,
    balanceB: dexSnapshot.balanceB,
    tvl: dexSnapshot.tvl,
    priceRatio: dexSnapshot.priceRatio,
    reserveRatio: dexSnapshot.reserveRatio,
    liquidityDepth,
    impact1000Pct: impact1k,
    donation: dexSnapshot.donation,
    donationStatus: dexSnapshot.donation.status,
    poolHealth,
    lpMetrics,
    risk,
    blockNumber: dexSnapshot.blockNumber,
    timestamp: dexSnapshot.timestamp,
    source: dexSnapshot.source,
    cacheAge: dexSnapshot.cacheAge,
  };
}

// ─── Analytics engine: cache-shared, memoized per verified fetch ─────────────
export function createAnalyticsEngine(options) {
  const { dexCache } = options;
  if (!dexCache) throw new Error('pool-analytics: dexCache is required');
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());

  let memo = null;      // { key, analytics (without source/cacheAge freshness) }
  let minimumLiquidity = null;
  let minLiqFetched = false;

  async function getAnalytics() {
    const started = now();
    const snapshot = await dexCache.getSnapshot();

    if (!minLiqFetched) {
      try {
        minimumLiquidity = await dexCache.getMinimumLiquidity();
        minLiqFetched = true;
      } catch (_) { /* best-effort — retried on next call */ }
    }

    const key = `${snapshot.lastSuccessfulFetch}:${snapshot.blockNumber}`;
    if (memo && memo.key === key) {
      // Same verified snapshot → zero recomputation, only freshness fields move
      log({ evt: 'analytics_memo_hit', blockNumber: snapshot.blockNumber, latencyMs: now() - started });
      return { ...memo.analytics, source: snapshot.source, cacheAge: snapshot.cacheAge };
    }

    const analytics = buildPoolAnalyticsSnapshot(snapshot, { minimumLiquidity });
    memo = { key, analytics };

    log({
      evt: 'analytics_computed', blockNumber: snapshot.blockNumber,
      tvl: analytics.tvl, poolHealth: analytics.poolHealth.status,
      risk: analytics.risk.overall, donationStatus: analytics.donationStatus,
      latencyMs: now() - started,
    });

    return { ...analytics, source: snapshot.source, cacheAge: snapshot.cacheAge };
  }

  return {
    getAnalytics,
    invalidate: () => { memo = null; },
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function round4(n) { return Math.round(n * 1e4) / 1e4; }
function round6(n) { return Math.round(n * 1e6) / 1e6; }
