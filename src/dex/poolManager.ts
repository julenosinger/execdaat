// ============================================================
// ARC DEX — Pool Manager
// Manages in-memory state for AMM liquidity pools
//
// Pool state (mirrors Solidity contract state):
//   mapping(bytes32 => Pool) public pools;
//   mapping(bytes32 => mapping(address => LPPosition)) public positions;
// ============================================================

import {
  ammGetAmountOut,
  calcPriceImpact,
  lpFirstMint,
  lpSubsequentMint,
  lpBurnReturns,
  calcShare,
  calcAPR,
  calcTVL,
  buildSwapQuote,
  type SwapQuote,
} from './pricingEngine.ts';

import {
  TOKEN_REGISTRY,
  NETWORK,
  normalizePoolId,
  tokenPriceUSD,
} from '../tokens/tokenRegistry.ts';

// ─── Data Types ───────────────────────────────────────────────────────────────

export interface Pool {
  id:             string;    // e.g. "EURC-USDC"
  tokenA:         string;    // symbol
  tokenB:         string;    // symbol
  addressA:       string;    // ERC-20 address
  addressB:       string;    // ERC-20 address
  reserveA:       number;    // raw (6 decimals)
  reserveB:       number;    // raw (6 decimals)
  totalLiquidity: number;    // total LP tokens (sqrt units)
  fee:            number;    // 0.003 = 0.3%
  volume24h:      number;    // USD volume last 24h
  feesGenerated:  number;    // total fees collected
  swapCount:      number;
  createdAt:      number;
  tvl:            number;    // USD TVL
  apr:            number;    // estimated APR %
  lastUpdated:    number;
}

export interface LPPosition {
  wallet:       string;
  poolId:       string;
  lpTokens:     number;
  sharePercent: number;
  valueUSD:     number;
  feesEarned:   number;
  depositedAt:  number;
  updatedAt:    number;
}

export interface SwapEvent {
  id:          string;
  poolId:      string;
  wallet:      string;
  tokenIn:     string;
  tokenOut:    string;
  amountIn:    number;
  amountOut:   number;
  fee:         number;
  priceImpact: number;
  txHash:      string;
  timestamp:   number;
  blockNumber: number | null;
}

export interface LiquidityEvent {
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

// ─── Pool Manager Class ───────────────────────────────────────────────────────

export class PoolManager {
  private pools:            Map<string, Pool>         = new Map();
  private lpPositions:      Map<string, LPPosition[]> = new Map();
  private swapHistory:      SwapEvent[]               = [];
  private liquidityHistory: LiquidityEvent[]          = [];
  private totalSwapCount    = 0;

  constructor() {
    this.seedDemoPools();
  }

  // ── Pool Metrics Refresh ─────────────────────────────────────────────────────
  private refreshPool(pool: Pool): void {
    const priceA = tokenPriceUSD(pool.tokenA);
    const priceB = tokenPriceUSD(pool.tokenB);
    pool.tvl         = calcTVL(pool.reserveA, pool.reserveB, priceA, priceB);
    pool.apr         = calcAPR(pool.volume24h, pool.fee, pool.tvl);
    pool.lastUpdated = Date.now();
  }

  // ── Seed Demo Pools ──────────────────────────────────────────────────────────
  private seedDemoPools(): void {
    const demoPools = [
      {
        id:            'EURC-USDC',
        tokenA:        'EURC', tokenB: 'USDC',
        addressA:      TOKEN_REGISTRY.EURC.address,
        addressB:      TOKEN_REGISTRY.USDC.address,
        reserveA:      460_000 * 1e6, reserveB: 500_000 * 1e6,
        volume24h:     125_000, feesGenerated: 3_750, swapCount: 842,
        createdAt:     Date.now() - 30 * 24 * 3600_000,
      },
      {
        id:            'USDC-USYC',
        tokenA:        'USDC', tokenB: 'USYC',
        addressA:      TOKEN_REGISTRY.USDC.address,
        addressB:      TOKEN_REGISTRY.USYC.address,
        reserveA:      200_000 * 1e6, reserveB: 198_000 * 1e6,
        volume24h:     45_000, feesGenerated: 1_350, swapCount: 289,
        createdAt:     Date.now() - 14 * 24 * 3600_000,
      },
      {
        id:            'EURC-USYC',
        tokenA:        'EURC', tokenB: 'USYC',
        addressA:      TOKEN_REGISTRY.EURC.address,
        addressB:      TOKEN_REGISTRY.USYC.address,
        reserveA:      80_000 * 1e6, reserveB: 87_200 * 1e6,
        volume24h:     18_000, feesGenerated: 540, swapCount: 104,
        createdAt:     Date.now() - 7 * 24 * 3600_000,
      },
    ];

    demoPools.forEach(d => {
      const lp = lpFirstMint(d.reserveA, d.reserveB);
      const pool: Pool = {
        ...d,
        totalLiquidity: lp,
        fee:            0.003,
        tvl:            0,
        apr:            0,
        lastUpdated:    Date.now(),
      };
      this.refreshPool(pool);
      this.pools.set(d.id, pool);

      // Seed demo positions
      this.lpPositions.set(d.id, [
        {
          wallet:      '0xb815a0c4bc23930119324d4359db65e27a846a2d',
          poolId:      d.id,
          lpTokens:    lp * 0.35,
          sharePercent: 35,
          valueUSD:    pool.tvl * 0.35,
          feesEarned:  d.feesGenerated * 0.35,
          depositedAt: d.createdAt + 86400_000,
          updatedAt:   Date.now(),
        },
        {
          wallet:      '0x411c60f8e61b5cbe32f9a873b16d21ca85e9a634',
          poolId:      d.id,
          lpTokens:    lp * 0.25,
          sharePercent: 25,
          valueUSD:    pool.tvl * 0.25,
          feesEarned:  d.feesGenerated * 0.25,
          depositedAt: d.createdAt + 172800_000,
          updatedAt:   Date.now(),
        },
      ]);
    });
  }

  // ── Get Pool ─────────────────────────────────────────────────────────────────
  getPool(id: string): Pool | undefined {
    const pool = this.pools.get(id.toUpperCase());
    if (pool) this.refreshPool(pool);
    return pool;
  }

  // ── Get All Pools ─────────────────────────────────────────────────────────────
  getAllPools(): Pool[] {
    return Array.from(this.pools.values()).map(p => {
      this.refreshPool(p);
      return p;
    });
  }

  // ── Get Quote ─────────────────────────────────────────────────────────────────
  getQuote(fromToken: string, toToken: string, amountIn: number, slippage = 0.5): SwapQuote | null {
    const pid  = normalizePoolId(fromToken, toToken);
    const pool = this.getPool(pid);
    if (!pool) return null;

    const isAtoB    = pool.tokenA === fromToken.toUpperCase();
    const reserveIn  = isAtoB ? pool.reserveA : pool.reserveB;
    const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;
    const rawIn      = amountIn * 1e6;

    return buildSwapQuote(rawIn, reserveIn, reserveOut, fromToken, toToken, pid, slippage);
  }

  // ── Execute Swap ─────────────────────────────────────────────────────────────
  executeSwap(params: {
    fromToken:   string;
    toToken:     string;
    amountIn:    number;
    wallet:      string;
    txHash:      string;
    slippage?:   number;
    blockNumber?: number | null;
  }): { event: SwapEvent; poolAfter: Partial<Pool>; quote: SwapQuote } {
    const { fromToken, toToken, amountIn, wallet, txHash, slippage = 0.5, blockNumber = null } = params;

    const pid  = normalizePoolId(fromToken, toToken);
    const pool = this.pools.get(pid);
    if (!pool) throw new Error(`Pool ${pid} not found`);

    const from    = fromToken.toUpperCase();
    const to      = toToken.toUpperCase();
    const isAtoB  = pool.tokenA === from;
    const rIn     = isAtoB ? pool.reserveA : pool.reserveB;
    const rOut    = isAtoB ? pool.reserveB : pool.reserveA;
    const rawIn   = amountIn * 1e6;
    const rawOut  = ammGetAmountOut(rawIn, rIn, rOut);
    const impact  = calcPriceImpact(rawIn, rIn);

    if (impact > 15) throw new Error(`Price impact ${impact.toFixed(2)}% exceeds 15% limit`);

    // Update reserves
    if (isAtoB) {
      pool.reserveA += rawIn;
      pool.reserveB -= rawOut;
    } else {
      pool.reserveB += rawIn;
      pool.reserveA -= rawOut;
    }
    pool.swapCount      += 1;
    pool.volume24h      += amountIn;
    pool.feesGenerated  += amountIn * pool.fee;
    this.refreshPool(pool);
    this.totalSwapCount += 1;

    const event: SwapEvent = {
      id:          `swap-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      poolId:      pid,
      wallet:      wallet.toLowerCase(),
      tokenIn:     from,
      tokenOut:    to,
      amountIn:    rawIn,
      amountOut:   rawOut,
      fee:         amountIn * pool.fee * 1e6,
      priceImpact: impact,
      txHash,
      timestamp:   Date.now(),
      blockNumber,
    };
    this.swapHistory.unshift(event);
    if (this.swapHistory.length > 500) this.swapHistory.pop();

    const quote = buildSwapQuote(rawIn, rIn, rOut, from, to, pid, slippage);

    return {
      event,
      quote,
      poolAfter: {
        id:             pool.id,
        reserveA:       pool.reserveA,
        reserveB:       pool.reserveB,
        tvl:            pool.tvl,
        totalLiquidity: pool.totalLiquidity,
      },
    };
  }

  // ── Add Liquidity ─────────────────────────────────────────────────────────────
  addLiquidity(params: {
    tokenA:      string;
    tokenB:      string;
    amountA:     number;
    amountB:     number;
    wallet:      string;
    txHash:      string;
    blockNumber?: number | null;
  }): { event: LiquidityEvent; lpMinted: number; isNewPool: boolean; share: number; pool: Pool } {
    const { tokenA, tokenB, amountA, amountB, wallet, txHash, blockNumber = null } = params;
    const tA  = tokenA.toUpperCase();
    const tB  = tokenB.toUpperCase();
    const pid = normalizePoolId(tA, tB);

    const rawA = amountA * 1e6;
    const rawB = amountB * 1e6;

    let pool = this.pools.get(pid);
    let lpMinted: number;
    let isNewPool = false;

    if (!pool) {
      // New pool
      isNewPool = true;
      lpMinted  = lpFirstMint(rawA, rawB);

      const [sA, sB] = [tA, tB].sort();
      const [rA, rB] = sA === tA ? [rawA, rawB] : [rawB, rawA];
      const tokA = TOKEN_REGISTRY[sA];
      const tokB = TOKEN_REGISTRY[sB];
      if (!tokA || !tokB) throw new Error(`Unknown token(s): ${tA}, ${tB}`);

      pool = {
        id:             pid,
        tokenA:         sA,
        tokenB:         sB,
        addressA:       tokA.address,
        addressB:       tokB.address,
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
        lastUpdated:    Date.now(),
      };
      this.pools.set(pid, pool);
      this.lpPositions.set(pid, []);

    } else {
      // Existing pool
      const isAtoA = pool.tokenA === tA;
      const [rA, rB] = isAtoA ? [rawA, rawB] : [rawB, rawA];
      lpMinted = lpSubsequentMint(rA, rB, pool.reserveA, pool.reserveB, pool.totalLiquidity);
      pool.reserveA       += isAtoA ? rA : rB;
      pool.reserveB       += isAtoA ? rB : rA;
      pool.totalLiquidity += lpMinted;
    }

    this.refreshPool(pool);

    // Update positions
    const positions = this.lpPositions.get(pid) || [];
    const walletLow = wallet.toLowerCase();
    const existing  = positions.find(p => p.wallet === walletLow);

    if (existing) {
      existing.lpTokens  += lpMinted;
      existing.updatedAt  = Date.now();
    } else {
      positions.push({
        wallet:      walletLow,
        poolId:      pid,
        lpTokens:    lpMinted,
        sharePercent: 0,
        valueUSD:    0,
        feesEarned:  0,
        depositedAt: Date.now(),
        updatedAt:   Date.now(),
      });
      this.lpPositions.set(pid, positions);
    }

    // Recalc all shares
    this.recalcShares(pid, pool);

    const userPos = positions.find(p => p.wallet === walletLow)!;
    const share   = userPos.sharePercent;

    const event: LiquidityEvent = {
      id:        `lp-add-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      poolId:    pid,
      wallet:    walletLow,
      type:      'add',
      amountA:   rawA,
      amountB:   rawB,
      lpTokens:  lpMinted,
      txHash,
      timestamp: Date.now(),
    };
    this.liquidityHistory.unshift(event);
    if (this.liquidityHistory.length > 200) this.liquidityHistory.pop();

    return { event, lpMinted, isNewPool, share, pool };
  }

  // ── Remove Liquidity ──────────────────────────────────────────────────────────
  removeLiquidity(params: {
    poolId:      string;
    lpAmount:    number;
    wallet:      string;
    txHash:      string;
    blockNumber?: number | null;
  }): { event: LiquidityEvent; amountAOut: number; amountBOut: number; pool: Pool } {
    const { poolId, lpAmount, wallet, txHash } = params;
    const pid  = poolId.toUpperCase();
    const pool = this.pools.get(pid);
    if (!pool) throw new Error(`Pool ${pid} not found`);

    const walletLow = wallet.toLowerCase();
    const positions = this.lpPositions.get(pid) || [];
    const userPos   = positions.find(p => p.wallet === walletLow);
    if (!userPos) throw new Error('No liquidity position found for this wallet');
    if (lpAmount <= 0 || lpAmount > userPos.lpTokens)
      throw new Error(`Insufficient LP tokens. Have ${(userPos.lpTokens / 1e6).toFixed(6)}`);

    const { amountA, amountB } = lpBurnReturns(lpAmount, pool.totalLiquidity, pool.reserveA, pool.reserveB);

    pool.reserveA       -= amountA;
    pool.reserveB       -= amountB;
    pool.totalLiquidity -= lpAmount;
    this.refreshPool(pool);

    userPos.lpTokens -= lpAmount;
    userPos.updatedAt = Date.now();
    if (userPos.lpTokens <= 0) {
      const idx = positions.findIndex(p => p.wallet === walletLow);
      positions.splice(idx, 1);
    }
    this.recalcShares(pid, pool);

    const event: LiquidityEvent = {
      id:        `lp-rm-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      poolId:    pid,
      wallet:    walletLow,
      type:      'remove',
      amountA,
      amountB,
      lpTokens:  lpAmount,
      txHash,
      timestamp: Date.now(),
    };
    this.liquidityHistory.unshift(event);
    if (this.liquidityHistory.length > 200) this.liquidityHistory.pop();

    return { event, amountAOut: amountA, amountBOut: amountB, pool };
  }

  // ── Get User Positions ────────────────────────────────────────────────────────
  getUserPositions(wallet: string): (LPPosition & { pool: Partial<Pool> })[] {
    const wl = wallet.toLowerCase();
    const result: (LPPosition & { pool: Partial<Pool> })[] = [];

    this.pools.forEach((pool, pid) => {
      this.refreshPool(pool);
      const pos = (this.lpPositions.get(pid) || []).find(p => p.wallet === wl);
      if (pos && pos.lpTokens > 0) {
        this.recalcShares(pid, pool);
        result.push({
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
            totalLiquidity: pool.totalLiquidity,
          },
        });
      }
    });
    return result;
  }

  // ── Get Swap History ──────────────────────────────────────────────────────────
  getSwapHistory(filter?: { wallet?: string; poolId?: string; limit?: number }): SwapEvent[] {
    let swaps = this.swapHistory;
    if (filter?.wallet)  swaps = swaps.filter(s => s.wallet  === filter.wallet!.toLowerCase());
    if (filter?.poolId)  swaps = swaps.filter(s => s.poolId  === filter.poolId!.toUpperCase());
    return swaps.slice(0, filter?.limit ?? 50);
  }

  // ── LP Estimate ───────────────────────────────────────────────────────────────
  estimateLP(tokenA: string, tokenB: string, amountA: number, amountB: number) {
    const pid  = normalizePoolId(tokenA, tokenB);
    const pool = this.pools.get(pid);
    const rawA = amountA * 1e6;
    const rawB = amountB * 1e6;

    if (!pool) {
      const lp = lpFirstMint(rawA, rawB);
      return { lp, sharePercent: 100, isNewPool: true, requiredB: null, pool: null };
    }

    const isAtoA = pool.tokenA === tokenA.toUpperCase();
    const [rA, rB] = isAtoA ? [rawA, rawB] : [rawB, rawA];
    const lp = lpSubsequentMint(rA, rB, pool.reserveA, pool.reserveB, pool.totalLiquidity);
    const sharePercent = calcShare(lp, pool.totalLiquidity + lp);
    const ratio = isAtoA ? pool.reserveB / pool.reserveA : pool.reserveA / pool.reserveB;
    const requiredB = amountA * ratio;

    return { lp, sharePercent, isNewPool: false, requiredB, pool };
  }

  // ── Analytics ────────────────────────────────────────────────────────────────
  getAnalytics() {
    const allPools   = this.getAllPools();
    const tvlTotal   = allPools.reduce((s, p) => s + p.tvl, 0);
    const vol24h     = allPools.reduce((s, p) => s + p.volume24h, 0);
    const fees24h    = vol24h * 0.003;
    const swapCount  = allPools.reduce((s, p) => s + p.swapCount, 0);
    const avgAPR     = allPools.length > 0
      ? allPools.reduce((s, p) => s + p.apr, 0) / allPools.length : 0;

    const topPools = [...allPools]
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 5)
      .map(p => ({
        id:        p.id,
        tokenA:    p.tokenA,
        tokenB:    p.tokenB,
        tvl:       p.tvl,
        tvlFmt:    `$${p.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        volume24h: p.volume24h,
        fees24h:   p.volume24h * p.fee,
        apr:       p.apr,
        aprFmt:    `${p.apr.toFixed(2)}%`,
        swapCount: p.swapCount,
      }));

    return {
      tvlTotal, vol24h, fees24h, swapCount,
      avgAPR: avgAPR.toFixed(2) + '%',
      poolCount: allPools.length,
      topPools,
      recentSwaps: this.swapHistory.slice(0, 10),
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────────
  private recalcShares(pid: string, pool: Pool): void {
    const positions = this.lpPositions.get(pid) || [];
    positions.forEach(p => {
      p.sharePercent = pool.totalLiquidity > 0
        ? (p.lpTokens / pool.totalLiquidity) * 100 : 0;
      p.valueUSD     = pool.tvl * (p.lpTokens / Math.max(pool.totalLiquidity, 1));
    });
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────
export const poolManager = new PoolManager();
export default poolManager;
