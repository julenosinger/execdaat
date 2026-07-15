import type { RpcClient } from './arc-rpc.mjs';

export declare const RESERVE_CACHE_TTL_MS: number;

export interface ReserveSnapshot {
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  blockNumber: number;
  timestamp: number;
  lastSuccessfulFetch: number;
  source: 'on-chain' | 'cache';
  cacheAge: number;
}

export interface ReserveCacheOptions {
  rpcClient: RpcClient;
  ammAddress: string;
  ttlMs?: number;
  now?: () => number;
  log?: (fields: Record<string, unknown>) => void;
}

export interface ReserveCache {
  getReserves(): Promise<ReserveSnapshot>;
  invalidate(): void;
  peek(): ReserveSnapshot | null;
}

export declare function decodeUint256Word(hex: string, wordIdx?: number): bigint;
export declare function createReserveCache(options: ReserveCacheOptions): ReserveCache;
