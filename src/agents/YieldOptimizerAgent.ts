// YieldOptimizerAgent — Otimizador Autônomo de Yield
// Monitora pools USDC/EURC, analisa APY, rebalanceia posições
// e executa estratégias de maximização de rendimento na Arc Testnet

import { ARC_TESTNET } from '../types/arc';

// ─── Types ────────────────────────────────────────────────────────────────────
export type StrategyType = 'conservative' | 'balanced' | 'aggressive' | 'custom';
export type PositionStatus = 'active' | 'rebalancing' | 'paused' | 'closed';

export interface YieldPool {
  id: string;
  name: string;
  token: 'USDC' | 'EURC';
  protocol: string;
  apy: number;
  apyBase: number;
  apyRewards: number;
  tvl: number;
  utilization: number;
  risk: 'low' | 'medium' | 'high';
  contractAddress: string;
  lastUpdated: string;
  trend: 'up' | 'down' | 'stable';
  trendPct: number;
}

export interface YieldPosition {
  id: string;
  walletAddress: string;
  poolId: string;
  token: 'USDC' | 'EURC';
  deposited: number;
  currentValue: number;
  yieldEarned: number;
  entryApy: number;
  currentApy: number;
  openedAt: string;
  lastRebalancedAt?: string;
  status: PositionStatus;
  strategy: StrategyType;
  txHash: string;
}

export interface RebalanceAction {
  id: string;
  fromPool: string;
  toPool: string;
  amount: number;
  token: 'USDC' | 'EURC';
  reason: string;
  expectedGain: number;    // APY improvement
  gasCostUSDC: number;
  netBenefitUSDC: number;
  executedAt?: string;
  txHash?: string;
  status: 'pending' | 'executed' | 'failed' | 'skipped';
}

export interface YieldStrategy {
  type: StrategyType;
  name: string;
  description: string;
  minRisk: number;        // 0-100
  maxRisk: number;
  targetApy: number;
  rebalanceThreshold: number;  // min APY diff to trigger rebalance (%)
  maxPositions: number;
  autoCompound: boolean;
}

export interface OptimizerStats {
  totalPositions: number;
  activePositions: number;
  totalDeposited: number;
  totalYieldEarned: number;
  rebalances: number;
  averageApy: number;
  bestApy: number;
  lastRebalanceAt?: string;
  nextRebalanceEstimate?: string;
  agentStatus: 'scanning' | 'optimizing' | 'idle' | 'waiting';
}

// ─── Strategy Definitions ─────────────────────────────────────────────────────
const STRATEGIES: Record<StrategyType, YieldStrategy> = {
  conservative: {
    type: 'conservative',
    name: 'Conservative Yield',
    description: 'Capital preservation first. Low-risk pools only. Min rebalance threshold.',
    minRisk: 0, maxRisk: 30, targetApy: 4.0,
    rebalanceThreshold: 1.5, maxPositions: 3, autoCompound: false,
  },
  balanced: {
    type: 'balanced',
    name: 'Balanced Optimizer',
    description: 'Mix of stability and yield. Auto-rebalances when APY diff > 1%. Auto-compounds weekly.',
    minRisk: 0, maxRisk: 60, targetApy: 7.0,
    rebalanceThreshold: 1.0, maxPositions: 5, autoCompound: true,
  },
  aggressive: {
    type: 'aggressive',
    name: 'Aggressive Yield',
    description: 'Max yield hunting. Accepts higher risk. Rebalances frequently. Auto-compounds daily.',
    minRisk: 0, maxRisk: 100, targetApy: 12.0,
    rebalanceThreshold: 0.5, maxPositions: 8, autoCompound: true,
  },
  custom: {
    type: 'custom',
    name: 'Custom Strategy',
    description: 'User-defined parameters.',
    minRisk: 0, maxRisk: 100, targetApy: 8.0,
    rebalanceThreshold: 1.0, maxPositions: 5, autoCompound: false,
  },
};

// ─── Agent ────────────────────────────────────────────────────────────────────
export class YieldOptimizerAgent {
  private pools: Map<string, YieldPool> = new Map();
  private positions: Map<string, YieldPosition> = new Map();
  private rebalanceHistory: RebalanceAction[] = [];
  private stats: OptimizerStats = {
    totalPositions: 0,
    activePositions: 0,
    totalDeposited: 0,
    totalYieldEarned: 0,
    rebalances: 0,
    averageApy: 0,
    bestApy: 0,
    agentStatus: 'idle',
  };

  constructor() {
    this._initPools();
    this._startYieldAccrual();
  }

  // ─── Init pools ────────────────────────────────────────────────────────────
  private _initPools() {
    const now = new Date().toISOString();
    const poolDefs: YieldPool[] = [
      // USDC pools
      {
        id: 'arc-usdc-vault', name: 'ARC USDC Vault', token: 'USDC', protocol: 'ARC Native',
        apy: 5.2, apyBase: 5.2, apyRewards: 0, tvl: 930_000, utilization: 74,
        risk: 'low', contractAddress: '0x1100000000000000000000000000000000000001',
        lastUpdated: now, trend: 'stable', trendPct: 0.1,
      },
      {
        id: 'arc-usdc-lend', name: 'ARC USDC Lending', token: 'USDC', protocol: 'ARC Lend',
        apy: 7.8, apyBase: 6.5, apyRewards: 1.3, tvl: 2_400_000, utilization: 82,
        risk: 'medium', contractAddress: '0x2200000000000000000000000000000000000001',
        lastUpdated: now, trend: 'up', trendPct: 0.8,
      },
      {
        id: 'arc-usdc-mm', name: 'ARC Money Market', token: 'USDC', protocol: 'ARC MM',
        apy: 4.1, apyBase: 4.1, apyRewards: 0, tvl: 5_800_000, utilization: 63,
        risk: 'low', contractAddress: '0x3300000000000000000000000000000000000001',
        lastUpdated: now, trend: 'down', trendPct: -0.3,
      },
      {
        id: 'arc-usdc-yield', name: 'ARC High Yield USDC', token: 'USDC', protocol: 'ARC Yield',
        apy: 11.5, apyBase: 8.0, apyRewards: 3.5, tvl: 820_000, utilization: 91,
        risk: 'high', contractAddress: '0x4400000000000000000000000000000000000001',
        lastUpdated: now, trend: 'up', trendPct: 1.2,
      },
      // EURC pools
      {
        id: 'arc-eurc-vault', name: 'ARC EURC Vault', token: 'EURC', protocol: 'ARC Native',
        apy: 4.8, apyBase: 4.8, apyRewards: 0, tvl: 680_000, utilization: 68,
        risk: 'low', contractAddress: '0x1100000000000000000000000000000000000002',
        lastUpdated: now, trend: 'stable', trendPct: 0.0,
      },
      {
        id: 'arc-eurc-lend', name: 'ARC EURC Lending', token: 'EURC', protocol: 'ARC Lend',
        apy: 6.9, apyBase: 5.8, apyRewards: 1.1, tvl: 1_100_000, utilization: 77,
        risk: 'medium', contractAddress: '0x2200000000000000000000000000000000000002',
        lastUpdated: now, trend: 'up', trendPct: 0.5,
      },
      {
        id: 'arc-eurc-fx', name: 'ARC EURC/USDC LP', token: 'EURC', protocol: 'ARC DEX',
        apy: 9.4, apyBase: 4.2, apyRewards: 5.2, tvl: 450_000, utilization: 88,
        risk: 'high', contractAddress: '0x5500000000000000000000000000000000000002',
        lastUpdated: now, trend: 'up', trendPct: 2.1,
      },
    ];
    poolDefs.forEach(p => this.pools.set(p.id, p));
  }

  // ─── Background yield accrual ──────────────────────────────────────────────
  private _startYieldAccrual() {
    // Simulates market movements every 30s
    setInterval(() => this._tickMarket(), 30_000);
  }

  private _tickMarket() {
    for (const pool of this.pools.values()) {
      // Random walk APY
      const change = (Math.random() - 0.5) * 0.4;
      pool.apy = Math.max(1.0, Math.round((pool.apy + change) * 100) / 100);
      pool.utilization = Math.min(99, Math.max(40, pool.utilization + (Math.random() - 0.5) * 2));
      pool.lastUpdated = new Date().toISOString();
      pool.trend = change > 0.1 ? 'up' : change < -0.1 ? 'down' : 'stable';
      pool.trendPct = Math.round(change * 100) / 100;

      // Accrue yield for all active positions in this pool
      for (const pos of this.positions.values()) {
        if (pos.poolId === pool.id && pos.status === 'active') {
          const hourlyRate = pool.apy / 100 / 8760 / 120; // per 30s
          const yieldNow = pos.currentValue * hourlyRate;
          pos.currentValue += yieldNow;
          pos.yieldEarned += yieldNow;
          pos.currentApy = pool.apy;
        }
      }
    }

    this._updateStats();
    this.stats.agentStatus = 'scanning';
    setTimeout(() => { this.stats.agentStatus = 'idle'; }, 2000);
  }

  // ─── Get pools ─────────────────────────────────────────────────────────────
  getPools(token?: 'USDC' | 'EURC'): YieldPool[] {
    const list = Array.from(this.pools.values());
    if (token) return list.filter(p => p.token === token);
    return list.sort((a, b) => b.apy - a.apy);
  }

  getBestPool(token: 'USDC' | 'EURC', strategy: StrategyType): YieldPool | null {
    const strat = STRATEGIES[strategy];
    const eligible = this.getPools(token).filter(p => {
      const riskScore = p.risk === 'low' ? 20 : p.risk === 'medium' ? 50 : 80;
      return riskScore >= strat.minRisk && riskScore <= strat.maxRisk;
    });
    if (!eligible.length) return null;
    return eligible.sort((a, b) => b.apy - a.apy)[0];
  }

  // ─── Open position ─────────────────────────────────────────────────────────
  async openPosition(params: {
    walletAddress: string;
    poolId: string;
    amount: number;
    strategy: StrategyType;
    txHash: string;
  }): Promise<YieldPosition> {
    const pool = this.pools.get(params.poolId);
    if (!pool) throw new Error(`Pool ${params.poolId} not found`);

    const posId = `pos-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const position: YieldPosition = {
      id: posId,
      walletAddress: params.walletAddress,
      poolId: params.poolId,
      token: pool.token,
      deposited: params.amount,
      currentValue: params.amount,
      yieldEarned: 0,
      entryApy: pool.apy,
      currentApy: pool.apy,
      openedAt: new Date().toISOString(),
      status: 'active',
      strategy: params.strategy,
      txHash: params.txHash,
    };

    this.positions.set(posId, position);
    pool.tvl += params.amount;
    this._updateStats();

    return position;
  }

  // ─── Close position ────────────────────────────────────────────────────────
  async closePosition(positionId: string, txHash: string): Promise<YieldPosition> {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    const pool = this.pools.get(pos.poolId);
    if (pool) pool.tvl -= pos.currentValue;

    pos.status = 'closed';
    this._updateStats();
    return pos;
  }

  // ─── Analyze & recommend ───────────────────────────────────────────────────
  analyzePortfolio(walletAddress: string): {
    positions: YieldPosition[];
    recommendations: Array<{
      type: string;
      priority: 'high' | 'medium' | 'low';
      description: string;
      potentialGainApy: number;
      action: string;
    }>;
    totalDeposited: number;
    totalValue: number;
    totalYield: number;
    weightedApy: number;
  } {
    const userPositions = Array.from(this.positions.values())
      .filter(p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase() && p.status === 'active');

    const recs: ReturnType<typeof this.analyzePortfolio>['recommendations'] = [];
    let totalDeposited = 0, totalValue = 0, totalYield = 0;

    for (const pos of userPositions) {
      totalDeposited += pos.deposited;
      totalValue += pos.currentValue;
      totalYield += pos.yieldEarned;

      const pool = this.pools.get(pos.poolId);
      if (!pool) continue;

      // Check if a better pool exists for the same token
      const best = this.getBestPool(pos.token, pos.strategy);
      if (best && best.id !== pos.poolId && best.apy > pool.apy + STRATEGIES[pos.strategy].rebalanceThreshold) {
        recs.push({
          type: 'rebalance',
          priority: best.apy - pool.apy > 2 ? 'high' : 'medium',
          description: `Move ${pos.token} from ${pool.name} (${pool.apy}% APY) to ${best.name} (${best.apy}% APY)`,
          potentialGainApy: Math.round((best.apy - pool.apy) * 100) / 100,
          action: `rebalance:${pos.id}:${best.id}`,
        });
      }

      // APY declined significantly
      if (pool.apy < pos.entryApy - 1.5) {
        recs.push({
          type: 'apy_decline',
          priority: 'medium',
          description: `APY declined from ${pos.entryApy}% to ${pool.apy}% in ${pool.name}`,
          potentialGainApy: pos.entryApy - pool.apy,
          action: `review:${pos.id}`,
        });
      }
    }

    // No positions — suggest best pools
    if (userPositions.length === 0) {
      const bestUsdc = this.getBestPool('USDC', 'balanced');
      const bestEurc = this.getBestPool('EURC', 'balanced');
      if (bestUsdc) {
        recs.push({
          type: 'new_position',
          priority: 'low',
          description: `Start earning ${bestUsdc.apy}% APY on USDC in ${bestUsdc.name}`,
          potentialGainApy: bestUsdc.apy,
          action: `deposit:${bestUsdc.id}`,
        });
      }
      if (bestEurc) {
        recs.push({
          type: 'new_position',
          priority: 'low',
          description: `Start earning ${bestEurc.apy}% APY on EURC in ${bestEurc.name}`,
          potentialGainApy: bestEurc.apy,
          action: `deposit:${bestEurc.id}`,
        });
      }
    }

    const weightedApy = totalDeposited > 0
      ? userPositions.reduce((sum, p) => sum + p.currentApy * p.deposited, 0) / totalDeposited
      : 0;

    return {
      positions: userPositions,
      recommendations: recs.sort((a, b) =>
        ['high', 'medium', 'low'].indexOf(a.priority) - ['high', 'medium', 'low'].indexOf(b.priority)
      ),
      totalDeposited,
      totalValue,
      totalYield,
      weightedApy: Math.round(weightedApy * 100) / 100,
    };
  }

  // ─── Auto-rebalance ────────────────────────────────────────────────────────
  async autoRebalance(positionId: string): Promise<RebalanceAction> {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error(`Position not found`);

    const pool = this.pools.get(pos.poolId);
    if (!pool) throw new Error(`Pool not found`);

    const best = this.getBestPool(pos.token, pos.strategy);
    if (!best || best.id === pos.poolId) {
      const skip: RebalanceAction = {
        id: `reb-${Date.now()}`, fromPool: pos.poolId, toPool: pos.poolId,
        amount: pos.currentValue, token: pos.token,
        reason: 'Already in optimal pool', expectedGain: 0,
        gasCostUSDC: 0.009 * 1e6, netBenefitUSDC: 0, status: 'skipped',
      };
      this.rebalanceHistory.unshift(skip);
      return skip;
    }

    const gasCost = 0.018 * 1e6; // 2 txs × $0.009
    const annualGain = pos.currentValue * (best.apy - pool.apy) / 100;
    const daysToBreakEven = (gasCost / 1e6) / (annualGain / 365 / 1e6);
    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    // Move position
    const oldPool = pool;
    oldPool.tvl -= pos.currentValue;
    pos.poolId = best.id;
    pos.currentApy = best.apy;
    pos.lastRebalancedAt = new Date().toISOString();
    best.tvl += pos.currentValue;

    const action: RebalanceAction = {
      id: `reb-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      fromPool: pool.name,
      toPool: best.name,
      amount: pos.currentValue,
      token: pos.token,
      reason: `APY improved from ${pool.apy}% to ${best.apy}% (breakeven: ${daysToBreakEven.toFixed(1)} days)`,
      expectedGain: Math.round((best.apy - pool.apy) * 100) / 100,
      gasCostUSDC: gasCost,
      netBenefitUSDC: Math.round(annualGain - gasCost),
      executedAt: new Date().toISOString(),
      txHash,
      status: 'executed',
    };

    this.rebalanceHistory.unshift(action);
    if (this.rebalanceHistory.length > 100) this.rebalanceHistory.pop();
    this.stats.rebalances++;
    this.stats.lastRebalanceAt = action.executedAt;

    return action;
  }

  // ─── Getters ──────────────────────────────────────────────────────────────
  getPositions(walletAddress?: string): YieldPosition[] {
    const all = Array.from(this.positions.values());
    if (!walletAddress) return all;
    return all.filter(p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase());
  }

  getPosition(id: string): YieldPosition | null {
    return this.positions.get(id) ?? null;
  }

  getStrategies(): YieldStrategy[] {
    return Object.values(STRATEGIES);
  }

  getStats(): OptimizerStats {
    return { ...this.stats };
  }

  getRebalanceHistory(limit = 20): RebalanceAction[] {
    return this.rebalanceHistory.slice(0, limit);
  }

  private _updateStats() {
    const active = Array.from(this.positions.values()).filter(p => p.status === 'active');
    this.stats.totalPositions = this.positions.size;
    this.stats.activePositions = active.length;
    this.stats.totalDeposited = active.reduce((s, p) => s + p.deposited, 0);
    this.stats.totalYieldEarned = active.reduce((s, p) => s + p.yieldEarned, 0);
    this.stats.averageApy = active.length > 0
      ? Math.round(active.reduce((s, p) => s + p.currentApy, 0) / active.length * 100) / 100
      : 0;
    this.stats.bestApy = active.length > 0
      ? Math.max(...active.map(p => p.currentApy))
      : Math.max(...Array.from(this.pools.values()).map(p => p.apy));
  }
}
