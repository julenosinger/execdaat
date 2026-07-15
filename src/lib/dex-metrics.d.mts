export declare const FEE_NUM: bigint;
export declare const FEE_DENOM: bigint;
export declare const DEPTH_LEVELS_USDC: number[];
export declare const HEALTH_THRESHOLDS: {
  TVL_HEALTHY_USDC: number;
  TVL_LOW_USDC: number;
  IMPACT_HEALTHY_PCT: number;
  IMPACT_WARNING_PCT: number;
  PRICE_IMBALANCE_MIN: number;
  PRICE_IMBALANCE_MAX: number;
  DONATION_WARNING_PCT: number;
};
export declare const HEALTH_LABELS: Record<string, string>;

export interface PriceRatio {
  priceAinB: number;
  priceBinA: number;
}

export interface DepthEntry {
  amountIn: number;
  estimatedAmountOut: number;
  priceImpact: number | null;
  slippage: number | null;
  minimumAmountOut: number;
  exceedsLiquidity: boolean;
}

export interface DonationExcess {
  asset: string;
  excessRaw: string;
  excessAmount: number;
  pctOfReserve: number | null;
}

export interface DonationReport {
  status: 'CLEAN' | 'EXCESS_DETECTED' | 'DEFICIT_ALERT';
  excess: DonationExcess[];
  deficit: Array<{ asset: string; deficitRaw: string; deficitAmount: number }>;
  blockNumber: number | null;
  timestamp: string | null;
}

export interface PoolClassification {
  status: 'HEALTHY' | 'GOOD' | 'WARNING' | 'LOW_LIQUIDITY' | 'IMBALANCED' | 'CRITICAL';
  label: string;
  reasons: string[];
}

export interface ClassifyPoolMetrics {
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  tvl: number;
  impact1000Pct: number;
  priceAinB: number;
  donation?: DonationReport | null;
}

export declare function ammGetAmountOut(amountIn: bigint, rIn: bigint, rOut: bigint): bigint;
export declare function sqrtBigInt(y: bigint): bigint;
export declare function calcPriceRatio(reserveA: bigint, reserveB: bigint): PriceRatio;
export declare function calcTvl(reserveA: bigint, reserveB: bigint): number;
export declare function calcReserveRatio(reserveA: bigint, reserveB: bigint): number;
export declare function calcLpValueIndex(reserveA: bigint, reserveB: bigint, totalSupply: bigint): number;
export declare function simulateLiquidityDepth(reserveA: bigint, reserveB: bigint, levels?: number[]): DepthEntry[];
export declare function detectDonations(input: {
  reserveA: bigint;
  reserveB: bigint;
  balanceA: bigint;
  balanceB: bigint;
  blockNumber?: number | null;
  timestamp?: string | null;
}): DonationReport;
export declare function classifyPool(metrics: ClassifyPoolMetrics): PoolClassification;
