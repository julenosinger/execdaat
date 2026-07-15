import type { DexCache, DexSnapshot } from './dex-cache.mjs';
import type { DepthEntry, DonationReport, PoolClassification, PriceRatio } from './dex-metrics.mjs';

export declare const DEADLINE_SUGGESTION_SEC: number;
export declare const QUOTE_VALIDITY_MS: number;
export declare const CAPABILITY_SELECTORS: Record<string, string>;

export interface AmmCapabilities {
  [key: string]: boolean | number;
  bytecodeSize: number;
  deadlineSupportedOnChain: boolean;
  twapAccumulatorsOnChain: boolean;
  upgradeable: boolean;
}

export interface TwapFeasibility {
  onChainTwap: 'FEASIBLE' | 'NOT_FEASIBLE';
  cumulativePriceDataExists: boolean;
  helperContractPossible: boolean;
  helperContractRecommended: boolean;
  offChainOracle: string;
  migrationRequired: boolean;
  detail: string;
}

export interface DeadlineGuidance {
  deadlineSuggestion: number;
  deadlineSuggestionISO: string;
  quoteExpiresAt: string;
  deadlineSupportedOnChain: boolean;
  note: string;
}

export interface LpAnalytics {
  lpSupply: string;
  lpSupplyHuman: number;
  lpValueUsdc: number;
  growthIndex: number;
  utilization: number;
  minimumLiquidityLock: string | null;
  minimumLiquidityLockPct: number | null;
  lpHealth: string;
}

export interface LpPosition {
  lpBalance: string;
  lpBalanceHuman: number;
  sharePercent: number;
  withdrawableA: number;
  withdrawableB: number;
  valueUsdc: number;
}

export interface LiquidityAnalysis {
  valid: boolean;
  error?: string;
  firstDeposit?: boolean;
  verdict?: string;
  expectedLpTokens?: string;
  expectedLpTokensHuman?: number;
  expectedSharePercent?: number;
  optimalRatio?: Record<string, unknown>;
  donation?: { amountA: number; amountB: number; totalUsdc: number; pctOfDeposit: number; amountARaw?: string; amountBRaw?: string };
  liquidityPriceImpactPct?: number;
  note?: string;
}

export interface RiskFactor {
  factor: string;
  level: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  detail: string;
}

export interface PoolRisk {
  overall: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  factors: RiskFactor[];
  informationalOnly: true;
}

export interface PoolAnalyticsSnapshot {
  ammAddress: string;
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  balanceA: bigint;
  balanceB: bigint;
  tvl: number;
  priceRatio: PriceRatio;
  reserveRatio: number;
  liquidityDepth: DepthEntry[];
  impact1000Pct: number | null;
  donation: DonationReport;
  donationStatus: string;
  poolHealth: PoolClassification;
  lpMetrics: LpAnalytics;
  risk: PoolRisk;
  blockNumber: number;
  timestamp: number;
  source: 'on-chain' | 'cache';
  cacheAge: number;
}

export interface AnalyticsEngine {
  getAnalytics(): Promise<PoolAnalyticsSnapshot>;
  invalidate(): void;
}

export declare function scanBytecodeCapabilities(bytecodeHex: string): AmmCapabilities;
export declare function analyzeTwapFeasibility(capabilities: AmmCapabilities | null): TwapFeasibility;
export declare function makeDeadlineGuidance(nowMs: number, capabilities?: AmmCapabilities | null): DeadlineGuidance;
export declare function isDeadlineValid(deadlineUnixSec: unknown, nowMs: number): boolean;
export declare function calcLpAnalytics(snapshot: DexSnapshot | PoolAnalyticsSnapshot, minimumLiquidity?: bigint | null): LpAnalytics;
export declare function calcLpPosition(snapshot: DexSnapshot | PoolAnalyticsSnapshot, lpBalance: bigint): LpPosition;
export declare function analyzeLiquidityAddition(snapshot: DexSnapshot | PoolAnalyticsSnapshot, amountA: bigint, amountB: bigint): LiquidityAnalysis;
export declare function assessPoolRisk(snapshot: DexSnapshot, depthLevels: DepthEntry[], poolHealth: PoolClassification | null): PoolRisk;
export declare function buildPoolAnalyticsSnapshot(dexSnapshot: DexSnapshot, options?: { minimumLiquidity?: bigint | null }): Omit<PoolAnalyticsSnapshot, never>;
export declare function createAnalyticsEngine(options: { dexCache: DexCache; log?: (f: Record<string, unknown>) => void; now?: () => number }): AnalyticsEngine;
