import type { RpcClient } from './arc-rpc.mjs';
import type { PriceRatio, DonationReport } from './dex-metrics.mjs';

export declare const DEX_CACHE_TTL_MS: number;

export interface DexSnapshot {
  ammAddress: string;
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  balanceA: bigint;
  balanceB: bigint;
  blockNumber: number;
  timestamp: number;
  lastSuccessfulFetch: number;
  fetchedAt: number;
  tvl: number;
  priceRatio: PriceRatio;
  reserveRatio: number;
  donation: DonationReport;
  source: 'on-chain' | 'cache';
  cacheAge: number;
}

export interface DexCacheOptions {
  rpcClient: RpcClient;
  ammAddress: string | (() => string);
  eurcAddress: string;
  usdcAddress: string;
  ttlMs?: number;
  now?: () => number;
  log?: (fields: Record<string, unknown>) => void;
}

export interface DexCache {
  getSnapshot(): Promise<DexSnapshot>;
  getMinimumLiquidity(): Promise<bigint>;
  invalidate(): void;
  peek(): DexSnapshot | null;
}

export declare function decodeWord(hex: string, wordIdx?: number): bigint;
export declare function createDexCache(options: DexCacheOptions): DexCache;
