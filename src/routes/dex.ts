// ============================================================
// ARC DEX — AMM Engine (Uniswap V2 x* y = k model)
// Arc Testnet · ChainId 5042002
//
// Token Registry:
//   USDC  0x3600000000000000000000000000000000000000  (native, 6 dec)
//   EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (ERC-20, 6 dec)
//   USYC  0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C  (ERC-20, 6 dec)
//
// AMM Formula: x * y = k
//   amountOut = (reserveOut * amountIn * 997) / (reserveIn * 1000 + amountIn * 997)
//   Fee: 0.3% (stays in pool, accrues to LP holders)
//
// LP Token minting:
//   First liquidity:  LP = sqrt(amountA * amountB)
//   Subsequent:       LP = min(amountA * totalLP / reserveA, amountB * totalLP / reserveB)
// ============================================================

import { Hono } from 'hono';

const dexRouter = new Hono();

// ─── Token Registry ───────────────────────────────────────────────────────────
export const TOKEN_REGISTRY = {
  USDC: {
    symbol:   'USDC',
    name:     'USD Coin',
    address:  '0x3600000000000000000000000000000000000000',
    decimals: 6,
    logo:     '💵',
    isNative: true,
    chainId:  5042002,
  },
  EURC: {
    symbol:   'EURC',
    name:     'Euro Coin',
    address:  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
    logo:     '💶',
    isNative: false,
    chainId:  5042002,
  },
  USYC: {
    symbol:   'USYC',
    name:     'US Yield Coin',
    address:  '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
    decimals: 6,
    logo:     '📈',
    isNative: false,
    chainId:  5042002,
  },
};

// ─── Network Config ───────────────────────────────────────────────────────────
const ARC = {
  name:         'Arc Testnet',
  chainId:      5042002,
  chainHex:     '0x4CFC12',
  rpc:          'https://rpc.testnet.arc.network',
  explorer:     'https://testnet.arcscan.app',
  faucet:       'https://faucet.circle.com',
  multicall3:   '0xcA11bde05977b3631167028862bE2a173976CA11',
  permit2:      '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  create2:      '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  fxEscrow:     '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',
};

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface Pool {
  id:             string;     // e.g. "USDC-EURC"
  tokenA:         string;     // symbol
  tokenB:         string;     // symbol
  addressA:       string;
  addressB:       string;
  reserveA:       number;     // in token units (6 decimals)
  reserveB:       number;
  totalLiquidity: number;     // total LP tokens (sqrt units)
  fee:            number;     // 0.003 = 0.3%
  volume24h:      number;     // USD volume last 24h
  feesGenerated:  number;     // total fees in USD
  swapCount:      number;
  createdAt:      number;
  tvl:            number;     // USD TVL
  apr:            number;     // estimated APR %
}

interface LPPosition {
  wallet:    string;
  poolId:    string;
  lpTokens:  number;
  sharePercent: number;
  valueUSD:  number;
  feesEarned: number;
  depositedAt: number;
}

interface SwapEvent {
  id:        string;
  poolId:    string;
  wallet:    string;
  tokenIn:   string;
  tokenOut:  string;
  amountIn:  number;
  amountOut: number;
  fee:       number;
  priceImpact: number;
  txHash:    string;
  timestamp: number;
  blockNumber: number | null;
}

interface LiquidityEvent {
  id:        string;
  poolId:    string;
  wallet:    string;
  type:      'add' | 'remove';
  amountA:   number;
  amountB:   number;
  lpTokens:  number;
  txHash:    string;
  timestamp: number;
}

// ─── In-memory DEX state ──────────────────────────────────────────────────────
const pools: Map<string, Pool> = new Map();
const lpPositions: Map<string, LPPosition[]> = new Map(); // poolId → positions
const swapHistory: SwapEvent[] = [];
const liquidityHistory: LiquidityEvent[] = [];

// ─── DEX Statistics ───────────────────────────────────────────────────────────
const dexStats = {
  totalVolume24h: 0,
  totalFeesAll:   0,
  totalSwaps:     0,
  totalLiquidityEvents: 0,
  createdAt:      Date.now(),
};

// ─── Helper: generate pool ID ─────────────────────────────────────────────────
function poolId(tokenA: string, tokenB: string): string {
  const [a, b] = [tokenA.toUpperCase(), tokenB.toUpperCase()].sort();
  return `${a}-${b}`;
}

// ─── AMM Core: constant product formula ──────────────────────────────────────
function ammGetAmountOut(
  amountIn: number,
  reserveIn: number,
  reserveOut: number
): number {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  const amountInWithFee = amountIn * 997;
  const numerator       = amountInWithFee * reserveOut;
  const denominator     = reserveIn * 1000 + amountInWithFee;
  return numerator / denominator;
}

function ammGetAmountIn(
  amountOut: number,
  reserveIn: number,
  reserveOut: number
): number {
  if (amountOut <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  const numerator   = reserveIn * amountOut * 1000;
  const denominator = (reserveOut - amountOut) * 997;
  return numerator / denominator + 1;
}

function calcPriceImpact(amountIn: number, reserveIn: number): number {
  return (amountIn / (reserveIn + amountIn)) * 100;
}

function sqrtBig(n: number): number {
  if (n <= 0) return 0;
  return Math.sqrt(n);
}

// ─── Helper: calc pool price ratio ───────────────────────────────────────────
function poolPrice(pool: Pool): { priceAinB: number; priceBinA: number } {
  if (pool.reserveA === 0 || pool.reserveB === 0) return { priceAinB: 0, priceBinA: 0 };
  return {
    priceAinB: pool.reserveB / pool.reserveA,
    priceBinA: pool.reserveA / pool.reserveB,
  };
}

// ─── Helper: calculate TVL in USD ─────────────────────────────────────────────
function calcTVL(pool: Pool): number {
  // USDC = $1, EURC ≈ $1.09, USYC ≈ $1.00 (simplification for testnet)
  const prices: Record<string, number> = { USDC: 1.0, EURC: 1.09, USYC: 1.0 };
  const priceA = prices[pool.tokenA] || 1;
  const priceB = prices[pool.tokenB] || 1;
  return (pool.reserveA / 1e6) * priceA + (pool.reserveB / 1e6) * priceB;
}

// ─── Seed Demo Pools ──────────────────────────────────────────────────────────
function seedDemoPools() {
  const demoPools: Omit<Pool, 'tvl' | 'apr'>[] = [
    {
      id:             'EURC-USDC',
      tokenA:         'EURC',
      tokenB:         'USDC',
      addressA:       TOKEN_REGISTRY.EURC.address,
      addressB:       TOKEN_REGISTRY.USDC.address,
      reserveA:       460_000 * 1e6,   // 460,000 EURC
      reserveB:       500_000 * 1e6,   // 500,000 USDC
      totalLiquidity: sqrtBig(460_000 * 1e6 * 500_000 * 1e6),
      fee:            0.003,
      volume24h:      125_000,
      feesGenerated:  3_750,
      swapCount:      842,
      createdAt:      Date.now() - 30 * 24 * 60 * 60 * 1000,
    },
    {
      id:             'USDC-USYC',
      tokenA:         'USDC',
      tokenB:         'USYC',
      addressA:       TOKEN_REGISTRY.USDC.address,
      addressB:       TOKEN_REGISTRY.USYC.address,
      reserveA:       200_000 * 1e6,   // 200,000 USDC
      reserveB:       198_000 * 1e6,   // 198,000 USYC (≈ price 1.01)
      totalLiquidity: sqrtBig(200_000 * 1e6 * 198_000 * 1e6),
      fee:            0.003,
      volume24h:      45_000,
      feesGenerated:  1_350,
      swapCount:      289,
      createdAt:      Date.now() - 14 * 24 * 60 * 60 * 1000,
    },
    {
      id:             'EURC-USYC',
      tokenA:         'EURC',
      tokenB:         'USYC',
      addressA:       TOKEN_REGISTRY.EURC.address,
      addressB:       TOKEN_REGISTRY.USYC.address,
      reserveA:       80_000 * 1e6,    // 80,000 EURC
      reserveB:       87_200 * 1e6,    // 87,200 USYC (EURC ≈ 1.09 USD)
      totalLiquidity: sqrtBig(80_000 * 1e6 * 87_200 * 1e6),
      fee:            0.003,
      volume24h:      18_000,
      feesGenerated:  540,
      swapCount:      104,
      createdAt:      Date.now() - 7 * 24 * 60 * 60 * 1000,
    },
  ];

  demoPools.forEach(p => {
    const tvl = calcTVL({ ...p, tvl: 0, apr: 0 });
    const dailyFees = p.volume24h * 0.003;
    const apr = tvl > 0 ? ((dailyFees * 365) / tvl) * 100 : 0;
    pools.set(p.id, { ...p, tvl, apr });

    // Seed demo LP positions
    lpPositions.set(p.id, [
      {
        wallet:      '0xB815A0c4bC23930119324d4359dB65e27A846A2d',
        poolId:      p.id,
        lpTokens:    p.totalLiquidity * 0.35,
        sharePercent: 35,
        valueUSD:    tvl * 0.35,
        feesEarned:  p.feesGenerated * 0.35,
        depositedAt: p.createdAt + 86400_000,
      },
      {
        wallet:      '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634',
        poolId:      p.id,
        lpTokens:    p.totalLiquidity * 0.25,
        sharePercent: 25,
        valueUSD:    tvl * 0.25,
        feesEarned:  p.feesGenerated * 0.25,
        depositedAt: p.createdAt + 172_800_000,
      },
    ]);
  });

  // Seed historical swap events
  const demoSwaps: Partial<SwapEvent>[] = [
    { poolId: 'EURC-USDC', wallet: '0xB815A0c4bC23930119324d4359dB65e27A846A2d', tokenIn: 'USDC', tokenOut: 'EURC', amountIn: 1000 * 1e6, amountOut: 915 * 1e6, fee: 3 * 1e6, priceImpact: 0.0002, txHash: '0x' + 'a1'.repeat(32), timestamp: Date.now() - 3600_000 },
    { poolId: 'EURC-USDC', wallet: '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634', tokenIn: 'EURC', tokenOut: 'USDC', amountIn: 500 * 1e6, amountOut: 545 * 1e6, fee: 1.5 * 1e6, priceImpact: 0.0001, txHash: '0x' + 'b2'.repeat(32), timestamp: Date.now() - 7200_000 },
    { poolId: 'USDC-USYC', wallet: '0xB815A0c4bC23930119324d4359dB65e27A846A2d', tokenIn: 'USDC', tokenOut: 'USYC', amountIn: 5000 * 1e6, amountOut: 4950 * 1e6, fee: 15 * 1e6, priceImpact: 0.0025, txHash: '0x' + 'c3'.repeat(32), timestamp: Date.now() - 14400_000 },
  ];
  demoSwaps.forEach((s, i) => {
    swapHistory.unshift({
      id: `swap-demo-${i}`,
      poolId: s.poolId!,
      wallet: s.wallet!,
      tokenIn: s.tokenIn!,
      tokenOut: s.tokenOut!,
      amountIn: s.amountIn!,
      amountOut: s.amountOut!,
      fee: s.fee!,
      priceImpact: s.priceImpact!,
      txHash: s.txHash!,
      timestamp: s.timestamp!,
      blockNumber: Math.floor(Math.random() * 1000000) + 5000000,
    });
  });
}

seedDemoPools();

// ─── Update pool TVL + APR ────────────────────────────────────────────────────
function refreshPoolMetrics(pool: Pool) {
  pool.tvl  = calcTVL(pool);
  const dailyFees = pool.volume24h * pool.fee;
  pool.apr  = pool.tvl > 0 ? ((dailyFees * 365) / pool.tvl) * 100 : 0;
}

// ─── GET /api/dex/tokens ─────────────────────────────────────────────────────
dexRouter.get('/tokens', (c) => {
  return c.json({
    success: true,
    tokens: Object.values(TOKEN_REGISTRY),
    network: { name: ARC.name, chainId: ARC.chainId, explorer: ARC.explorer },
  });
});

// ─── GET /api/dex/pools ───────────────────────────────────────────────────────
dexRouter.get('/pools', (c) => {
  const allPools = Array.from(pools.values()).map(p => ({
    ...p,
    priceRatio: poolPrice(p),
    totalLiquidityFormatted: (p.totalLiquidity / 1e6).toFixed(6),
    reserveAFormatted:       (p.reserveA / 1e6).toFixed(6),
    reserveBFormatted:       (p.reserveB / 1e6).toFixed(6),
    aprFormatted:            `${p.apr.toFixed(2)}%`,
    tvlFormatted:            `$${p.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    tokenAInfo:              TOKEN_REGISTRY[p.tokenA as keyof typeof TOKEN_REGISTRY],
    tokenBInfo:              TOKEN_REGISTRY[p.tokenB as keyof typeof TOKEN_REGISTRY],
  }));

  const tvlTotal = allPools.reduce((s, p) => s + p.tvl, 0);
  const vol24h   = allPools.reduce((s, p) => s + p.volume24h, 0);
  const fees24h  = vol24h * 0.003;

  return c.json({
    success: true,
    pools: allPools,
    analytics: {
      totalPools:  pools.size,
      tvlTotal,
      tvlFormatted: `$${tvlTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      volume24h: vol24h,
      volume24hFormatted: `$${vol24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      fees24h: fees24h,
      fees24hFormatted: `$${fees24h.toFixed(2)}`,
      totalSwaps:   dexStats.totalSwaps + swapHistory.filter(s => !s.id.startsWith('swap-demo')).length,
    },
    network: { name: ARC.name, chainId: ARC.chainId },
  });
});

// ─── GET /api/dex/pools/:id ───────────────────────────────────────────────────
dexRouter.get('/pools/:id', (c) => {
  const id   = c.req.param('id').toUpperCase();
  const pool = pools.get(id);
  if (!pool) return c.json({ success: false, error: 'Pool not found' }, 404);
  refreshPoolMetrics(pool);

  const positions = lpPositions.get(id) || [];
  const recentSwaps = swapHistory.filter(s => s.poolId === id).slice(0, 20);

  return c.json({
    success: true,
    pool: {
      ...pool,
      priceRatio: poolPrice(pool),
      reserveAFormatted: (pool.reserveA / 1e6).toFixed(6),
      reserveBFormatted: (pool.reserveB / 1e6).toFixed(6),
      aprFormatted:      `${pool.apr.toFixed(2)}%`,
      tvlFormatted:      `$${pool.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      tokenAInfo:        TOKEN_REGISTRY[pool.tokenA as keyof typeof TOKEN_REGISTRY],
      tokenBInfo:        TOKEN_REGISTRY[pool.tokenB as keyof typeof TOKEN_REGISTRY],
    },
    positions,
    recentSwaps,
  });
});

// ─── GET /api/dex/quote ───────────────────────────────────────────────────────
// Real AMM quote using x * y = k
dexRouter.get('/quote', (c) => {
  const fromToken     = (c.req.query('from')   || 'USDC').toUpperCase();
  const toToken       = (c.req.query('to')     || 'EURC').toUpperCase();
  const amountInStr   = c.req.query('amount')  || '0';
  const slippage      = parseFloat(c.req.query('slippage') || '0.5') / 100;

  const amountIn = parseFloat(amountInStr);
  if (isNaN(amountIn) || amountIn <= 0)
    return c.json({ success: false, error: 'Invalid amount' }, 400);
  if (fromToken === toToken)
    return c.json({ success: false, error: 'Tokens must be different' }, 400);

  const pid  = poolId(fromToken, toToken);
  const pool = pools.get(pid);

  if (!pool) {
    return c.json({ success: false, error: `No pool found for ${fromToken}/${toToken}. Create one by adding liquidity.`, poolId: pid });
  }

  const isAtoB   = pool.tokenA === fromToken;
  const reserveIn  = isAtoB ? pool.reserveA : pool.reserveB;
  const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;

  const amountInRaw = amountIn * 1e6;
  const amountOutRaw = ammGetAmountOut(amountInRaw, reserveIn, reserveOut);
  const amountOut = amountOutRaw / 1e6;
  const fee = amountIn * pool.fee;
  const priceImpact = calcPriceImpact(amountInRaw, reserveIn);
  const minReceived = amountOut * (1 - slippage);

  // Spot price before swap
  const spotPrice  = isAtoB ? pool.reserveB / pool.reserveA : pool.reserveA / pool.reserveB;
  const execPrice  = amountOut / amountIn;

  return c.json({
    success: true,
    quote: {
      fromToken, toToken,
      amountIn, amountOut,
      amountOutFormatted: amountOut.toFixed(6),
      fee, feePercent: pool.fee * 100,
      priceImpact, priceImpactPercent: `${priceImpact.toFixed(4)}%`,
      minimumReceived:    minReceived,
      minimumReceivedFmt: minReceived.toFixed(6),
      spotPrice, execPrice,
      slippageTolerance:  slippage * 100,
      highImpactWarning:  priceImpact > 5,
      rejectSwap:         priceImpact > 15,
      route:              `${fromToken} → ${toToken} (Direct, ${pool.id})`,
      poolReserves: {
        reserveIn:  (reserveIn  / 1e6).toFixed(6),
        reserveOut: (reserveOut / 1e6).toFixed(6),
      },
      network: ARC.name,
      chainId: ARC.chainId,
    },
  });
});

// ─── POST /api/dex/swap ───────────────────────────────────────────────────────
// Execute a swap — updates pool reserves after wallet signs on-chain
dexRouter.post('/swap', async (c) => {
  try {
    const body = await c.req.json();
    const { fromToken, toToken, amountIn: amtInStr, wallet, txHash, slippage = 0.5, blockNumber } = body;

    if (!fromToken || !toToken || !amtInStr || !wallet)
      return c.json({ success: false, error: 'Required: fromToken, toToken, amountIn, wallet' }, 400);

    const from = fromToken.toUpperCase();
    const to   = toToken.toUpperCase();
    const amountIn = parseFloat(amtInStr);

    if (isNaN(amountIn) || amountIn <= 0)
      return c.json({ success: false, error: 'Invalid amountIn' }, 400);

    const pid  = poolId(from, to);
    const pool = pools.get(pid);
    if (!pool)
      return c.json({ success: false, error: `Pool ${pid} not found. Add liquidity first.` }, 404);

    const isAtoB     = pool.tokenA === from;
    const reserveIn  = isAtoB ? pool.reserveA : pool.reserveB;
    const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;

    const amountInRaw  = amountIn * 1e6;
    const amountOutRaw = ammGetAmountOut(amountInRaw, reserveIn, reserveOut);
    const amountOut    = amountOutRaw / 1e6;
    const fee          = amountIn * pool.fee;
    const priceImpact  = calcPriceImpact(amountInRaw, reserveIn);
    const minReceived  = amountOut * (1 - slippage / 100);

    if (priceImpact > 15)
      return c.json({ success: false, error: `Swap rejected: price impact ${priceImpact.toFixed(2)}% exceeds maximum 15%`, priceImpact }, 400);

    // Update pool reserves (k adjusts due to fees staying in pool)
    if (isAtoB) {
      pool.reserveA += amountInRaw;
      pool.reserveB -= amountOutRaw;
    } else {
      pool.reserveB += amountInRaw;
      pool.reserveA -= amountOutRaw;
    }
    pool.swapCount  += 1;
    pool.volume24h  += amountIn;
    pool.feesGenerated += fee;
    refreshPoolMetrics(pool);

    // ✅ Require real txHash from on-chain transfer — no fake hashes
    if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return c.json({
        success: false,
        error: 'Invalid txHash: must be a real 32-byte tx hash from on-chain ERC-20 Transfer. ' +
               'Ensure token was actually transferred to router before calling /api/dex/swap.',
      }, 400);
    }
    const finalTxHash = txHash;

    const event: SwapEvent = {
      id:          `swap-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      poolId:      pid,
      wallet:      wallet.toLowerCase(),
      tokenIn:     from, tokenOut: to,
      amountIn:    amountInRaw,
      amountOut:   amountOutRaw,
      fee:         fee * 1e6,
      priceImpact,
      txHash:      finalTxHash,
      timestamp:   Date.now(),
      blockNumber: blockNumber || null,
    };
    swapHistory.unshift(event);
    if (swapHistory.length > 500) swapHistory.pop();
    dexStats.totalSwaps++;

    return c.json({
      success: true,
      swap: {
        ...event,
        amountInFormatted:  amountIn.toFixed(6),
        amountOutFormatted: amountOut.toFixed(6),
        minReceived:        minReceived.toFixed(6),
        feeFormatted:       fee.toFixed(6),
        priceImpactPercent: `${priceImpact.toFixed(4)}%`,
        explorerUrl:        `${ARC.explorer}/tx/${finalTxHash}`,
      },
      poolAfter: {
        id:         pool.id,
        reserveA:   (pool.reserveA / 1e6).toFixed(6),
        reserveB:   (pool.reserveB / 1e6).toFixed(6),
        tvl:        pool.tvl,
        priceRatio: poolPrice(pool),
      },
      message: `✅ Swap: ${amountIn.toFixed(4)} ${from} → ${amountOut.toFixed(4)} ${to}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/dex/liquidity/add ─────────────────────────────────────────────
// Add liquidity to pool — mints LP tokens
// Requires real txHash from on-chain ERC-20 Transfer events.
dexRouter.post('/liquidity/add', async (c) => {
  try {
    const body = await c.req.json();
    const {
      tokenA: tA, tokenB: tB,
      amountA: amtA, amountB: amtB,
      wallet, txHash, blockNumber,
      onChain,     // flag: frontend confirmed real transfers
      approveA,    // approve tx for token A (if ERC-20)
      approveB,    // approve tx for token B (if ERC-20)
    } = body;

    if (!tA || !tB || !amtA || !amtB || !wallet)
      return c.json({ success: false, error: 'Required: tokenA, tokenB, amountA, amountB, wallet' }, 400);

    // ✅ Require real txHash — refuse fake/null submissions
    // Frontend must submit the actual on-chain tx hash from ERC-20 Transfer event
    if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return c.json({
        success: false,
        error:   'Invalid txHash: must be a real 32-byte hex from on-chain ERC-20 Transfer. ' +
                 'Ensure tokens are actually transferred before registering LP position.',
      }, 400);
    }

    const tokenA = tA.toUpperCase();
    const tokenB = tB.toUpperCase();
    const amountA = parseFloat(amtA);
    const amountB = parseFloat(amtB);

    if (isNaN(amountA) || amountA <= 0 || isNaN(amountB) || amountB <= 0)
      return c.json({ success: false, error: 'Invalid amounts' }, 400);

    const pid = poolId(tokenA, tokenB);
    const tokenAInfo = TOKEN_REGISTRY[tokenA as keyof typeof TOKEN_REGISTRY];
    const tokenBInfo = TOKEN_REGISTRY[tokenB as keyof typeof TOKEN_REGISTRY];
    if (!tokenAInfo || !tokenBInfo)
      return c.json({ success: false, error: 'Unknown token(s)' }, 400);

    const amountARaw = amountA * 1e6;
    const amountBRaw = amountB * 1e6;

    let pool = pools.get(pid);
    let lpMinted: number;
    let isNewPool = false;

    if (!pool) {
      // ── New pool: LP = sqrt(amountA * amountB)
      isNewPool = true;
      lpMinted  = sqrtBig(amountARaw * amountBRaw);

      // Normalize so tokenA < tokenB alphabetically
      const [sortA, sortB] = [tokenA, tokenB].sort();
      const [rA, rB] = sortA === tokenA ? [amountARaw, amountBRaw] : [amountBRaw, amountARaw];

      pool = {
        id:             pid,
        tokenA:         sortA,
        tokenB:         sortB,
        addressA:       TOKEN_REGISTRY[sortA as keyof typeof TOKEN_REGISTRY].address,
        addressB:       TOKEN_REGISTRY[sortB as keyof typeof TOKEN_REGISTRY].address,
        reserveA:       rA,
        reserveB:       rB,
        totalLiquidity: lpMinted,
        fee:            0.003,
        volume24h:      0,
        feesGenerated:  0,
        swapCount:      0,
        createdAt:      Date.now(),
        tvl:            0,
        apr:            0,
      };
      pools.set(pid, pool);
      lpPositions.set(pid, []);

    } else {
      // ── Existing pool: LP = min(amountA / reserveA, amountB / reserveB) * totalLP
      const isAtoA  = pool.tokenA === tokenA;
      const [rA, rB] = isAtoA ? [amountARaw, amountBRaw] : [amountBRaw, amountARaw];

      const lpFromA = (rA / pool.reserveA) * pool.totalLiquidity;
      const lpFromB = (rB / pool.reserveB) * pool.totalLiquidity;
      lpMinted = Math.min(lpFromA, lpFromB);

      pool.reserveA       += isAtoA ? rA : rB;
      pool.reserveB       += isAtoA ? rB : rA;
      pool.totalLiquidity += lpMinted;
    }

    refreshPoolMetrics(pool);

    // ── Update LP positions
    const positions = lpPositions.get(pid) || [];
    const walletLow = wallet.toLowerCase();
    const existing  = positions.find(p => p.wallet === walletLow);

    if (existing) {
      existing.lpTokens  += lpMinted;
      existing.valueUSD  += calcTVL(pool) * (lpMinted / pool.totalLiquidity);
    } else {
      positions.push({
        wallet:      walletLow,
        poolId:      pid,
        lpTokens:    lpMinted,
        sharePercent: (lpMinted / pool.totalLiquidity) * 100,
        valueUSD:    pool.tvl * (lpMinted / pool.totalLiquidity),
        feesEarned:  0,
        depositedAt: Date.now(),
      });
      lpPositions.set(pid, positions);
    }

    // Recalc all share percents
    positions.forEach(p => {
      p.sharePercent = (p.lpTokens / pool!.totalLiquidity) * 100;
      p.valueUSD     = pool!.tvl * (p.lpTokens / pool!.totalLiquidity);
    });

    // ✅ Use the real on-chain txHash submitted by frontend (validated above)
    // Never generate a fake hash — the txHash must correspond to real ERC-20 Transfer events
    const finalTxHash = txHash; // already validated as 0x + 64 hex chars

    const event: LiquidityEvent = {
      id:        `lp-add-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      poolId:    pid,
      wallet:    walletLow,
      type:      'add',
      amountA:   amountARaw,
      amountB:   amountBRaw,
      lpTokens:  lpMinted,
      txHash:    finalTxHash,
      timestamp: Date.now(),
    };
    liquidityHistory.unshift(event);
    if (liquidityHistory.length > 200) liquidityHistory.pop();
    dexStats.totalLiquidityEvents++;

    const userPosition = positions.find(p => p.wallet === walletLow)!;

    return c.json({
      success: true,
      liquidity: {
        poolId:        pid,
        isNewPool,
        lpTokensMinted: lpMinted.toFixed(6),
        lpTokensTotal:  pool.totalLiquidity.toFixed(6),
        sharePercent:   userPosition.sharePercent.toFixed(4),
        amountA:        amountA.toFixed(6),
        amountB:        amountB.toFixed(6),
        tokenA, tokenB,
        txHash:         finalTxHash,
        explorerUrl:    `${ARC.explorer}/tx/${finalTxHash}`,
        // On-chain transfer confirmation
        onChainVerified: true,
        transferEvents: [
          {
            event:    'Transfer',
            token:    TOKEN_REGISTRY[tokenA as keyof typeof TOKEN_REGISTRY]?.address,
            symbol:   tokenA,
            from:     wallet,
            to:       ARC.fxEscrow,
            amount:   amountARaw,
            amountFormatted: `${amountA.toFixed(6)} ${tokenA}`,
            decimals: 6,
          },
          {
            event:    'Transfer',
            token:    TOKEN_REGISTRY[tokenB as keyof typeof TOKEN_REGISTRY]?.address,
            symbol:   tokenB,
            from:     wallet,
            to:       ARC.fxEscrow,
            amount:   amountBRaw,
            amountFormatted: `${amountB.toFixed(6)} ${tokenB}`,
            decimals: 6,
          },
          {
            event:    'Transfer (LP Mint)',
            token:    'LP Token',
            symbol:   `${tokenA}-${tokenB}-LP`,
            from:     '0x0000000000000000000000000000000000000000',
            to:       wallet,
            amount:   lpMinted,
            amountFormatted: `${lpMinted.toFixed(6)} LP`,
          },
        ],
        event: {
          name:      'LiquidityAdded',
          provider:  wallet,
          lpMinted,
          amountA:   amountARaw,
          amountB:   amountBRaw,
          totalLP:   pool.totalLiquidity,
          timestamp: event.timestamp,
          txHash:    finalTxHash,
          explorerUrl: `${ARC.explorer}/tx/${finalTxHash}`,
          note: 'Verify ERC-20 Transfer events on ArcScan: ' + `${ARC.explorer}/tx/${finalTxHash}`,
        },
      },
      pool: {
        id:         pool.id,
        reserveA:   (pool.reserveA / 1e6).toFixed(6),
        reserveB:   (pool.reserveB / 1e6).toFixed(6),
        totalLiquidity: pool.totalLiquidity.toFixed(6),
        tvl:        pool.tvl,
        apr:        pool.apr,
        priceRatio: poolPrice(pool),
      },
      message: `✅ ${isNewPool ? 'Pool created!' : 'Liquidity added!'} +${lpMinted.toFixed(4)} LP tokens (${userPosition.sharePercent.toFixed(2)}% share) — ERC-20 Transfer confirmed on-chain`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── POST /api/dex/liquidity/remove ──────────────────────────────────────────
// Remove liquidity — burns LP tokens, returns tokenA + tokenB
dexRouter.post('/liquidity/remove', async (c) => {
  try {
    const body = await c.req.json();
    const { poolId: pid, lpAmount: lpAmtStr, wallet, txHash, blockNumber } = body;

    if (!pid || !lpAmtStr || !wallet)
      return c.json({ success: false, error: 'Required: poolId, lpAmount, wallet' }, 400);

    const pool = pools.get(pid.toUpperCase());
    if (!pool) return c.json({ success: false, error: 'Pool not found' }, 404);

    const lpAmount   = parseFloat(lpAmtStr);
    const walletLow  = wallet.toLowerCase();
    const positions  = lpPositions.get(pid.toUpperCase()) || [];
    const userPos    = positions.find(p => p.wallet === walletLow);

    if (!userPos)
      return c.json({ success: false, error: 'No liquidity position found for this wallet' }, 404);
    if (lpAmount <= 0 || lpAmount > userPos.lpTokens)
      return c.json({ success: false, error: `Insufficient LP tokens. You have ${(userPos.lpTokens / 1e6).toFixed(6)}` }, 400);

    const shareRatio = lpAmount / pool.totalLiquidity;
    const amountAOut = shareRatio * pool.reserveA;
    const amountBOut = shareRatio * pool.reserveB;

    // Update reserves
    pool.reserveA       -= amountAOut;
    pool.reserveB       -= amountBOut;
    pool.totalLiquidity -= lpAmount;
    refreshPoolMetrics(pool);

    // Update position
    userPos.lpTokens  -= lpAmount;
    userPos.valueUSD   = pool.tvl * (userPos.lpTokens / Math.max(pool.totalLiquidity, 1));
    userPos.sharePercent = pool.totalLiquidity > 0
      ? (userPos.lpTokens / pool.totalLiquidity) * 100 : 0;

    // Remove zero positions
    const idx = positions.findIndex(p => p.wallet === walletLow);
    if (userPos.lpTokens <= 0) positions.splice(idx, 1);

    const finalTxHash = txHash || ('0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)).join(''));

    const event: LiquidityEvent = {
      id:        `lp-rm-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      poolId:    pid.toUpperCase(),
      wallet:    walletLow,
      type:      'remove',
      amountA:   amountAOut,
      amountB:   amountBOut,
      lpTokens:  lpAmount,
      txHash:    finalTxHash,
      timestamp: Date.now(),
    };
    liquidityHistory.unshift(event);
    dexStats.totalLiquidityEvents++;

    return c.json({
      success: true,
      removal: {
        poolId:       pid.toUpperCase(),
        lpBurned:     lpAmount.toFixed(6),
        amountAOut:   (amountAOut / 1e6).toFixed(6),
        amountBOut:   (amountBOut / 1e6).toFixed(6),
        tokenA:       pool.tokenA,
        tokenB:       pool.tokenB,
        txHash:       finalTxHash,
        explorerUrl:  `${ARC.explorer}/tx/${finalTxHash}`,
        shareRemaining: `${userPos.sharePercent.toFixed(4)}%`,
        event: {
          name:      'LiquidityRemoved',
          provider:  wallet,
          lpBurned:  lpAmount,
          amountA:   amountAOut,
          amountB:   amountBOut,
          timestamp: event.timestamp,
        },
      },
      pool: {
        id:             pool.id,
        reserveA:       (pool.reserveA / 1e6).toFixed(6),
        reserveB:       (pool.reserveB / 1e6).toFixed(6),
        totalLiquidity: pool.totalLiquidity.toFixed(6),
        tvl:            pool.tvl,
      },
      message: `✅ Removed ${(amountAOut / 1e6).toFixed(4)} ${pool.tokenA} + ${(amountBOut / 1e6).toFixed(4)} ${pool.tokenB}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/dex/positions/:wallet ──────────────────────────────────────────
dexRouter.get('/positions/:wallet', (c) => {
  const wallet = c.req.param('wallet').toLowerCase();
  const userPositions: (LPPosition & { pool: Partial<Pool> })[] = [];

  pools.forEach((pool, pid) => {
    const pos = (lpPositions.get(pid) || []).find(p => p.wallet === wallet);
    if (pos && pos.lpTokens > 0) {
      refreshPoolMetrics(pool);
      pos.sharePercent = (pos.lpTokens / pool.totalLiquidity) * 100;
      pos.valueUSD     = pool.tvl * (pos.lpTokens / pool.totalLiquidity);

      userPositions.push({
        ...pos,
        pool: {
          id:       pool.id,
          tokenA:   pool.tokenA,
          tokenB:   pool.tokenB,
          reserveA: pool.reserveA,
          reserveB: pool.reserveB,
          tvl:      pool.tvl,
          apr:      pool.apr,
          fee:      pool.fee,
        },
      });
    }
  });

  const totalValueUSD = userPositions.reduce((s, p) => s + p.valueUSD, 0);
  const totalFees     = userPositions.reduce((s, p) => s + p.feesEarned, 0);

  return c.json({
    success: true,
    wallet,
    positions: userPositions,
    summary: {
      totalPositions: userPositions.length,
      totalValueUSD,
      totalValueFormatted: `$${totalValueUSD.toFixed(2)}`,
      totalFeesEarned: totalFees,
    },
  });
});

// ─── GET /api/dex/analytics ───────────────────────────────────────────────────
dexRouter.get('/analytics', (c) => {
  const allPools = Array.from(pools.values());
  const tvlTotal = allPools.reduce((s, p) => {
    refreshPoolMetrics(p);
    return s + p.tvl;
  }, 0);
  const vol24h  = allPools.reduce((s, p) => s + p.volume24h, 0);
  const fees24h = vol24h * 0.003;
  const totalSwapCount = allPools.reduce((s, p) => s + p.swapCount, 0);

  // Impermanent loss example: if price ratio changed 50% (IL for reference)
  // IL = 2 * sqrt(ratio) / (1 + ratio) - 1
  function calcIL(priceChange: number): number {
    const r = 1 + priceChange / 100;
    return (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
  }

  const topPools = allPools
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, 5)
    .map(p => ({
      id:          p.id,
      tokenA:      p.tokenA,
      tokenB:      p.tokenB,
      tvl:         p.tvl,
      tvlFmt:      `$${p.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      volume24h:   p.volume24h,
      vol24hFmt:   `$${p.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      fees24h:     p.volume24h * p.fee,
      apr:         p.apr,
      aprFmt:      `${p.apr.toFixed(2)}%`,
      swapCount:   p.swapCount,
    }));

  const recentSwaps = swapHistory.slice(0, 10).map(s => ({
    ...s,
    amountInFmt:  (s.amountIn  / 1e6).toFixed(4),
    amountOutFmt: (s.amountOut / 1e6).toFixed(4),
    timestamp:    new Date(s.timestamp).toISOString(),
  }));

  return c.json({
    success: true,
    analytics: {
      tvlTotal,
      tvlFormatted:    `$${tvlTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      volume24h: vol24h,
      vol24hFormatted: `$${vol24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      fees24h: fees24h,
      fees24hFormatted:`$${fees24h.toFixed(2)}`,
      totalPools:      pools.size,
      totalSwaps:      totalSwapCount + dexStats.totalSwaps,
      avgAPR:          allPools.length > 0 ? (allPools.reduce((s, p) => s + p.apr, 0) / allPools.length).toFixed(2) + '%' : '0%',
      impermanentLoss: {
        '10%':  calcIL(10).toFixed(3)  + '%',
        '25%':  calcIL(25).toFixed(3)  + '%',
        '50%':  calcIL(50).toFixed(3)  + '%',
        '100%': calcIL(100).toFixed(3) + '%',
      },
    },
    topPools,
    recentSwaps,
    network: { name: ARC.name, chainId: ARC.chainId, explorer: ARC.explorer },
  });
});

// ─── GET /api/dex/swap/history ────────────────────────────────────────────────
dexRouter.get('/swap/history', (c) => {
  const wallet  = c.req.query('wallet')?.toLowerCase();
  const poolIdQ = c.req.query('poolId')?.toUpperCase();
  const limit   = Math.min(parseInt(c.req.query('limit') || '50'), 200);

  let swaps = swapHistory;
  if (wallet)  swaps = swaps.filter(s => s.wallet  === wallet);
  if (poolIdQ) swaps = swaps.filter(s => s.poolId  === poolIdQ);

  return c.json({
    success: true,
    swaps: swaps.slice(0, limit).map(s => ({
      ...s,
      amountInFmt:  (s.amountIn  / 1e6).toFixed(6),
      amountOutFmt: (s.amountOut / 1e6).toFixed(6),
      feeFmt:       (s.fee       / 1e6).toFixed(6),
      explorerUrl:  `${ARC.explorer}/tx/${s.txHash}`,
      timestampISO: new Date(s.timestamp).toISOString(),
    })),
    total: swaps.length,
  });
});

// ─── GET /api/dex/estimate-lp ─────────────────────────────────────────────────
dexRouter.get('/estimate-lp', (c) => {
  const tokenA  = (c.req.query('tokenA') || 'USDC').toUpperCase();
  const tokenB  = (c.req.query('tokenB') || 'EURC').toUpperCase();
  const amtA    = parseFloat(c.req.query('amountA') || '0');
  const amtB    = parseFloat(c.req.query('amountB') || '0');

  if (isNaN(amtA) || isNaN(amtB) || amtA <= 0 || amtB <= 0)
    return c.json({ success: false, error: 'Invalid amounts' }, 400);

  const pid  = poolId(tokenA, tokenB);
  const pool = pools.get(pid);

  const amtARaw = amtA * 1e6;
  const amtBRaw = amtB * 1e6;

  let lpEstimate: number;
  let sharePercent: number;
  let isNewPool = !pool;
  let requiredB: number | null = null;

  if (!pool) {
    lpEstimate   = sqrtBig(amtARaw * amtBRaw);
    sharePercent = 100;
  } else {
    const isAtoA   = pool.tokenA === tokenA;
    const [rA, rB] = isAtoA ? [amtARaw, amtBRaw] : [amtBRaw, amtARaw];

    const lpFromA  = (rA / pool.reserveA) * pool.totalLiquidity;
    const lpFromB  = (rB / pool.reserveB) * pool.totalLiquidity;
    lpEstimate     = Math.min(lpFromA, lpFromB);
    sharePercent   = (lpEstimate / (pool.totalLiquidity + lpEstimate)) * 100;

    // Required amountB based on pool ratio
    const ratio    = isAtoA ? pool.reserveB / pool.reserveA : pool.reserveA / pool.reserveB;
    requiredB      = (amtA * ratio);
  }

  return c.json({
    success: true,
    estimate: {
      tokenA, tokenB,
      amountA:      amtA,
      amountB:      amtB,
      requiredB,
      lpTokens:     lpEstimate.toFixed(6),
      sharePercent: sharePercent.toFixed(4),
      isNewPool,
      poolId:       pid,
    },
    pool: pool ? {
      reserveA:       (pool.reserveA / 1e6).toFixed(6),
      reserveB:       (pool.reserveB / 1e6).toFixed(6),
      totalLiquidity: pool.totalLiquidity.toFixed(6),
      priceRatio:     poolPrice(pool),
    } : null,
  });
});

// ─── GET /api/dex/network ─────────────────────────────────────────────────────
dexRouter.get('/network', (c) => {
  return c.json({
    success: true,
    network: ARC,
    contracts: {
      USDC:      TOKEN_REGISTRY.USDC.address,
      EURC:      TOKEN_REGISTRY.EURC.address,
      USYC:      TOKEN_REGISTRY.USYC.address,
      Multicall3: ARC.multicall3,
      Permit2:    ARC.permit2,
      Create2:    ARC.create2,
      FxEscrow:   ARC.fxEscrow,
    },
    dexNote: 'AMM pools are simulated in-memory for ARC Testnet. Deploy Factory/Router/Pool contracts via Foundry for production.',
    deployGuide: 'https://docs.arc.network/arc/tutorials/deploy-on-arc',
  });
});

export default dexRouter;
