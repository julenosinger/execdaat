// ============================================================
// Unit tests — src/lib/pool-analytics.mjs (Phase 3)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/pool-analytics.mjs')).href;

// Verified on-chain baseline (audit)
const RESERVE_A = 30051878421n;  // EURC
const RESERVE_B = 38560072953n;  // USDC
const LP_SUPPLY = 8186623396n;
const BALANCE_A = RESERVE_A;
const BALANCE_B = RESERVE_B + 5_798_953n;

function makeDexSnapshot(overrides = {}) {
  const reserveA = overrides.reserveA !== undefined ? overrides.reserveA : RESERVE_A;
  const reserveB = overrides.reserveB !== undefined ? overrides.reserveB : RESERVE_B;
  const totalSupply = overrides.totalSupply !== undefined ? overrides.totalSupply : LP_SUPPLY;
  const priceAinB = Number(reserveB) > 0 && Number(reserveA) > 0 ? Number(reserveB) / Number(reserveA) : 0;
  return {
    ammAddress: '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561',
    reserveA, reserveB, totalSupply,
    balanceA: overrides.balanceA !== undefined ? overrides.balanceA : BALANCE_A,
    balanceB: overrides.balanceB !== undefined ? overrides.balanceB : BALANCE_B,
    blockNumber: overrides.blockNumber !== undefined ? overrides.blockNumber : 51980000,
    timestamp: 1_800_000_000_000,
    lastSuccessfulFetch: overrides.lastSuccessfulFetch !== undefined ? overrides.lastSuccessfulFetch : 1_800_000_000_000,
    fetchedAt: 1_800_000_000_000,
    tvl: reserveA > 0n && reserveB > 0n ? (2 * Number(reserveB)) / 1e6 : 0,
    priceRatio: { priceAinB, priceBinA: priceAinB > 0 ? 1 / priceAinB : 0 },
    reserveRatio: Number(reserveB) > 0 ? Number(reserveA) / Number(reserveB) : 0,
    donation: overrides.donation !== undefined ? overrides.donation : {
      status: 'EXCESS_DETECTED',
      excess: [{ asset: 'USDC', excessRaw: '5798953', excessAmount: 5.798953, pctOfReserve: 0.015 }],
      deficit: [], blockNumber: 51980000, timestamp: null,
    },
    source: overrides.source || 'on-chain',
    cacheAge: overrides.cacheAge !== undefined ? overrides.cacheAge : 0,
  };
}

describe('lib/pool-analytics.mjs — capability probe & TWAP feasibility', () => {
  it('scanBytecodeCapabilities detects v1 profile (no deadline, no TWAP)', async () => {
    const { scanBytecodeCapabilities } = await import(modUrl);
    // Simulated v1 dispatch table: v1 swaps + core functions only
    const code = '0x600480' + '140e6247' + 'c915cc24' + '9cd441da' + '9c8f9f23' + '0b4a945e' + 'd9497f00' + '5d1257e8' + 'd2258beb' + '00';
    const caps = scanBytecodeCapabilities(code);
    assert.equal(caps.swapAforB_v1, true);
    assert.equal(caps.swapBforA_v1, true);
    assert.equal(caps.swapAforB_deadline, false);
    assert.equal(caps.deadlineSupportedOnChain, false);
    assert.equal(caps.twapAccumulatorsOnChain, false);
    assert.equal(caps.upgradeable, false);
  });

  it('scanBytecodeCapabilities detects v2 deadline overloads when present', async () => {
    const { scanBytecodeCapabilities } = await import(modUrl);
    const code = '0x' + '140e6247' + 'bd5fd41c' + 'c915cc24' + 'd8f4d44b';
    const caps = scanBytecodeCapabilities(code);
    assert.equal(caps.deadlineSupportedOnChain, true);
  });

  it('TWAP: not feasible on-chain for v1 (no accumulators), off-chain feasible, no migration', async () => {
    const { scanBytecodeCapabilities, analyzeTwapFeasibility } = await import(modUrl);
    const caps = scanBytecodeCapabilities('0x140e6247c915cc24');
    const twap = analyzeTwapFeasibility(caps);
    assert.equal(twap.onChainTwap, 'NOT_FEASIBLE');
    assert.equal(twap.cumulativePriceDataExists, false);
    assert.equal(twap.offChainOracle, 'FEASIBLE');
    assert.equal(twap.migrationRequired, false);
  });

  it('TWAP: feasible when accumulators exist', async () => {
    const { analyzeTwapFeasibility } = await import(modUrl);
    const twap = analyzeTwapFeasibility({ twapAccumulatorsOnChain: true });
    assert.equal(twap.onChainTwap, 'FEASIBLE');
    assert.equal(twap.migrationRequired, false);
  });
});

describe('lib/pool-analytics.mjs — deadline protection (quote layer)', () => {
  it('makeDeadlineGuidance: suggestion 300s ahead, quote expiry 15s', async () => {
    const { makeDeadlineGuidance } = await import(modUrl);
    const nowMs = 1_800_000_000_000;
    const g = makeDeadlineGuidance(nowMs, null);
    assert.equal(g.deadlineSuggestion, Math.floor(nowMs / 1000) + 300);
    assert.equal(g.quoteExpiresAt, new Date(nowMs + 15_000).toISOString());
    assert.equal(g.deadlineSupportedOnChain, false);
    assert.includes(g.note, 'no deadline');
  });

  it('makeDeadlineGuidance reflects on-chain support when probed', async () => {
    const { makeDeadlineGuidance } = await import(modUrl);
    const g = makeDeadlineGuidance(Date.now(), { deadlineSupportedOnChain: true });
    assert.equal(g.deadlineSupportedOnChain, true);
  });

  it('isDeadlineValid: future valid, past/garbage invalid', async () => {
    const { isDeadlineValid } = await import(modUrl);
    const nowMs = 1_800_000_000_000;
    assert.equal(isDeadlineValid(nowMs / 1000 + 60, nowMs), true);
    assert.equal(isDeadlineValid(nowMs / 1000 - 1, nowMs), false);
    assert.equal(isDeadlineValid('abc', nowMs), false);
    assert.equal(isDeadlineValid(0, nowMs), false);
  });
});

describe('lib/pool-analytics.mjs — LP Analytics Engine (read-only)', () => {
  it('pool-level LP metrics: supply, value per LP, growth index, min lock', async () => {
    const { calcLpAnalytics } = await import(modUrl);
    const lp = calcLpAnalytics(makeDexSnapshot(), 1000n);
    assert.equal(lp.lpSupply, LP_SUPPLY.toString());
    assert.ok(Math.abs(lp.lpSupplyHuman - 8186.623396) < 0.000001);
    assert.gt(lp.growthIndex, 4.1);   // sqrt(k)/supply — fees + donations accrued
    assert.lt(lp.growthIndex, 4.2);
    assert.gt(lp.lpValueUsdc, 9);     // ~9.42 USDC per LP token (77120/8186)
    assert.lt(lp.lpValueUsdc, 10);
    assert.equal(lp.minimumLiquidityLock, '1000');
    assert.equal(lp.lpHealth, 'HEALTHY');
  });

  it('LP health: CRITICAL for zero supply, LOW_LIQUIDITY for small TVL', async () => {
    const { calcLpAnalytics } = await import(modUrl);
    assert.equal(calcLpAnalytics(makeDexSnapshot({ totalSupply: 0n })).lpHealth, 'CRITICAL');
    const small = makeDexSnapshot({ reserveA: 1_000_000_000n, reserveB: 1_000_000_000n, totalSupply: 1_000_000_000n });
    assert.equal(calcLpAnalytics(small).lpHealth, 'LOW_LIQUIDITY');
  });

  it('wallet LP position mirrors removeLiquidity math', async () => {
    const { calcLpPosition } = await import(modUrl);
    const snapshot = makeDexSnapshot();
    const tenPct = LP_SUPPLY / 10n;
    const pos = calcLpPosition(snapshot, tenPct);
    assert.ok(Math.abs(pos.sharePercent - 10) < 0.01, `share=${pos.sharePercent}`);
    assert.ok(Math.abs(pos.withdrawableA - 3005.187) < 0.01, `wA=${pos.withdrawableA}`);
    assert.ok(Math.abs(pos.withdrawableB - 3856.007) < 0.01, `wB=${pos.withdrawableB}`);
    assert.ok(Math.abs(pos.valueUsdc - 7712.01) < 0.1, `value=${pos.valueUsdc}`);
  });

  it('wallet LP position with empty pool → zeros', async () => {
    const { calcLpPosition } = await import(modUrl);
    const pos = calcLpPosition(makeDexSnapshot({ totalSupply: 0n }), 1000n);
    assert.equal(pos.sharePercent, 0);
    assert.equal(pos.valueUsdc, 0);
  });
});

describe('lib/pool-analytics.mjs — Liquidity Ratio Analyzer (informational)', () => {
  it('perfect ratio deposit → OPTIMAL, zero donation', async () => {
    const { analyzeLiquidityAddition } = await import(modUrl);
    const snapshot = makeDexSnapshot();
    // deposit exactly 1% of each reserve
    const a = analyzeLiquidityAddition(snapshot, RESERVE_A / 100n, RESERVE_B / 100n);
    assert.equal(a.valid, true);
    assert.equal(a.verdict, 'OPTIMAL');
    assert.lt(a.donation.pctOfDeposit, 0.01);
    assert.gt(Number(a.expectedLpTokens), 0);
  });

  it('unbalanced deposit → WARNING with quantified donation', async () => {
    const { analyzeLiquidityAddition } = await import(modUrl);
    const snapshot = makeDexSnapshot();
    // 100 EURC + 500 USDC (optimal counterpart for 100 EURC ≈ 128.31 USDC)
    const a = analyzeLiquidityAddition(snapshot, 100_000_000n, 500_000_000n);
    assert.equal(a.valid, true);
    assert.includes(a.verdict, 'EXCESS TOKENS WILL BE DONATED');
    assert.gt(a.donation.amountB, 370);   // ~371.7 USDC donated
    assert.lt(a.donation.amountB, 373);
    assert.gt(a.donation.pctOfDeposit, 50);
    assert.gt(a.liquidityPriceImpactPct, 0);
    assert.ok(Math.abs(Number(a.optimalRatio.optimalAmountBForGivenAHuman) - 128.3117) < 0.01);
  });

  it('first deposit into empty pool → OPTIMAL, sqrt rule minus 1000 lock', async () => {
    const { analyzeLiquidityAddition } = await import(modUrl);
    const snapshot = makeDexSnapshot({ reserveA: 0n, reserveB: 0n, totalSupply: 0n });
    const a = analyzeLiquidityAddition(snapshot, 4_000_000n, 9_000_000n);
    assert.equal(a.firstDeposit, true);
    assert.equal(a.verdict, 'OPTIMAL');
    assert.equal(a.expectedLpTokens, (6_000_000n - 1000n).toString()); // sqrt(4e6·9e6)−1000
  });

  it('rejects non-positive amounts', async () => {
    const { analyzeLiquidityAddition } = await import(modUrl);
    const a = analyzeLiquidityAddition(makeDexSnapshot(), 0n, 1n);
    assert.equal(a.valid, false);
  });
});

describe('lib/pool-analytics.mjs — Risk Engine (informational only)', () => {
  it('audited pool → MODERATE-to-HIGH overall, all factors present', async () => {
    const { buildPoolAnalyticsSnapshot } = await import(modUrl);
    const analytics = buildPoolAnalyticsSnapshot(makeDexSnapshot(), { minimumLiquidity: 1000n });
    const risk = analytics.risk;
    assert.ok(['MODERATE', 'HIGH'].includes(risk.overall), `overall=${risk.overall}`);
    assert.equal(risk.informationalOnly, true);
    const names = risk.factors.map((f) => f.factor);
    for (const expected of ['swapDepthRisk', 'slippageRisk', 'reserveImbalance', 'donationRisk', 'liquidityConcentration', 'lpConcentration', 'poolUtilization']) {
      assert.ok(names.includes(expected), `missing factor ${expected}`);
    }
  });

  it('empty pool → CRITICAL overall', async () => {
    const { buildPoolAnalyticsSnapshot } = await import(modUrl);
    const analytics = buildPoolAnalyticsSnapshot(
      makeDexSnapshot({ reserveA: 0n, reserveB: 0n, totalSupply: 0n, donation: { status: 'CLEAN', excess: [], deficit: [] } }),
    );
    assert.equal(analytics.risk.overall, 'CRITICAL');
  });

  it('deficit → donationRisk CRITICAL', async () => {
    const { buildPoolAnalyticsSnapshot } = await import(modUrl);
    const analytics = buildPoolAnalyticsSnapshot(makeDexSnapshot({
      donation: { status: 'DEFICIT_ALERT', excess: [], deficit: [{ asset: 'USDC' }] },
    }));
    const f = analytics.risk.factors.find((x) => x.factor === 'donationRisk');
    assert.equal(f.level, 'CRITICAL');
    assert.equal(analytics.risk.overall, 'CRITICAL');
  });
});

describe('lib/pool-analytics.mjs — PoolAnalyticsSnapshot (canonical)', () => {
  it('snapshot carries all mandated fields', async () => {
    const { buildPoolAnalyticsSnapshot } = await import(modUrl);
    const s = buildPoolAnalyticsSnapshot(makeDexSnapshot(), { minimumLiquidity: 1000n });
    for (const field of ['reserveA', 'reserveB', 'totalSupply', 'tvl', 'priceRatio', 'liquidityDepth', 'donationStatus', 'poolHealth', 'lpMetrics', 'blockNumber', 'timestamp', 'source', 'risk']) {
      assert.ok(field in s, `missing ${field}`);
    }
    assert.equal(s.liquidityDepth.length, 7);
    assert.equal(s.poolHealth.status, 'GOOD');
    assert.equal(s.donationStatus, 'EXCESS_DETECTED');
    assert.ok(Math.abs(s.impact1000Pct - 2.5204) < 0.01);
  });

  it('analytics engine shares cache: same verified fetch → memo hit, zero recompute', async () => {
    const { createAnalyticsEngine } = await import(modUrl);
    let snapshotCalls = 0;
    let minLiqCalls = 0;
    const base = makeDexSnapshot();
    const dexCache = {
      getSnapshot: async () => { snapshotCalls++; return { ...base, cacheAge: snapshotCalls }; },
      getMinimumLiquidity: async () => { minLiqCalls++; return 1000n; },
      invalidate: () => {},
      peek: () => base,
    };
    const logs = [];
    const engine = createAnalyticsEngine({ dexCache, log: (f) => logs.push(f) });

    const a1 = await engine.getAnalytics();
    const a2 = await engine.getAnalytics();
    assert.equal(a1.poolHealth.status, a2.poolHealth.status);
    assert.equal(minLiqCalls, 1, 'minimumLiquidity fetched once');
    assert.equal(logs.filter((l) => l.evt === 'analytics_computed').length, 1, 'computed once');
    assert.equal(logs.filter((l) => l.evt === 'analytics_memo_hit').length, 1, 'served from memo');
    assert.equal(a2.cacheAge, 2, 'freshness fields still updated on memo hits');
  });

  it('new verified fetch (new block) → recompute', async () => {
    const { createAnalyticsEngine } = await import(modUrl);
    let block = 100;
    const dexCache = {
      getSnapshot: async () => makeDexSnapshot({ blockNumber: block, lastSuccessfulFetch: block * 1000 }),
      getMinimumLiquidity: async () => 1000n,
      invalidate: () => {}, peek: () => null,
    };
    const logs = [];
    const engine = createAnalyticsEngine({ dexCache, log: (f) => logs.push(f) });
    await engine.getAnalytics();
    block = 101;
    await engine.getAnalytics();
    assert.equal(logs.filter((l) => l.evt === 'analytics_computed').length, 2);
  });
});
