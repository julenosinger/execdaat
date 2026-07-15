// ============================================================
// Unit tests — src/lib/dex-metrics.mjs (pool health engine)
// ============================================================
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../../..');
const modUrl = pathToFileURL(path.join(root, 'src/lib/dex-metrics.mjs')).href;

// Real verified reserves observed on Arc Testnet (audit baseline)
const RESERVE_A = 30051878421n;  // EURC
const RESERVE_B = 38560072953n;  // USDC
const LP_SUPPLY = 8186623396n;

describe('lib/dex-metrics.mjs — AMM math', () => {
  it('ammGetAmountOut mirrors on-chain quote (1000 USDC → 757.430227 EURC)', async () => {
    const { ammGetAmountOut } = await import(modUrl);
    const out = ammGetAmountOut(1_000_000_000n, RESERVE_B, RESERVE_A);
    assert.equal(out, 757430227n);
  });

  it('ammGetAmountOut returns 0 for empty pool or zero input', async () => {
    const { ammGetAmountOut } = await import(modUrl);
    assert.equal(ammGetAmountOut(0n, RESERVE_B, RESERVE_A), 0n);
    assert.equal(ammGetAmountOut(1000n, 0n, RESERVE_A), 0n);
    assert.equal(ammGetAmountOut(1000n, RESERVE_B, 0n), 0n);
  });

  it('sqrtBigInt exact squares and monotonicity', async () => {
    const { sqrtBigInt } = await import(modUrl);
    assert.equal(sqrtBigInt(0n), 0n);
    assert.equal(sqrtBigInt(1n), 1n);
    assert.equal(sqrtBigInt(144n), 12n);
    assert.equal(sqrtBigInt(10n ** 18n), 10n ** 9n);
  });
});

describe('lib/dex-metrics.mjs — TVL / ratios (verified reserves only)', () => {
  it('calcTvl = 2 × reserveB in USDC terms (no external prices)', async () => {
    const { calcTvl } = await import(modUrl);
    const tvl = calcTvl(RESERVE_A, RESERVE_B);
    assert.ok(Math.abs(tvl - 77120.145906) < 0.001, `tvl=${tvl}`);
  });

  it('calcTvl = 0 for empty pool (never fabricated)', async () => {
    const { calcTvl } = await import(modUrl);
    assert.equal(calcTvl(0n, RESERVE_B), 0);
    assert.equal(calcTvl(RESERVE_A, 0n), 0);
  });

  it('calcPriceRatio matches audit numbers (1 EURC ≈ 1.2831 USDC)', async () => {
    const { calcPriceRatio } = await import(modUrl);
    const { priceAinB, priceBinA } = calcPriceRatio(RESERVE_A, RESERVE_B);
    assert.ok(Math.abs(priceAinB - 1.283117) < 0.0001, `priceAinB=${priceAinB}`);
    assert.ok(Math.abs(priceBinA - 0.779352) < 0.0001, `priceBinA=${priceBinA}`);
  });

  it('calcReserveRatio = reserveA / reserveB', async () => {
    const { calcReserveRatio } = await import(modUrl);
    const ratio = calcReserveRatio(RESERVE_A, RESERVE_B);
    assert.ok(Math.abs(ratio - 0.779352) < 0.0001, `ratio=${ratio}`);
    assert.equal(calcReserveRatio(RESERVE_A, 0n), 0);
  });

  it('calcLpValueIndex ≈ 4.158 for audited pool (fees + donations accrued)', async () => {
    const { calcLpValueIndex } = await import(modUrl);
    const idx = calcLpValueIndex(RESERVE_A, RESERVE_B, LP_SUPPLY);
    assert.gt(idx, 4.1);
    assert.lt(idx, 4.2);
    assert.equal(calcLpValueIndex(RESERVE_A, RESERVE_B, 0n), 0);
  });
});

describe('lib/dex-metrics.mjs — liquidity depth simulator', () => {
  it('simulates the full 7-level USDC ladder from verified reserves', async () => {
    const { simulateLiquidityDepth, DEPTH_LEVELS_USDC } = await import(modUrl);
    const depth = simulateLiquidityDepth(RESERVE_A, RESERVE_B);
    assert.equal(depth.length, 7);
    assert.deepEqual(depth.map((d) => d.amountIn), DEPTH_LEVELS_USDC);
    depth.forEach((d) => {
      assert.gt(d.estimatedAmountOut, 0);
      assert.gt(d.estimatedAmountOut, d.minimumAmountOut, 'minOut must be below estimate');
      assert.ok(d.priceImpact !== null && d.priceImpact >= 0);
      assert.gt(d.slippage, d.priceImpact, 'slippage includes the 0.3% fee');
      assert.equal(d.exceedsLiquidity, false);
    });
  });

  it('price impact grows monotonically with trade size', async () => {
    const { simulateLiquidityDepth } = await import(modUrl);
    const depth = simulateLiquidityDepth(RESERVE_A, RESERVE_B);
    for (let i = 1; i < depth.length; i++) {
      assert.gt(depth[i].priceImpact, depth[i - 1].priceImpact);
    }
  });

  it('1000 USDC level matches on-chain quote math', async () => {
    const { simulateLiquidityDepth } = await import(modUrl);
    const [level] = simulateLiquidityDepth(RESERVE_A, RESERVE_B, [1000]);
    assert.ok(Math.abs(level.estimatedAmountOut - 757.430227) < 0.000001);
    assert.gt(level.priceImpact, 2);   // ~2.5% depth impact
    assert.lt(level.priceImpact, 3);
  });

  it('empty pool → null impacts, zero outputs, exceedsLiquidity', async () => {
    const { simulateLiquidityDepth } = await import(modUrl);
    const depth = simulateLiquidityDepth(0n, 0n);
    depth.forEach((d) => {
      assert.equal(d.estimatedAmountOut, 0);
      assert.isNull(d.priceImpact);
      assert.isNull(d.slippage);
      assert.equal(d.exceedsLiquidity, true);
    });
  });
});

describe('lib/dex-metrics.mjs — donation detection', () => {
  it('balances == reserves → CLEAN', async () => {
    const { detectDonations } = await import(modUrl);
    const r = detectDonations({ reserveA: RESERVE_A, reserveB: RESERVE_B, balanceA: RESERVE_A, balanceB: RESERVE_B });
    assert.equal(r.status, 'CLEAN');
    assert.equal(r.excess.length, 0);
    assert.equal(r.deficit.length, 0);
  });

  it('detects the audited +5.798953 USDC surplus', async () => {
    const { detectDonations } = await import(modUrl);
    const r = detectDonations({
      reserveA: RESERVE_A, reserveB: RESERVE_B,
      balanceA: RESERVE_A, balanceB: RESERVE_B + 5_798_953n,
      blockNumber: 51976518, timestamp: '2026-07-15T00:00:00.000Z',
    });
    assert.equal(r.status, 'EXCESS_DETECTED');
    assert.equal(r.excess.length, 1);
    assert.equal(r.excess[0].asset, 'USDC');
    assert.equal(r.excess[0].excessAmount, 5.798953);
    assert.equal(r.excess[0].excessRaw, '5798953');
    assert.equal(r.blockNumber, 51976518);
  });

  it('detects EURC surplus too (+10 EURC)', async () => {
    const { detectDonations } = await import(modUrl);
    const r = detectDonations({
      reserveA: RESERVE_A, reserveB: RESERVE_B,
      balanceA: RESERVE_A + 10_000_000n, balanceB: RESERVE_B,
    });
    assert.equal(r.status, 'EXCESS_DETECTED');
    assert.equal(r.excess[0].asset, 'EURC');
    assert.equal(r.excess[0].excessAmount, 10);
  });

  it('balance below reserves → DEFICIT_ALERT (solvency red flag)', async () => {
    const { detectDonations } = await import(modUrl);
    const r = detectDonations({
      reserveA: RESERVE_A, reserveB: RESERVE_B,
      balanceA: RESERVE_A - 1n, balanceB: RESERVE_B,
    });
    assert.equal(r.status, 'DEFICIT_ALERT');
    assert.equal(r.deficit[0].asset, 'EURC');
  });
});

describe('lib/dex-metrics.mjs — pool classifier (informational)', () => {
  const base = {
    reserveA: RESERVE_A, reserveB: RESERVE_B, totalSupply: LP_SUPPLY,
    tvl: 77120, impact1000Pct: 2.53, priceAinB: 1.2831, donation: null,
  };

  it('audited pool (77k TVL, 2.53% impact) → GOOD', async () => {
    const { classifyPool } = await import(modUrl);
    const r = classifyPool({ ...base });
    assert.equal(r.status, 'GOOD');
    assert.equal(r.label, 'Good');
    assert.gt(r.reasons.length, 0);
  });

  it('deep pool with low impact → HEALTHY', async () => {
    const { classifyPool } = await import(modUrl);
    const r = classifyPool({ ...base, tvl: 100_000, impact1000Pct: 1.0 });
    assert.equal(r.status, 'HEALTHY');
    assert.equal(r.label, 'Healthy');
  });

  it('empty reserves → CRITICAL', async () => {
    const { classifyPool } = await import(modUrl);
    const r = classifyPool({ ...base, reserveA: 0n });
    assert.equal(r.status, 'CRITICAL');
  });

  it('zero LP supply → CRITICAL', async () => {
    const { classifyPool } = await import(modUrl);
    const r = classifyPool({ ...base, totalSupply: 0n });
    assert.equal(r.status, 'CRITICAL');
  });

  it('balance deficit → CRITICAL', async () => {
    const { classifyPool } = await import(modUrl);
    const r = classifyPool({ ...base, donation: { status: 'DEFICIT_ALERT', excess: [], deficit: [{ asset: 'USDC' }] } });
    assert.equal(r.status, 'CRITICAL');
  });

  it('spot price outside [0.5, 2.0] → IMBALANCED', async () => {
    const { classifyPool } = await import(modUrl);
    assert.equal(classifyPool({ ...base, priceAinB: 2.5 }).status, 'IMBALANCED');
    assert.equal(classifyPool({ ...base, priceAinB: 0.3 }).status, 'IMBALANCED');
  });

  it('TVL below 10k → LOW_LIQUIDITY', async () => {
    const { classifyPool } = await import(modUrl);
    const r = classifyPool({ ...base, tvl: 5_000 });
    assert.equal(r.status, 'LOW_LIQUIDITY');
    assert.equal(r.label, 'Low Liquidity');
  });

  it('impact above 5% → WARNING', async () => {
    const { classifyPool } = await import(modUrl);
    assert.equal(classifyPool({ ...base, impact1000Pct: 6 }).status, 'WARNING');
  });

  it('donation surplus above 1% of reserves → WARNING', async () => {
    const { classifyPool } = await import(modUrl);
    const donation = { status: 'EXCESS_DETECTED', excess: [{ asset: 'USDC', pctOfReserve: 2.4 }], deficit: [] };
    const r = classifyPool({ ...base, tvl: 100_000, impact1000Pct: 1.0, donation });
    assert.equal(r.status, 'WARNING');
  });
});
